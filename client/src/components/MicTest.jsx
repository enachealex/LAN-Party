import React, { useEffect, useRef, useState } from 'react'
import { createMicMeter } from '../micLevel'

const RECORD_SECONDS = 5
// If the meter never crosses this in the first few seconds of testing, the mic is almost certainly
// muted in the OS, set to the wrong device, or physically off.
const SIGNAL_THRESHOLD = 0.04
const NO_SIGNAL_AFTER_MS = 4000

/**
 * "Test Microphone": answers the two questions a live meter alone can't.
 *   1. Is anything reaching the browser?  → the live bar plus an explicit no-signal warning.
 *   2. Does it actually sound right?      → record a few seconds and play it straight back.
 *
 * Playback is the part that matters: a bar can move while the audio is clipped, echoing or picking up
 * the wrong device, and only hearing yourself proves the chain end to end.
 *
 * The mic is opened only while testing and released the moment the panel closes or unmounts.
 */
export default function MicTest({ devices = [], selectedDeviceId = null, onSelectDevice }) {
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState(null)
  const [recording, setRecording] = useState(false)
  const [remaining, setRemaining] = useState(RECORD_SECONDS)
  const [clipUrl, setClipUrl] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [sawSignal, setSawSignal] = useState(false)
  const [noSignalWarning, setNoSignalWarning] = useState(false)
  // The parent only knows about devices once a call has enumerated them; in Settings that list is
  // empty. Discover them here after permission is granted — labels are blank before that anyway.
  const [discovered, setDiscovered] = useState([])
  const [localDeviceId, setLocalDeviceId] = useState(null)

  const streamRef = useRef(null)
  const meterRef = useRef(null)     // createMicMeter handle
  const barRef = useRef(null)       // the fill element — written to directly, never via state
  const recorderRef = useRef(null)
  const countdownRef = useRef(null)
  const signalTimerRef = useRef(null)
  const audioRef = useRef(null)
  const sawSignalRef = useRef(false)

  // Release everything on unmount — an open mic left behind shows an active-recording indicator in
  // the OS and is a privacy problem.
  useEffect(() => () => teardown(), [])

  const teardown = () => {
    clearInterval(countdownRef.current)
    clearTimeout(signalTimerRef.current)
    try { meterRef.current?.stop() } catch (_) { /* ignore */ }
    meterRef.current = null
    try { recorderRef.current?.state !== 'inactive' && recorderRef.current.stop() } catch (_) { /* ignore */ }
    recorderRef.current = null
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null }
    if (audioRef.current) { try { audioRef.current.pause() } catch (_) {} }
    if (barRef.current) barRef.current.style.height = '0%'
  }

  const stopTest = () => {
    teardown()
    setTesting(false)
    setRecording(false)
    setNoSignalWarning(false)
  }

  const startTest = () => startTestWith(selectedDeviceId || localDeviceId)

  const startTestWith = async (deviceId) => {
    setError(null)
    setNoSignalWarning(false)
    setSawSignal(false)
    sawSignalRef.current = false
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      })
    } catch (err) {
      setError(err && err.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it for this site, then try again.'
        : 'Could not open the microphone. Check that a device is connected.')
      return
    }
    streamRef.current = stream
    setTesting(true)

    // Now that permission exists, device labels are readable.
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      setDiscovered(all.filter((d) => d.kind === 'audioinput').map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      })))
      const active = stream.getAudioTracks()[0]?.getSettings?.().deviceId
      if (active) setLocalDeviceId(active)
    } catch (_) { /* enumeration blocked — the default device still works */ }

    meterRef.current = createMicMeter(stream, (level) => {
      if (barRef.current) barRef.current.style.height = `${Math.round(level * 100)}%`
      if (level > SIGNAL_THRESHOLD && !sawSignalRef.current) {
        sawSignalRef.current = true
        setSawSignal(true)
        setNoSignalWarning(false)
      }
    })

    // Give them a few seconds of speaking before claiming there's no signal.
    signalTimerRef.current = setTimeout(() => {
      if (!sawSignalRef.current) setNoSignalWarning(true)
    }, NO_SIGNAL_AFTER_MS)
  }

  const record = () => {
    const stream = streamRef.current
    if (!stream || typeof MediaRecorder === 'undefined') { setError('Recording is not supported in this browser.'); return }
    let rec
    try { rec = new MediaRecorder(stream) } catch (_) { setError('Recording is not supported here.'); return }
    recorderRef.current = rec
    const chunks = []
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    rec.onstop = () => {
      clearInterval(countdownRef.current)
      setRecording(false)
      setRemaining(RECORD_SECONDS)
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
      if (!blob.size) return
      // Replace any previous clip and release its blob url.
      setClipUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(blob) })
    }
    rec.start()
    setRecording(true)
    setRemaining(RECORD_SECONDS)
    const started = Date.now()
    countdownRef.current = setInterval(() => {
      const left = RECORD_SECONDS - (Date.now() - started) / 1000
      setRemaining(Math.max(0, left))
      if (left <= 0) { try { rec.state !== 'inactive' && rec.stop() } catch (_) {} }
    }, 100)
  }

  const playBack = () => {
    if (!clipUrl) return
    if (!audioRef.current) audioRef.current = new Audio(clipUrl)
    else audioRef.current.src = clipUrl
    setPlaying(true)
    audioRef.current.onended = () => setPlaying(false)
    audioRef.current.play().catch(() => setPlaying(false))
  }

  const deviceList = devices.length ? devices : discovered
  const activeDeviceId = selectedDeviceId || localDeviceId
  // Changing device mid-test needs the stream reopened on the new one.
  const pickDevice = async (id) => {
    setLocalDeviceId(id)
    onSelectDevice?.(id)
    if (testing) { teardown(); setTesting(false); setTimeout(() => startTestWith(id), 0) }
  }

  return (
    <div className="mictest">
      {deviceList.length > 0 && (
        <div className="profile-edit-row">
          <label className="app-field-label" htmlFor="mictest-device">Input device</label>
          <select
            id="mictest-device"
            className="profile-select"
            value={activeDeviceId || ''}
            onChange={(e) => pickDevice(e.target.value)}
          >
            {deviceList.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Microphone ${i + 1}`}</option>
            ))}
          </select>
        </div>
      )}

      <div className="mictest-row">
        {/* Vertical bar so it reads like a level meter rather than a progress bar. */}
        <div className="mictest-meter" aria-hidden="true">
          <span ref={barRef} className="mictest-meter-fill" />
        </div>

        <div className="mictest-controls">
          {!testing ? (
            <button type="button" className="connect-btn" onClick={startTest}>🎤 Test microphone</button>
          ) : (
            <>
              <div className="mictest-status">
                {recording
                  ? <span className="mictest-rec">● Recording… {remaining.toFixed(1)}s</span>
                  : sawSignal
                    ? <span className="mictest-ok">✓ Mic is picking up sound — say something, then record</span>
                    : <span className="mictest-listening">Listening… speak normally</span>}
              </div>
              <div className="profile-edit-row">
                <button type="button" className="connect-btn" onClick={record} disabled={recording}>
                  {recording ? 'Recording…' : `Record ${RECORD_SECONDS}s`}
                </button>
                {clipUrl && !recording && (
                  <button type="button" className="profile-link-btn" onClick={playBack} disabled={playing}>
                    {playing ? 'Playing…' : '▶ Play it back'}
                  </button>
                )}
                <button type="button" className="profile-link-btn" onClick={stopTest}>Stop test</button>
              </div>
            </>
          )}
        </div>
      </div>

      {noSignalWarning && (
        <div className="composer-error">
          No sound detected. Check that the right input device is selected above, that the mic isn't
          muted in your operating system, and that nothing else has exclusive use of it.
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      <div className="profile-hint">
        Recording plays back only to you — nothing is uploaded or shared. The mic is released when you
        stop the test.
      </div>
    </div>
  )
}
