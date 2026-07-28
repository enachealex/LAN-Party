// Synthesized UI feedback sounds via the Web Audio API — no audio files, no network, works offline
// in the Electron shell, and nothing to license. Cues are kept short + quiet so frequent actions
// (clicks, message sends) add life without grating. Browsers suspend audio until a user gesture, so
// unlockUiSounds() must be called once from within a real click/keydown handler.

let ctx = null
let master = null
let enabled = true
let volume = 0.5 // 0..1 master gain

function ensureCtx() {
  if (ctx) return ctx
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  ctx = new AC()
  master = ctx.createGain()
  master.gain.value = volume
  master.connect(ctx.destination)
  return ctx
}

/** Update the enabled flag and/or master volume (from the user's saved settings). */
export function setUiSoundPrefs({ enabled: e, volume: v } = {}) {
  if (typeof e === 'boolean') enabled = e
  if (typeof v === 'number' && isFinite(v)) {
    volume = Math.max(0, Math.min(1, v))
    if (master) master.gain.value = volume
  }
}

export function getUiSoundPrefs() { return { enabled, volume } }

/** Resume the AudioContext — call from the first user gesture so later cues can play. Idempotent. */
export function unlockUiSounds() {
  const c = ensureCtx()
  if (c && c.state === 'suspended') c.resume().catch(() => {})
}

// A single tone with a click-free (exponential) attack/decay envelope, optionally gliding in pitch.
function tone(c, { freq, start, dur, type = 'sine', gain = 0.2, glideTo = null }) {
  const osc = c.createOscillator()
  const g = c.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur)
  g.gain.setValueAtTime(0.0001, start)
  g.gain.exponentialRampToValueAtTime(gain, start + 0.008)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g)
  g.connect(master)
  osc.start(start)
  osc.stop(start + dur + 0.03)
}

// The palette. Each entry lays out a short sequence relative to the start time `t`.
const SOUNDS = {
  tap:        (c, t) => tone(c, { freq: 660, start: t, dur: 0.05, type: 'triangle', gain: 0.06 }),
  send:       (c, t) => tone(c, { freq: 520, start: t, dur: 0.10, type: 'sine', gain: 0.16, glideTo: 900 }),
  receive:    (c, t) => { tone(c, { freq: 740, start: t, dur: 0.08, type: 'sine', gain: 0.12 }); tone(c, { freq: 990, start: t + 0.06, dur: 0.10, type: 'sine', gain: 0.10 }) },
  notify:     (c, t) => { tone(c, { freq: 880, start: t, dur: 0.11, type: 'sine', gain: 0.16 }); tone(c, { freq: 1320, start: t + 0.10, dur: 0.16, type: 'sine', gain: 0.14 }) },
  joinVoice:  (c, t) => { tone(c, { freq: 523, start: t, dur: 0.12, type: 'triangle', gain: 0.16 }); tone(c, { freq: 784, start: t + 0.10, dur: 0.18, type: 'triangle', gain: 0.16 }) },
  leaveVoice: (c, t) => { tone(c, { freq: 784, start: t, dur: 0.12, type: 'triangle', gain: 0.16 }); tone(c, { freq: 523, start: t + 0.10, dur: 0.18, type: 'triangle', gain: 0.14 }) },
  peerJoin:   (c, t) => tone(c, { freq: 500, start: t, dur: 0.16, type: 'sine', gain: 0.15, glideTo: 1000 }), // someone else joined the call
  peerLeave:  (c, t) => tone(c, { freq: 1000, start: t, dur: 0.16, type: 'sine', gain: 0.13, glideTo: 500 }),
  mute:       (c, t) => tone(c, { freq: 420, start: t, dur: 0.09, type: 'sine', gain: 0.14, glideTo: 240 }),
  unmute:     (c, t) => tone(c, { freq: 500, start: t, dur: 0.09, type: 'sine', gain: 0.14, glideTo: 760 }),
  success:    (c, t) => [523, 659, 784].forEach((f, i) => tone(c, { freq: f, start: t + i * 0.07, dur: 0.14, type: 'triangle', gain: 0.14 })),
  error:      (c, t) => tone(c, { freq: 300, start: t, dur: 0.18, type: 'sawtooth', gain: 0.12, glideTo: 170 }),
  toggle:     (c, t) => tone(c, { freq: 620, start: t, dur: 0.05, type: 'square', gain: 0.07 }),
}

/**
 * Play a recorded audio file (e.g. someone's voice-chat entrance clip) through the same enable
 * toggle + volume as the synthesized cues. Uses an <audio> element rather than the oscillator graph
 * because the source is a real file. Never throws.
 */
export function playUiClip(url) {
  if (!enabled || !url) return
  try {
    const el = new Audio(url)
    el.volume = volume
    el.play().catch(() => { /* autoplay blocked until the user interacts — fine */ })
  } catch (_) { /* unsupported */ }
}

/** Play a named cue. No-ops when disabled, unsupported, or the name is unknown. Never throws. */
export function playUiSound(name) {
  if (!enabled) return
  const c = ensureCtx()
  if (!c) return
  if (c.state === 'suspended') c.resume().catch(() => {}) // best effort if not yet unlocked
  const fn = SOUNDS[name]
  if (!fn) return
  try { fn(c, c.currentTime + 0.001) } catch (_) { /* audio graph hiccup — ignore */ }
}
