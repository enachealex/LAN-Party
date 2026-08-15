// Live microphone level measurement, shared by the pre-join meter, the in-call mic button and the
// Test Microphone panel.
//
// The pre-existing meter wrote straight into one hard-coded element, so it could only ever drive a
// single indicator. This hands the level to a callback instead, letting several indicators run at
// once off different streams.
//
// Analysis is entirely local — nothing is transmitted, recorded or persisted.
//
// The callback is invoked ~25x a second, so callers MUST write to the DOM directly (element.style /
// setProperty) rather than through React state; that many setState calls in a component this size
// would be a visible stall.
//
// Driven by setInterval rather than requestAnimationFrame on purpose. rAF is paused whenever the page
// isn't compositing — a background tab, a minimised window, some embedded webviews — which would
// silently freeze the meter at zero and make a working mic look dead. That is precisely the moment a
// "is my mic working?" indicator must not lie. 25Hz is plenty smooth for a level bar and costs little.

// Level mapping. A raw RMS is a poor meter: hearing is roughly logarithmic, and speech RMS sits down
// around 0.02-0.2, so a linear scale leaves the bar barely twitching until you shout. Mapping dBFS
// across a speech-shaped window instead means a normal talking voice lands mid-meter on most mics.
const DB_FLOOR = -60; // below this reads as silence
const DB_CEIL = -6;   // at/above this the meter is pinned (near clipping)

/**
 * Convert a 0..1 RMS into a 0..1 meter position via dBFS.
 * Exported so the curve can be checked against known amplitudes rather than eyeballed.
 * @param {number} rms
 * @returns {number} 0..1
 */
export function levelFromRms(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  if (db <= DB_FLOOR) return 0;
  if (db >= DB_CEIL) return 1;
  return (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
}

/**
 * Attach an analyser to a live mic stream.
 * @param {MediaStream} stream
 * @param {(level: number, speaking: boolean) => void} onLevel level is 0..1
 * @returns {{ stop: () => void }} always safe to call, even if setup failed
 */
export function createMicMeter(stream, onLevel) {
  const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
  if (!AC || !stream || !stream.getAudioTracks().length) return { stop() {} };

  let ctx = null;
  let src = null;
  let timerId = 0;
  let stopped = false;

  try {
    ctx = new AC();
    // Autoplay policies can leave a fresh context suspended until a gesture; resuming is harmless if
    // it's already running.
    if (ctx.resume) ctx.resume().catch(() => {});
    src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    // Deliberately NOT connected to ctx.destination — routing the mic to the speakers would howl.
    const data = new Uint8Array(analyser.frequencyBinCount);

    // Meter ballistics: jump to a new peak immediately so a consonant registers, then fall away
    // smoothly. Without this the bar strobes on every frame and is hard to read.
    let shown = 0;
    const ATTACK = 0.6;  // fraction of the gap closed per tick when rising
    const DECAY = 0.12;  // …and when falling

    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(data);
      // RMS of the waveform around the 128 midpoint.
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const target = levelFromRms(rms);
      shown += (target - shown) * (target > shown ? ATTACK : DECAY);
      const level = Math.max(0, Math.min(1, shown));
      // 'speaking' keys off the instantaneous value, not the decaying bar, so it doesn't linger.
      try { onLevel(level, target > 0.18); } catch (_) { /* never let a draw error kill the loop */ }
    };
    timerId = setInterval(tick, 40); // ~25Hz
  } catch (_) {
    // Unsupported or blocked: report silence once so the UI can show a resting state.
    try { onLevel(0, false); } catch (_) { /* ignore */ }
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timerId);
      try { src && src.disconnect(); } catch (_) { /* already gone */ }
      try { ctx && ctx.close(); } catch (_) { /* already closed */ }
      try { onLevel(0, false); } catch (_) { /* ignore */ }
    },
  };
}
