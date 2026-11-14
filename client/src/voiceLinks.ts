// Who connects directly to whom in a voice room, and how to say what happened.
//
// A room can hold both kinds of participant at once: 'sfu' (media goes through the voice server)
// and 'mesh' (media goes straight to each person). The one rule everything here follows:
//
//     two participants have a direct connection  <=>  at least one of them is in mesh mode
//
// Two SFU participants therefore only ever meet on the server, a mesh participant has a direct
// connection to everyone, and nobody is reachable twice. These are plain functions of plain values
// so the rule can be read (and exercised) without a browser; App.jsx applies them to real
// connections.

export type VoiceMode = 'sfu' | 'mesh'

/** What this client knows about one other participant. */
export interface VoicePeer {
  /** What their app declared. null: an older app, which never says. */
  mode: VoiceMode | null
  /** They were in the room when I arrived (or when I switched to mesh), so I am the newcomer to them. */
  hereFirst: boolean
  /** They have sent an offer. For an undeclared peer that is the proof it connects directly. */
  offered: boolean
}

export interface LinkContext {
  myMode: VoiceMode
  /** Do I know yet what is on the voice server (has my session finished connecting)? */
  catalogueKnown: boolean
  /** Is this peer publishing to the voice server? */
  onSfu: boolean
}

export const UNKNOWN_PEER: VoicePeer = { mode: null, hereFirst: false, offered: false }

/** A mode as the server sends it, or null for anything else (an older app, an older server). */
export function asVoiceMode(value: unknown): VoiceMode | null {
  return value === 'sfu' || value === 'mesh' ? value : null
}

/**
 * Should a direct connection to this peer exist? This is also what decides which of a peer's two
 * possible streams is played (the direct one or the one from the server): exactly one, never both.
 *
 * An undeclared peer is an older app. It cannot tell us its mode, so we go by what it does: it has
 * offered to us (older apps only offer in mesh mode), or it is publishing nothing to the server.
 */
export function wantsDirectLink(peer: VoicePeer, ctx: LinkContext): boolean {
  if (ctx.myMode === 'mesh') return true
  if (peer.mode === 'mesh') return true
  if (peer.mode === 'sfu') return false
  if (peer.offered) return true
  return ctx.catalogueKnown && !ctx.onSfu
}

/**
 * Given that a direct connection should exist: is it mine to start? Exactly one side starts, so two
 * offers do not cross (the connection would survive that, but slower).
 *   - mesh + sfu: the mesh participant offers; it is the one that needs the connection.
 *   - mesh + mesh, or mesh + an older app: the newcomer offers, as the mesh always did.
 *   - sfu + an older app that is not on the server: it is in mesh mode and waiting for newcomers to
 *     offer, so I do if I am the newcomer.
 */
export function shouldOffer(peer: VoicePeer, ctx: LinkContext): boolean {
  if (ctx.myMode === 'mesh') return peer.mode === 'sfu' || peer.hereFirst
  return peer.mode === null && peer.hereFirst && ctx.catalogueKnown && !ctx.onSfu
}

/**
 * Is signalling from this peer acted on? In mesh mode always. In SFU mode from everyone except a
 * declared SFU participant: with them there is nothing to negotiate, and answering would open the
 * second path the rule forbids. `peer` is undefined when the offer got here before the server's
 * announcement of the newcomer, which only a mesh participant's offer can.
 */
export function acceptsSignal(peer: VoicePeer | undefined, myMode: VoiceMode): boolean {
  if (myMode === 'mesh') return true
  return !peer || peer.mode !== 'sfu'
}

// ---- Why a call is not on the voice server ----

/** Codes this client reports to the server (which logs them) and explains to the user. */
export type FallbackCode = 'user-choice' | 'sfu-off' | 'media-unreachable' | 'media-lost' | 'refused'
export interface Fallback { code: FallbackCode; detail?: string }

/** The reason, as the rest of a sentence that starts "…because". */
export function fallbackReasonText(fallback: Fallback): string {
  switch (fallback.code) {
    case 'user-choice': return 'you chose direct connection only'
    case 'sfu-off': return 'the voice server is off'
    case 'media-unreachable': return 'the voice server\'s media port could not be reached from your network'
    case 'media-lost': return 'the connection to the voice server\'s media port was lost'
    case 'refused': return `the voice server refused: ${fallback.detail || 'no reason given'}`
  }
}

// ---- Reading a connection's statistics ----

export type LinkState = 'connected' | 'connecting' | 'failed'

export interface LinkStats {
  /** host / srflx / prflx / relay — 'relay' if either end goes through a relay. */
  candidateType: string | null
  protocol: string | null
  rttMs: number | null
  packetsLost: number | null
  packetsReceived: number | null
}

export const EMPTY_STATS: LinkStats = { candidateType: null, protocol: null, rttMs: null, packetsLost: null, packetsReceived: null }

/**
 * Pull the facts worth showing out of a getStats() report: the candidate pair in use, its round
 * trip, and how much incoming audio went missing. Browsers differ in which entries exist (Firefox
 * has no 'transport' entry, Safari omits some counters), so everything is optional.
 */
export function summarizeStats(report: Iterable<any> | { forEach: (fn: (value: any) => void) => void }): LinkStats {
  const entries: any[] = []
  ;(report as { forEach: (fn: (value: any) => void) => void }).forEach((value: any) => { entries.push(value) })
  const byId = new Map<string, any>(entries.map((e) => [e.id, e]))

  const transport = entries.find((e) => e.type === 'transport' && e.selectedCandidatePairId)
  let pair = transport ? byId.get(transport.selectedCandidatePairId) : undefined
  if (!pair) pair = entries.find((e) => e.type === 'candidate-pair' && (e.selected || (e.nominated && e.state === 'succeeded')))

  const local = pair ? byId.get(pair.localCandidateId) : undefined
  const remote = pair ? byId.get(pair.remoteCandidateId) : undefined
  let candidateType: string | null = local?.candidateType ?? null
  if (remote?.candidateType === 'relay') candidateType = 'relay'

  let packetsLost: number | null = null
  let packetsReceived: number | null = null
  for (const e of entries) {
    if (e.type !== 'inbound-rtp' || (e.kind ?? e.mediaType) !== 'audio') continue
    if (typeof e.packetsLost === 'number') packetsLost = (packetsLost ?? 0) + e.packetsLost
    if (typeof e.packetsReceived === 'number') packetsReceived = (packetsReceived ?? 0) + e.packetsReceived
  }

  return {
    candidateType,
    protocol: local?.protocol ?? null,
    rttMs: typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null,
    packetsLost,
    packetsReceived,
  }
}

/**
 * Loss over the stretch between two readings, as a percentage; null when there is nothing to go
 * on. The counters are totals since the call began, and a total hides what is happening now.
 */
export function lossPercent(now: LinkStats, before: LinkStats | undefined): number | null {
  if (now.packetsLost == null || now.packetsReceived == null) return null
  const lost = now.packetsLost - (before?.packetsLost ?? 0)
  const received = now.packetsReceived - (before?.packetsReceived ?? 0)
  const total = lost + received
  if (total <= 0 || lost < 0) return null
  return Math.round((lost / total) * 1000) / 10
}

/** An ICE candidate type in words. */
export function candidateTypeText(type: string | null): string | null {
  switch (type) {
    case 'host': return 'same network (host)'
    case 'srflx': return 'through your router (server-reflexive)'
    case 'prflx': return 'through your router (peer-reflexive)'
    case 'relay': return 'through the relay server (relay)'
    default: return null
  }
}

// ---- What the in-call connection panel and window.__lanpartyVoice() are given ----

export interface VoicePeerReport {
  id: string
  name: string
  path: 'sfu' | 'direct'
  state: LinkState
  candidateType: string | null
  protocol: string | null
  rttMs: number | null
  lossPct: number | null
  /** An older app that does not declare its mode. */
  oldApp: boolean
}

export interface VoiceReport {
  mode: VoiceMode | null
  fallback: Fallback | null
  /** This client's own connection to the voice server; null in mesh mode. */
  server: { state: LinkState; candidateType: string | null; protocol: string | null; rttMs: number | null } | null
  peers: VoicePeerReport[]
  relayConfigured: boolean
}

export type VoiceHealth = 'ok' | 'connecting' | 'problem'

/** One word for the indicator's colour. */
export function voiceHealth(report: VoiceReport): VoiceHealth {
  if (report.server?.state === 'failed' || report.peers.some((p) => p.state === 'failed')) return 'problem'
  if (report.server?.state === 'connecting' || report.peers.some((p) => p.state === 'connecting')) return 'connecting'
  return 'ok'
}
