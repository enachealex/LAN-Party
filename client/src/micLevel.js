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

    const tick = () => {
      if (stopped) return;
      analyser.getByteTimeDomainData(data);
      // RMS of the waveform around the 128 midpoint, scaled so normal speech lands mid-meter.
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 2.4);
      try { onLevel(level, level > 0.06); } catch (_) { /* never let a draw error kill the loop */ }
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
