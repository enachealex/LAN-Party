import { candidateTypeText, fallbackReasonText } from '../voiceLinks'
import type { LinkState, VoicePeerReport, VoiceReport } from '../voiceLinks'

const STATE_TEXT: Record<LinkState, string> = { connected: 'Connected', connecting: 'Connecting…', failed: 'Failed' }

// "host · UDP · 24 ms · 0.5% loss" — whatever of it the browser could tell us.
function measurements(p: { candidateType: string | null; protocol: string | null; rttMs: number | null; lossPct?: number | null }, withType: boolean): string {
  const parts: string[] = []
  const type = withType ? candidateTypeText(p.candidateType) : null
  if (type) parts.push(type)
  if (p.protocol) parts.push(p.protocol.toUpperCase())
  if (p.rttMs != null) parts.push(`${p.rttMs} ms`)
  if (p.lossPct != null) parts.push(`${p.lossPct}% loss`)
  return parts.join(' · ')
}

function PeerRow({ peer }: { peer: VoicePeerReport }) {
  const detail = peer.state === 'connected' ? measurements(peer, peer.path === 'direct') : ''
  return (
    <li className={`voice-conn-peer ${peer.state}`}>
      <span className="voice-conn-dot" aria-hidden="true" />
      <span className="voice-conn-peer-text">
        <span className="voice-conn-peer-name">{peer.name}</span>
        <span className="voice-conn-peer-state">
          {STATE_TEXT[peer.state]} · {peer.path === 'direct' ? 'direct' : 'through the voice server'}
          {detail ? ` · ${detail}` : ''}
        </span>
        {/* An older app in SFU mode cannot answer a direct connection at all, and never says so. */}
        {peer.oldApp && peer.path === 'direct' && peer.state === 'connecting' && (
          <span className="voice-conn-peer-note">Their app is an older version. If this stays on "Connecting", ask them to reload it.</span>
        )}
      </span>
    </li>
  )
}

/**
 * What the in-call connection indicator opens: how THIS client's media travels, why if that is not
 * the voice server, and the state of the path to each participant. Written for the person in the
 * call, not for whoever runs the server.
 */
export default function VoiceConnectionPanel({ report }: { report: VoiceReport }) {
  const viaServer = report.mode === 'sfu'
  const directFailed = report.peers.some((p) => p.path === 'direct' && p.state === 'failed')
  return (
    <>
      <div className="voice-quality-title">📶 Connection</div>
      <div className="voice-conn-mode">{viaServer ? 'Through the voice server' : 'Directly to each person'}</div>
      {!viaServer && report.fallback && (
        <div className="voice-conn-why">Not through the voice server because {fallbackReasonText(report.fallback)}.</div>
      )}
      {viaServer && report.server && (
        <div className={`voice-conn-server ${report.server.state}`}>
          Voice server: {STATE_TEXT[report.server.state].toLowerCase()}
          {report.server.state === 'connected' && measurements(report.server, false) ? ` · ${measurements(report.server, false)}` : ''}
        </div>
      )}
      <div className="voice-effects-section">People</div>
      {report.peers.length === 0
        ? <div className="voice-effects-hint">Nobody else is here yet.</div>
        : <ul className="voice-conn-peers">{report.peers.map((p) => <PeerRow key={p.id} peer={p} />)}</ul>}
      {directFailed && !report.relayConfigured && (
        <div className="voice-conn-why">No relay server is set up, so a direct link between two home networks can fail.</div>
      )}
      {directFailed && report.relayConfigured && (
        <div className="voice-conn-why">A direct link failed even with the relay server available. Leaving and joining again retries it.</div>
      )}
    </>
  )
}
