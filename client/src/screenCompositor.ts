// Screen share with your webcam in it: the shared screen with the camera drawn into a corner, sent as
// ONE video track. Everyone in the call sees the camera where the sharer put it, so moving it is
// seen by all without anything else being sent, and the call server, the direct connections and
// the viewers need nothing new.
//
// Frames come in through MediaStreamTrackProcessor and go out through MediaStreamTrackGenerator
// (Chromium: the Windows app, Chrome, Edge). The work is driven by arriving frames, not by a timer or
// requestAnimationFrame, which a browser slows down or stops for a tab in the background, and the
// sharer is usually looking at the game, not at LAN Party. Where these are missing, the caller
// shares the screen alone, as before.
//
// A shared screen only produces frames when something on it changes, so a frame is also drawn
// whenever the camera has a new one (capped at CAMERA_FPS), using the last screen frame. Otherwise a
// still screen would freeze the camera too.

/** Where the camera sits: 0..1 across the free space, so 1,1 is the bottom-right corner. */
export type PipPosition = { x: number; y: number }

export const DEFAULT_PIP: PipPosition = { x: 1, y: 1 }
/** The camera's width as a fraction of the shared screen's width. */
export const PIP_WIDTH = 0.22
/** Space kept between the camera and the screen's edge, as a fraction of its width. */
export const PIP_MARGIN = 0.02
const CAMERA_FPS = 30

type FrameLike = VideoFrame
interface TrackProcessorCtor { new (init: { track: MediaStreamTrack }): { readable: ReadableStream<FrameLike> } }
interface TrackGeneratorCtor { new (init: { kind: 'video' }): MediaStreamTrack & { writable: WritableStream<FrameLike> } }

const processorCtor = (): TrackProcessorCtor | null =>
  (globalThis as unknown as { MediaStreamTrackProcessor?: TrackProcessorCtor }).MediaStreamTrackProcessor || null
const generatorCtor = (): TrackGeneratorCtor | null =>
  (globalThis as unknown as { MediaStreamTrackGenerator?: TrackGeneratorCtor }).MediaStreamTrackGenerator || null

export function compositingSupported(): boolean {
  return !!(processorCtor() && generatorCtor() && typeof VideoFrame !== 'undefined')
}

export const clampPip = (p: Partial<PipPosition> | null | undefined): PipPosition => {
  const c = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d)
  return { x: c(p?.x, DEFAULT_PIP.x), y: c(p?.y, DEFAULT_PIP.y) }
}

/**
 * The camera's rectangle on a screen of `w` x `h`, for a camera of aspect `camAspect`. The same
 * sums place the drag handle over the picture on the sharer's own tile.
 */
export function pipRect(w: number, h: number, camAspect: number, pos: PipPosition) {
  const pw = Math.round(w * PIP_WIDTH)
  const ph = Math.round(pw / (camAspect > 0 ? camAspect : 16 / 9))
  const m = Math.round(w * PIP_MARGIN)
  const x = m + Math.round(Math.max(0, w - pw - 2 * m) * pos.x)
  const y = m + Math.round(Math.max(0, h - ph - 2 * m) * pos.y)
  return { x, y, w: pw, h: ph }
}

export class ScreenCompositor {
  readonly output: MediaStreamTrack
  private writer: WritableStreamDefaultWriter<FrameLike>
  private canvas: OffscreenCanvas | HTMLCanvasElement
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  private screenFrame: FrameLike | null = null
  private camFrame: FrameLike | null = null
  private camReader: ReadableStreamDefaultReader<FrameLike> | null = null
  private screenReader: ReadableStreamDefaultReader<FrameLike>
  private pos: PipPosition = DEFAULT_PIP
  private lastCamDraw = 0
  private writing = false
  private stopped = false

  constructor(screen: MediaStreamTrack) {
    const Processor = processorCtor()
    const Generator = generatorCtor()
    if (!Processor || !Generator) throw new Error('Video compositing is not supported here')
    const gen = new Generator({ kind: 'video' })
    try { gen.contentHint = 'detail' } catch { /* older browser */ }
    this.output = gen
    this.writer = gen.writable.getWriter()
    this.canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1280, 720) : document.createElement('canvas')
    const ctx = this.canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
    if (!ctx) throw new Error('No 2D canvas')
    this.ctx = ctx
    this.screenReader = new Processor({ track: screen }).readable.getReader()
    this.pump(this.screenReader, (f) => { this.replace('screen', f); this.draw() })
  }

  setPosition(pos: PipPosition) {
    this.pos = clampPip(pos)
    this.draw()
  }

  /** The camera to draw in, or null for the screen alone. */
  setCamera(track: MediaStreamTrack | null) {
    if (this.camReader) { this.camReader.cancel().catch(() => {}); this.camReader = null }
    this.replace('cam', null)
    if (!track || this.stopped) { this.draw(); return }
    const Processor = processorCtor()
    if (!Processor) return
    // A clone, so the processor never holds on to (or ends) the camera's own track.
    const reader = new Processor({ track: track.clone() }).readable.getReader()
    this.camReader = reader
    this.pump(reader, (f) => {
      if (this.camReader !== reader) { f.close(); return }
      this.replace('cam', f)
      const now = performance.now()
      if (now - this.lastCamDraw >= 1000 / CAMERA_FPS) { this.lastCamDraw = now; this.draw() }
    })
  }

  stop() {
    if (this.stopped) return
    this.stopped = true
    this.screenReader.cancel().catch(() => {})
    if (this.camReader) this.camReader.cancel().catch(() => {})
    this.replace('screen', null)
    this.replace('cam', null)
    this.writer.close().catch(() => {})
    try { this.output.stop() } catch { /* already ended */ }
  }

  private async pump(reader: ReadableStreamDefaultReader<FrameLike>, onFrame: (f: FrameLike) => void) {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done || !value) return
        if (this.stopped) { value.close(); return }
        onFrame(value)
      }
    } catch { /* cancelled, or the source ended */ }
  }

  private replace(which: 'screen' | 'cam', frame: FrameLike | null) {
    const old = which === 'screen' ? this.screenFrame : this.camFrame
    if (old && old !== frame) { try { old.close() } catch { /* already closed */ } }
    if (which === 'screen') this.screenFrame = frame
    else this.camFrame = frame
  }

  private draw() {
    const screen = this.screenFrame
    // One frame on its way out at a time: a slow encoder drops frames instead of queueing them up.
    if (this.stopped || !screen || this.writing) return
    const w = screen.displayWidth
    const h = screen.displayHeight
    if (!w || !h) return
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h }
    const ctx = this.ctx
    ctx.drawImage(screen, 0, 0, w, h)
    const cam = this.camFrame
    if (cam && cam.displayWidth && cam.displayHeight) {
      const r = pipRect(w, h, cam.displayWidth / cam.displayHeight, this.pos)
      const radius = Math.round(r.w * 0.06)
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,.45)'
      ctx.shadowBlur = Math.round(r.w * 0.04)
      ctx.beginPath()
      roundRect(ctx, r.x, r.y, r.w, r.h, radius)
      ctx.fillStyle = '#000'
      ctx.fill()
      ctx.restore()
      ctx.save()
      ctx.beginPath()
      roundRect(ctx, r.x, r.y, r.w, r.h, radius)
      ctx.clip()
      ctx.drawImage(cam, r.x, r.y, r.w, r.h)
      ctx.restore()
      ctx.save()
      ctx.beginPath()
      roundRect(ctx, r.x, r.y, r.w, r.h, radius)
      ctx.lineWidth = Math.max(2, Math.round(w * 0.002))
      ctx.strokeStyle = 'rgba(255,255,255,.55)'
      ctx.stroke()
      ctx.restore()
    }
    let frame: FrameLike
    try {
      // Our own clock, always increasing: a frame drawn for a new camera frame reuses the last screen
      // frame, and an encoder may drop frames whose timestamp did not move on.
      frame = new VideoFrame(this.canvas as unknown as CanvasImageSource, { timestamp: Math.round(performance.now() * 1000) })
    } catch { return }
    this.writing = true
    // The generator takes the frame and closes it.
    this.writer.write(frame).catch(() => { try { frame.close() } catch { /* closed */ } }).finally(() => { this.writing = false })
  }
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
