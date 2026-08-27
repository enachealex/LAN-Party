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

// The segmentation model is served from OUR origin first. It used to be fetched from a public CDN on
// demand, which meant ~6MB of wasm + model arrived only when you switched blur on: measured 2.9s to
// the first result on a good connection, and on a LAN with no internet — the situation this app is
// built for — it never arrived at all, so blur silently drew the raw camera forever.
//
// The CDN stays as a fallback, but PINNED. It was previously an unversioned url, so jsdelivr served
// whatever was newest; a dependency that can change under you without a deploy is exactly how
// something that worked stops working on its own.
const MP_VERSION = '0.1.1675465747'
const MP_CDN_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@${MP_VERSION}`
const MP_LOCAL_BASE = (typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.BASE_URL : '/') + 'vendor/selfie-segmentation'

let mpLoader = null
// Which base actually worked, so locateFile() fetches the wasm/model from the same place as the script
// rather than mixing a local loader with CDN assets.
let mpBase = MP_LOCAL_BASE

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.crossOrigin = 'anonymous'
    el.async = true
    el.onload = () => (window.SelfieSegmentation ? resolve() : reject(new Error('SelfieSegmentation missing after load')))
    el.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(el)
  })
}

function loadMediaPipe() {
  if (typeof window !== 'undefined' && window.SelfieSegmentation) return Promise.resolve(window.SelfieSegmentation)
  if (mpLoader) return mpLoader
  mpLoader = (async () => {
    try {
      await loadScript(`${MP_LOCAL_BASE}/selfie_segmentation.js`)
      mpBase = MP_LOCAL_BASE
    } catch (localErr) {
      // Self-hosted copy missing (e.g. an older deploy) — fall back rather than losing effects entirely.
      console.warn('[effects] local segmentation assets unavailable, falling back to CDN:', localErr.message)
      await loadScript(`${MP_CDN_BASE}/selfie_segmentation.js`)
      mpBase = MP_CDN_BASE
    }
    return window.SelfieSegmentation
  })().catch((err) => { mpLoader = null; throw err })
  return mpLoader
}

/** Where the model/wasm are being served from — surfaced for diagnostics. */
export function effectsAssetBase() { return mpBase }

/**
 * Download and initialise the segmentation model ahead of time. Called when the effects menu opens so
 * that switching blur on is instant instead of showing raw camera for the first few seconds.
 * @returns {Promise<boolean>} true once the model is ready
 */
export async function warmUpEffects() {
  try { await loadMediaPipe(); return true } catch (_) { return false }
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
    this.recoverMs = 4000        // …and if it stays stalled this long, rebuild the segmenter
    this.maxRecoveries = 3       // then give up and say so, rather than thrashing forever
    this.video = null
    this.canvas = null
    this.ctx = null
    this.segmenter = null
    this.width = 1280
    this.height = 720
    this.rawTrack = null
    this.outputTrack = null
    // 'idle' | 'loading' | 'active' | 'unavailable'. Reported so the UI can say "preparing blur"
    // instead of showing an unblurred camera and leaving the user to guess.
    this.status = 'idle'
    this.onStatus = null
    this.lastError = null
    this._recovering = false
    this._recoveries = 0
  }

  _setStatus(status, error) {
    if (this.status === status && !error) return
    this.status = status
    this.lastError = error || null
    try { this.onStatus?.(status, error || null) } catch (_) { /* never let a listener break the loop */ }
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
    if (this._needsSegmentation()) {
      this._setStatus('loading')
      try {
        await this._ensureSegmenter()
        // 'active' is only claimed once a real result lands (see _onSeg) — the model being constructed
        // is not the same as it producing masks.
      } catch (e) {
        // Previously swallowed, which is why a broken model looked like "blur just does nothing".
        this._setStatus('unavailable', e && e.message ? e.message : 'Could not load the background model')
      }
    } else {
      this._setStatus('idle')
    }
  }

  async _ensureSegmenter() {
    if (this.segmenter) return
    const SelfieSegmentation = await loadMediaPipe()
    this.segmenter = new SelfieSegmentation({ locateFile: (f) => `${mpBase}/${f}` })
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
        // A stall that lasts is not a hiccup. Rebuild the segmenter once rather than quietly showing an
        // unblurred camera for the rest of the call — that is the failure the user actually sees.
        if (this.lastResult > 0 && now - this.lastResult > this.recoverMs) this._recoverSegmenter()
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
  // Tear the segmenter down and build a fresh one. MediaPipe can wedge (a lost GL context, a killed
  // worker); when it does, every later send() resolves without ever calling onResults, so the pipeline
  // looks alive while quietly producing nothing.
  async _recoverSegmenter() {
    if (this._recovering || !this.running) return
    if (this._recoveries >= this.maxRecoveries) {
      this._setStatus('unavailable', 'Background effects stopped responding on this device')
      return
    }
    this._recovering = true
    this._recoveries += 1
    this._setStatus('loading')
    try {
      try { this.segmenter?.close?.() } catch (_) { /* already gone */ }
      this.segmenter = null
      await this._ensureSegmenter()
      this.lastResult = performance.now() // give the rebuilt one a fresh grace period
    } catch (e) {
      this._setStatus('unavailable', e && e.message ? e.message : 'Could not restart background effects')
    } finally {
      this._recovering = false
    }
  }

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
    this._recoveries = 0        // a working result clears the recovery budget
    this._setStatus('active')   // masks are arriving — the effect is genuinely on screen now
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
