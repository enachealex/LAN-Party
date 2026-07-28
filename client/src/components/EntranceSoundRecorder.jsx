import React, { useEffect, useRef, useState } from 'react'

const MAX_SECONDS = 5

// Records a short "walk-on" clip with the mic and hands the blob to the caller for upload. Everyone
// else in a voice channel hears it when you join. Recording auto-stops at MAX_SECONDS so clips stay
// short (and inside the server's 2 MB cap).
export default function EntranceSoundRecorder({ url, onRecorded, onRemove, resolveSrc = (u) => u, busy = false }) {
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(null)
  const [playing, setPlaying] = useState(false)
  const recorderRef = useRef(null)
  const streamRef = useRef(null)
  const timerRef = useRef(null)
  const audioRef = useRef(null)

  // Always release the mic + timer, however this unmounts.
  useEffect(() => () => { stopTracks(); clearInterval(timerRef.current) }, [])

  const stopTracks = () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null }
  }

  const start = async () => {
    setError(null)
    if (typeof MediaRecorder === 'undefined') { setError('Recording is not supported in this browser.'); return }
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (_) {
      setError('Microphone access denied.')
      return
    }
    streamRef.current = stream
    // Let the browser pick a container it can actually produce (Chrome/Electron: webm/opus).
    let rec
    try { rec = new MediaRecorder(stream) } catch (_) { stopTracks(); setError('Recording is not supported here.'); return }
    recorderRef.current = rec
    const chunks = []
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data) }
    rec.onstop = () => {
      clearInterval(timerRef.current)
      stopTracks()
      setRecording(false)
      setElapsed(0)
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
      if (blob.size) onRecorded?.(blob)
    }
    rec.start()
    setRecording(true)
    setElapsed(0)
    const started = Date.now()
    timerRef.current = setInterval(() => {
      const secs = (Date.now() - started) / 1000
      setElapsed(secs)
      if (secs >= MAX_SECONDS) stop()
    }, 100)
  }

  const stop = () => {
    clearInterval(timerRef.current)
    const rec = recorderRef.current
    if (rec && rec.state !== 'inactive') rec.stop()
    else { stopTracks(); setRecording(false) }
  }

  const preview = () => {
    if (!url) return
    if (!audioRef.current) audioRef.current = new Audio(resolveSrc(url))
    else audioRef.current.src = resolveSrc(url)
    setPlaying(true)
    audioRef.current.onended = () => setPlaying(false)
    audioRef.current.play().catch(() => setPlaying(false))
  }

  const remaining = Math.max(0, MAX_SECONDS - elapsed).toFixed(1)

  return (
    <div className="entrance-recorder">
      <div className="profile-edit-row">
        {recording ? (
          <button type="button" className="connect-btn entrance-stop" onClick={stop}>
            ● Stop ({remaining}s)
          </button>
        ) : (
          <button type="button" className="connect-btn" onClick={start} disabled={busy}>
            {url ? '🎙 Re-record' : '🎙 Record a clip'}
          </button>
        )}
        {url && !recording && (
          <>
            <button type="button" className="profile-link-btn" onClick={preview} disabled={playing}>
              {playing ? 'Playing…' : '▶ Preview'}
            </button>
            <button type="button" className="profile-link-btn" onClick={onRemove} disabled={busy}>Remove</button>
          </>
        )}
        {busy && <span className="entrance-status">Saving…</span>}
      </div>
      {recording && (
        <div className="entrance-recording-bar" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (elapsed / MAX_SECONDS) * 100)}%` }} />
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      <div className="profile-hint">
        {url
          ? 'Others hear this when you join a voice channel. Keep it short and friendly.'
          : `Record up to ${MAX_SECONDS} seconds — it plays for everyone else in the channel when you join voice.`}
      </div>
    </div>
  )
}
