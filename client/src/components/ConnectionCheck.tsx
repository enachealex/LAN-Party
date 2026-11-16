import { useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { describeConnection, measureConnection } from '../connectionCheck'
import type { CheckReport, ServerDiagnostics } from '../connectionCheck'

const MARK = { pass: '✓', fail: '✕', skip: '–' } as const

interface Props {
  socket: Socket | null
  /** GET /webrtc/diagnostics with the caller's sign-in; null when it cannot be had. */
  getDiagnostics: () => Promise<ServerDiagnostics | null>
  /** The ICE servers a call would use (with this account's relay credential), for the relay test. */
  getIceServers?: () => Promise<RTCIceServer[] | null>
  /** 'link' sits under the pre-join microphone test; 'button' is the Settings section. */
  variant?: 'button' | 'link'
}

/**
 * "Check connection": sits beside the microphone test and answers the other half of "will my call
 * work?" — not whether the mic is heard, but whether this network can carry a call at all, and by
 * which route. Runs without joining a room, opens no device and plays nothing.
 */
export default function ConnectionCheck({ socket, getDiagnostics, getIceServers, variant = 'button' }: Props) {
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<CheckReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A check takes a few seconds; the panel it lives in can be closed before it ends.
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const run = async () => {
    if (running) return
    setError(null)
    if (!socket || !socket.connected) { setError('Not connected to the server right now. Try again in a moment.'); return }
    setRunning(true)
    try {
      const found = await measureConnection(socket, getDiagnostics, getIceServers)
      if (alive.current) setReport(describeConnection(found))
    } catch (_) {
      if (alive.current) setError('The check could not be completed.')
    } finally {
      if (alive.current) setRunning(false)
    }
  }

  return (
    <div className="conncheck">
      <button type="button" className={variant === 'link' ? 'profile-link-btn' : 'connect-btn mictest-start'} onClick={run} disabled={running}>
        {running ? 'Checking connection…' : report ? 'Check connection again' : 'Check connection'}
      </button>
      {running && <div className="conncheck-hint">This takes a few seconds. Nothing is recorded or played.</div>}
      {error && <div className="composer-error">{error}</div>}
      {report && !running && (
        <div className="conncheck-report" role="status">
          <div className="conncheck-summary">{report.summary}</div>
          <ul className="conncheck-lines">
            {report.lines.map((line) => (
              <li key={line.id} className={`conncheck-line ${line.status}`}>
                <span className="conncheck-mark" aria-hidden="true">{MARK[line.status]}</span>
                <span className="conncheck-text">
                  <span className="conncheck-label">{line.label}<span className="conncheck-sr"> — {line.status === 'pass' ? 'passed' : line.status === 'fail' ? 'failed' : 'not tested'}</span></span>
                  <span className="conncheck-detail">{line.text}</span>
                </span>
              </li>
            ))}
          </ul>
          {report.notes.map((note) => <div key={note} className="conncheck-note">{note}</div>)}
        </div>
      )}
    </div>
  )
}
