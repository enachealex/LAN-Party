// Webcam effects pipeline: background blur, background covers, and "hide me" (cover the whole
// frame with a background so the person is not shown), via MediaPipe Selfie Segmentation.
//
// Design (Teams/Zoom-style): the camera ALWAYS flows through one canvas whose captureStream() is a
// STABLE output track. Changing the effect or switching cameras only changes what the canvas draws
// (or its source) — the output track never changes identity, so it's added to peers exactly once
// and never triggers a renegotiation. That eliminates the freeze that track-swapping caused and
// keeps remote video stable. A stall watchdog falls back to the raw camera if segmentation hangs,
// so the video can never freeze.
//
// Effects are extensible: an effect is a descriptor + a draw branch.
//   { kind: 'none' }                     passthrough
//   { kind: 'blur', blurPx }             person sharp, background blurred
//   { kind: 'gradient', colors }         person over a gradient background
//   { kind: 'image', url }               person over an image background
//   { kind: 'hide', colors|url }         cover the whole frame (person hidden)

const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation'
let mpLoader = null

function loadMediaPipe() {
  if (typeof window !== 'undefined' && window.SelfieSegmentation) return Promise.resolve(window.SelfieSegmentation)
  if (mpLoader) return mpLoader
  mpLoader = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = `${MP_BASE}/selfie_segmentation.js`
    s.crossOrigin = 'anonymous'
    s.async = true
    s.onload = () => (window.SelfieSegmentation ? resolve(window.SelfieSegmentation) : reject(new Error('SelfieSegmentation missing after load')))
    s.onerror = () => { mpLoader = null; reject(new Error('Failed to load MediaPipe Selfie Segmentation')) }
    document.head.appendChild(s)
  })
  return mpLoader
}

// True when the browser can turn a canvas back into a MediaStreamTrack. Required for effects.
export function effectsSupported() {
  if (typeof document === 'undefined') return false
  const c = document.createElement('canvas')
  return typeof c.captureStream === 'function'
}

export class WebcamEffectProcessor {
  constructor() {
    this.desc = { kind: 'none' }
    this.bgImage = null
    this.bgImageUrl = null
    this.gradientCache = { key: null, grad: null }
    this.running = false
    this.rafId = null
    this.lastSeg = 0
    this.lastResult = 0
    this.segInterval = 1000 / 24 // throttle segmentation to ~24fps to spare CPU
    this.stallMs = 500           // if no segmentation result for this long, show raw (never freeze)
    this.video = null
    this.canvas = null
    this.ctx = null
    this.segmenter = null
    this.width = 1280
    this.height = 720
    this.rawTrack = null
    this.outputTrack = null
  }

  get isRunning() { return this.running }

  _needsSegmentation() {
    const k = this.desc.kind
    return k === 'blur' || k === 'gradient' || k === 'image'
  }

  // Change the active effect. The output track is unaffected — only the drawing changes.
  async applyEffect(desc) {
    const next = desc || { kind: 'none' }
    if ((next.kind === 'image' || next.kind === 'hide') && next.url) {
      if (next.url !== this.bgImageUrl) await this._loadBgImage(next.url)
    } else {
      this.bgImage = null
      this.bgImageUrl = null
    }
    this.desc = next
    if (this._needsSegmentation()) { try { await this._ensureSegmenter() } catch (e) { /* falls back to raw */ } }
  }

  async _ensureSegmenter() {
    if (this.segmenter) return
    const SelfieSegmentation = await loadMediaPipe()
    this.segmenter = new SelfieSegmentation({ locateFile: (f) => `${MP_BASE}/${f}` })
    this.segmenter.setOptions({ modelSelection: 1, selfieMode: false })
    this.segmenter.onResults((r) => this._onSeg(r))
  }

  async _loadBgImage(url) {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = () => rej(new Error('background image failed to load'))
      img.src = url
    })
    this.bgImage = img
    this.bgImageUrl = url
  }

  // Point the hidden <video> at a (new) raw camera track. Reused for both first start and for
  // switching cameras mid-session — the output track is never touched.
  _setupVideo(rawTrack) {
    const s = rawTrack.getSettings ? rawTrack.getSettings() : {}
    this.width = s.width || 1280
    this.height = s.height || 720
    this.rawTrack = rawTrack
    if (!this.video) {
      this.video = document.createElement('video')
      this.video.autoplay = true
      this.video.muted = true
      this.video.playsInline = true
    }
    this.video.srcObject = new MediaStream([rawTrack])
    this.video.play().catch(() => {})
    if (this.canvas && (this.canvas.width !== this.width || this.canvas.height !== this.height)) {
      this.canvas.width = this.width
      this.canvas.height = this.height
    }
  }

  // Begin the pipeline; resolves with the STABLE processed MediaStreamTrack.
  async start(rawTrack, desc) {
    await this.applyEffect(desc || { kind: 'none' })
    this.canvas = document.createElement('canvas')
    this._setupVideo(rawTrack)
    this.canvas.width = this.width
    this.canvas.height = this.height
    this.ctx = this.canvas.getContext('2d')
    this.running = true
    this.lastResult = 0
    this._loop()
    const out = this.canvas.captureStream(30)
    this.outputTrack = out.getVideoTracks()[0]
    return this.outputTrack
  }

  // Switch the camera source without changing the output track (no renegotiation, no freeze).
  setCameraTrack(rawTrack) {
    if (!rawTrack) return
    this._setupVideo(rawTrack)
  }

  _loop = () => {
    if (!this.running) return
    const v = this.video
    if (v && v.readyState >= 2 && this.canvas) {
      if (this._needsSegmentation() && this.segmenter) {
        const now = performance.now()
        if (now - this.lastSeg >= this.segInterval) {
          this.lastSeg = now
          this.segmenter.send({ image: v }).catch(() => {})
        }
        // Watchdog: if results stall (or haven't arrived yet), show the raw camera so we never freeze.
        if (now - this.lastResult > this.stallMs) this._drawSimple()
      } else {
        this._drawSimple()
      }
    }
    // requestAnimationFrame is PAUSED while the window/tab is hidden, which would freeze the camera
    // for everyone until you come back. Fall back to a timer when hidden so the feed keeps flowing —
    // full-rate in the desktop app (backgroundThrottling:false), reduced-rate in a hidden browser tab.
    if (typeof document !== 'undefined' && document.hidden) {
      this.rafId = null
      this._hiddenTimer = setTimeout(this._loop, 1000 / 15)
    } else {
      this._hiddenTimer = null
      this.rafId = requestAnimationFrame(this._loop)
    }
  }

  // Non-segmentation draw: 'hide' → fill the frame with the background; otherwise raw passthrough.
  _drawSimple() {
    const ctx = this.ctx
    if (!ctx) return
    const w = this.canvas.width, h = this.canvas.height
    ctx.filter = 'none'
    ctx.globalCompositeOperation = 'source-over'
    if (this.desc.kind === 'hide') { this._fillBackground(ctx, w, h); return }
    ctx.drawImage(this.video, 0, 0, w, h)
  }

  // Segmentation composite: keep the person, replace/blur the background behind them.
  _onSeg(results) {
    if (!this.ctx || !this._needsSegmentation()) return
    this.lastResult = performance.now()
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    ctx.save()
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(results.segmentationMask, 0, 0, w, h)
    ctx.globalCompositeOperation = 'source-in'
    ctx.drawImage(results.image, 0, 0, w, h)
    ctx.globalCompositeOperation = 'destination-over'
    if (this.desc.kind === 'blur') {
      ctx.filter = `blur(${this.desc.blurPx || 8}px)`
      ctx.drawImage(results.image, 0, 0, w, h)
      ctx.filter = 'none'
    } else {
      this._fillBackground(ctx, w, h)
    }
    ctx.restore()
  }

  // Fill the whole canvas with the chosen background (image cover or gradient).
  _fillBackground(ctx, w, h) {
    if (this.bgImage) { this._drawCover(ctx, this.bgImage, w, h); return }
    ctx.fillStyle = this._gradient(ctx, this.desc.colors, w, h)
    ctx.fillRect(0, 0, w, h)
  }

  _gradient(ctx, colors, w, h) {
    const key = (colors || []).join('|')
    if (this.gradientCache.key === key && this.gradientCache.grad) return this.gradientCache.grad
    const g = ctx.createLinearGradient(0, 0, w, h)
    const cs = colors && colors.length ? colors : ['#232526', '#414345']
    cs.forEach((c, i) => g.addColorStop(cs.length === 1 ? 0 : i / (cs.length - 1), c))
    this.gradientCache = { key, grad: g }
    return g
  }

  // Cover-fit (crop to fill) a background image onto the canvas.
  _drawCover(ctx, img, w, h) {
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    if (!iw || !ih) return
    const ir = iw / ih
    const cr = w / h
    let dw, dh, dx, dy
    if (ir > cr) { dh = h; dw = h * ir; dx = (w - dw) / 2; dy = 0 }
    else { dw = w; dh = w / ir; dx = 0; dy = (h - dh) / 2 }
    ctx.drawImage(img, dx, dy, dw, dh)
  }

  stop() {
    this.running = false
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = null
    if (this._hiddenTimer) { clearTimeout(this._hiddenTimer); this._hiddenTimer = null }
    try { this.segmenter && this.segmenter.close() } catch (e) { /* ignore */ }
    this.segmenter = null
    if (this.video) { try { this.video.pause() } catch (e) {} this.video.srcObject = null; this.video = null }
    this.canvas = null
    this.ctx = null
    this.rawTrack = null
    this.outputTrack = null
    this.gradientCache = { key: null, grad: null }
  }
}
