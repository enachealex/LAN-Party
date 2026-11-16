// "Check connection": what a call from this browser, on this network, has to work with — found out
// before joining one. Three questions:
//   1. Does the voice server's media port answer, over UDP, over TCP, or not at all?
//      (A real WebRTC transport is connected to it; see probeSfu.)
//   2. Can a STUN server see a public address for this browser? Direct connections to people on
//      other networks depend on it.
//   3. Is there a relay (TURN) for the direct connections that cannot be made otherwise?
// The measuring and the wording are separate, so the wording can be read on its own.
import type { Socket } from 'socket.io-client'
import { probeSfu } from './sfu'
import type { ProbeOutcome } from './sfu'

/** GET /webrtc/diagnostics. Every field optional: an older server has no such route. */
export interface ServerDiagnostics {
  sfu?: { enabled?: boolean; usable?: boolean; publicAddressAnnounced?: boolean; ports?: number[] }
  announcedAddressStale?: boolean
  turnConfigured?: boolean
  stunUrls?: string[]
}

export interface CheckFindings {
  diagnostics: ServerDiagnostics | null
  udp: ProbeOutcome
  tcp: ProbeOutcome
  /** true/false: a STUN server did / did not return a public address. null: none to ask. */
  stun: boolean | null
  /** true/false: the relay did / did not hand out a relayed address. null: no relay to try. */
  relay: boolean | null
}

export type CheckStatus = 'pass' | 'fail' | 'skip'
export interface CheckLine { id: 'udp' | 'tcp' | 'stun' | 'turn'; label: string; status: CheckStatus; text: string }
export interface CheckReport { lines: CheckLine[]; summary: string; notes: string[] }

const DEFAULT_STUN = ['stun:stun.l.google.com:19302']

/** Ask STUN for this browser's public address. Resolves true as soon as one comes back. */
export function stunReturnsPublicAddress(urls: string[], timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection
    try { pc = new RTCPeerConnection({ iceServers: [{ urls }] }) } catch { resolve(false); return }
    let done = false
    const finish = (found: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { pc.close() } catch { /* already closed */ }
      resolve(found)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    pc.onicecandidate = (e) => {
      if (!e.candidate) { finish(false); return } // gathering finished without one
      // `type` is missing in some browsers; the candidate line always carries it.
      if (e.candidate.type === 'srflx' || / typ srflx /.test(e.candidate.candidate)) finish(true)
    }
    // Candidates are only gathered for a connection that has something to carry.
    pc.createDataChannel('check')
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => finish(false))
  })
}

/**
 * Ask the TURN relay for a relayed address with this account's credential. A 'relay' candidate comes
 * back only when the relay was reached AND accepted the credential, so this is the real test of it,
 * not just whether one is configured. Only relay servers are given, so nothing else can answer.
 */
export function relayHandsOutAddress(servers: RTCIceServer[], timeoutMs = 7000): Promise<boolean> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection
    try { pc = new RTCPeerConnection({ iceServers: servers, iceTransportPolicy: 'relay' }) } catch { resolve(false); return }
    let done = false
    const finish = (found: boolean) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { pc.close() } catch { /* already closed */ }
      resolve(found)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    pc.onicecandidate = (e) => {
      if (!e.candidate) { finish(false); return }
      if (e.candidate.type === 'relay' || / typ relay /.test(e.candidate.candidate)) finish(true)
    }
    pc.createDataChannel('check')
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => finish(false))
  })
}

const relayServers = (servers: RTCIceServer[] | null | undefined) =>
  (servers || []).filter((s) => [].concat(s.urls as never).some((u: string) => /^turns?:/i.test(String(u))) && s.username && s.credential)

/** Run every measurement. `getDiagnostics` fetches /webrtc/diagnostics (null when it cannot). */
export async function measureConnection(socket: Socket, getDiagnostics: () => Promise<ServerDiagnostics | null>, getIceServers?: () => Promise<RTCIceServer[] | null>): Promise<CheckFindings> {
  const diagnostics = await getDiagnostics().catch(() => null)
  const stunUrls = diagnostics?.stunUrls?.length ? diagnostics.stunUrls : DEFAULT_STUN
  const sfuOff = diagnostics?.sfu ? !(diagnostics.sfu.enabled && diagnostics.sfu.usable) : false
  const relays = getIceServers && diagnostics?.turnConfigured ? relayServers(await getIceServers().catch(() => null)) : []
  const [udp, tcp, stun, relay] = await Promise.all([
    sfuOff ? Promise.resolve<ProbeOutcome>('sfu-off') : probeSfu(socket, 'udp'),
    sfuOff ? Promise.resolve<ProbeOutcome>('sfu-off') : probeSfu(socket, 'tcp'),
    stunReturnsPublicAddress(stunUrls),
    relays.length ? relayHandsOutAddress(relays) : Promise.resolve<boolean | null>(null),
  ])
  return { diagnostics, udp, tcp, stun, relay }
}

function probeLine(id: 'udp' | 'tcp', outcome: ProbeOutcome): CheckLine {
  const name = id.toUpperCase()
  const label = `Voice server over ${name}`
  switch (outcome) {
    case 'reachable':
      return { id, label, status: 'pass', text: id === 'udp'
        ? 'This browser reached the voice server\'s media port over UDP, the path calls prefer.'
        : 'This browser reached the voice server\'s media port over TCP, which calls use when UDP is blocked.' }
    case 'unreachable':
      return { id, label, status: 'fail', text: `Nothing came back from the voice server's media port over ${name}: this network, or the server's router, is not letting it through.` }
    case 'sfu-off':
      return { id, label, status: 'skip', text: 'Not tested: the voice server is off, so calls connect people directly.' }
    case 'rate-limited':
      return { id, label, status: 'skip', text: 'Not tested: too many checks in a row. Try again in a minute.' }
    default:
      return { id, label, status: 'skip', text: 'Not tested: the check itself could not run in this browser.' }
  }
}

/** Turn what was measured into lines a person can act on. Pure: no browser needed to read it. */
export function describeConnection(found: CheckFindings): CheckReport {
  const d = found.diagnostics
  const lines: CheckLine[] = [probeLine('udp', found.udp), probeLine('tcp', found.tcp)]

  lines.push(found.stun
    ? { id: 'stun', label: 'Public address (STUN)', status: 'pass', text: 'A STUN server could see this browser\'s public address, which direct connections to other networks need.' }
    : { id: 'stun', label: 'Public address (STUN)', status: 'fail', text: 'No STUN server answered with a public address, so direct connections to people on other networks are unlikely to work from here.' })

  const turn = d ? !!d.turnConfigured : null
  lines.push(turn && found.relay === true
    ? { id: 'turn', label: 'Relay server (TURN)', status: 'pass', text: 'This browser reached the relay server and it accepted this account, so a direct connection that cannot be made any other way still has a route.' }
    : turn && found.relay === false
      ? { id: 'turn', label: 'Relay server (TURN)', status: 'fail', text: 'A relay server is set up, but this browser could not get a relayed address from it: this network, or the server\'s router, is not letting it through.' }
    : turn
      ? { id: 'turn', label: 'Relay server (TURN)', status: 'pass', text: 'A relay server is set up, so a direct connection that cannot be made any other way still has a route.' }
    : turn === false
      ? { id: 'turn', label: 'Relay server (TURN)', status: 'fail', text: 'No relay server is set up, so a direct link between two home networks can fail.' }
      : { id: 'turn', label: 'Relay server (TURN)', status: 'skip', text: 'Not known: the server did not say whether it has a relay.' })

  const reachable = found.udp === 'reachable' || found.tcp === 'reachable'
  const tested = found.udp === 'reachable' || found.udp === 'unreachable' || found.tcp === 'reachable' || found.tcp === 'unreachable'
  let summary: string
  if (reachable) {
    summary = found.udp === 'reachable'
      ? 'Calls from here go through the voice server.'
      : 'Calls from here go through the voice server over TCP, which works but can add delay.'
  } else if (tested) {
    summary = 'This browser cannot reach the voice server\'s media port at all, so calls from here connect directly to each person instead.'
  } else if (found.udp === 'sfu-off') {
    summary = 'The voice server is off on this instance, so every call connects people directly.'
  } else {
    summary = 'The voice server could not be tested just now.'
  }

  const notes: string[] = []
  if (!reachable && tested) {
    if (d?.announcedAddressStale) notes.push('The server reports that its public address has changed since it was set up. Until whoever runs it updates that, nobody outside its own network can reach the voice server.')
    else if (d?.sfu && d.sfu.publicAddressAnnounced === false) notes.push('The voice server only announces an address on its own network, so it can only be reached from that network.')
    if (!found.stun || turn === false) notes.push('Direct connections are the fallback, and from here they may not reach everyone either.')
  }
  return { lines, summary, notes }
}
