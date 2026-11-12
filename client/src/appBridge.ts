// The host side of the app bridge: what sits between an uploaded mini-app's iframe and LAN Party.
// The other end is server/sdk/lanparty.js, which the app loads; docs/APP-INTEGRATION.md describes
// the whole thing.
//
// The app is uploaded, untrusted code in an opaque-origin sandbox. This module is the ONLY thing it
// can talk to, so everything here is written as if the frame were hostile:
//   - a message counts only if it came from that iframe's own window (event.source). The frame's
//     origin is "null", so event.origin proves nothing and is never looked at;
//   - every message is checked for shape and size before anything is done with it;
//   - the app picks payloads, never destinations: its three message types map onto three fixed
//     activity events, and the room they go to is whichever one the host is in;
//   - nothing that arrives is rendered. It is only passed on as data.
// In the other direction the frame is sent four things and nothing else: the viewer's public
// identity, the public identities of the people who joined, the app's own shared state, and the
// app's own transient messages.

/** The sandbox for every uploaded app frame. No allow-same-origin, ever: that is what keeps the
 *  app in an opaque origin, away from LAN Party's cookies, storage and API. The server sends the
 *  same list as a CSP header on /app-bundles, so this holds even if the attribute were lost. */
export const APP_FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock'
/** Opt-in device features games tend to want. Nothing here exposes the camera or microphone. */
export const APP_FRAME_ALLOW = 'fullscreen; gamepad; autoplay'

export const BRIDGE_PROTOCOL = 1
// Mirrors the server (server/services/activities.js APP_LIMITS). The server enforces these for
// real; checking here first means an oversized or flooding app is stopped in this tab, before it
// costs the socket this user's chat and voice signalling also run on.
export const BRIDGE_LIMITS = {
  sharedBytes: 64 * 1024,
  keys: 200,
  keyLength: 64,
  messageBytes: 8 * 1024,
  depth: 32,
  burst: 30,
  perSecond: 15,
}
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// A valid 64 KB payload cannot hold more values than this, so the walk below stops early on
// anything bigger (postMessage can deliver cyclic structures and billion-slot sparse arrays).
const MAX_NODES = 70_000
/** What one walk may still spend. `chars` is the characters of strings and key names seen so far:
 *  JSON never encodes a character in less than a byte, so a value with more characters than the
 *  byte limit is over it, and is refused during the walk — before JSON.stringify is ever asked to
 *  build a second copy of a string that may be hundreds of megabytes long. */
interface WalkBudget { nodes: number; chars: number; tooLarge: boolean }
const walkBudget = (byteLimit: number): WalkBudget => ({ nodes: MAX_NODES, chars: byteLimit, tooLarge: false })
// An accepted change is acknowledged to the app only after the state containing it has been
// forwarded. If that state somehow never arrives, the ack goes out anyway after this long.
const ACK_HOLD_MS = 1500
const MAX_PEOPLE = 500
const MAX_URL_LENGTH = 2048

export interface BridgePerson { username: string; displayName: string; avatarUrl: string }
export type SharedState = Record<string, unknown>
export interface BridgeSnapshot { me: BridgePerson; participants: BridgePerson[]; shared: SharedState; rev: number }
export interface ChangeResult { ok: boolean; reason?: string; rev?: number }

/** Where an app's requests go: the voice room's activity events, or local state in the solo viewer. */
export interface BridgeTransport {
  /** Apply a validated set/replace. `done` must be called once with the outcome. */
  change(kind: 'set' | 'replace', value: SharedState, done: (result: ChangeResult) => void): void
  /** Send a validated transient message to the others. */
  emit(data: unknown): void
}

export interface AppBridge {
  /** Forward the app's shared state. Safe to call on every render: an unchanged rev is skipped. */
  pushState(shared: unknown, rev: number, lastBy?: string | null): void
  /** Forward who has joined. Also safe to call repeatedly. */
  pushParticipants(list: BridgePerson[]): void
  /** Forward a transient message from someone else in the room. */
  pushMessage(from: string, data: unknown): void
  /** Tell the app it is over (activity ended, or this person left). Best effort: the frame is
   *  normally removed straight after, so an app must not count on seeing it. */
  close(reason?: string): void
  /** Stop listening. Call when the iframe goes away. */
  destroy(): void
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

// True only for what JSON carries faithfully, with no prototype-pollution key at any depth.
// postMessage uses structured clone, which happily delivers Maps, Dates, BigInts and cycles — none
// of which may reach JSON.stringify or the socket.
function jsonSafe(v: unknown, depth: number, budget: WalkBudget): boolean {
  if (--budget.nodes < 0) return false
  if (typeof v === 'string') return spend(budget, v.length)
  if (v === null || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v !== 'object' || depth >= BRIDGE_LIMITS.depth) return false
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (!jsonSafe(v[i], depth + 1, budget)) return false
    return true
  }
  if (!isPlainObject(v)) return false
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.has(k)) return false
    if (!spend(budget, k.length)) return false
    if (!jsonSafe(v[k], depth + 1, budget)) return false
  }
  return true
}
function spend(budget: WalkBudget, chars: number): boolean {
  budget.chars -= chars
  if (budget.chars < 0) budget.tooLarge = true
  return budget.chars >= 0
}
const keyOk = (k: string) => k.length >= 1 && k.length <= BRIDGE_LIMITS.keyLength && !FORBIDDEN_KEYS.has(k)
const encoder = new TextEncoder()
// UTF-8 bytes of the JSON, which is what the server counts. Only ever called on a value jsonSafe
// has already walked with a character budget, so the text built here is bounded by that budget
// (plus punctuation for at most MAX_NODES values) whatever the app sent.
function jsonBytesOver(v: unknown, limit: number): boolean {
  const text = JSON.stringify(v)
  if (text.length > limit) return true
  return encoder.encode(text).length > limit
}

/** Why a set/replace payload from the app cannot be accepted, or null when it can be sent on. */
function changeProblem(value: unknown): string | null {
  if (!isPlainObject(value)) return 'invalid'
  const keys = Object.keys(value)
  if (keys.length > BRIDGE_LIMITS.keys) return 'too-many-keys'
  if (!keys.every(keyOk)) return 'bad-key'
  const budget = walkBudget(BRIDGE_LIMITS.sharedBytes)
  if (!jsonSafe(value, 0, budget)) return budget.tooLarge ? 'too-large' : 'invalid'
  if (jsonBytesOver(value, BRIDGE_LIMITS.sharedBytes)) return 'too-large'
  return null
}

/** The same merge the server does, for state that only lives in this tab (the solo viewer).
 *  Built from entries and Object.fromEntries so no key can ever go through a prototype setter. */
export function applySharedChange(shared: SharedState, kind: 'set' | 'replace', value: SharedState): { ok: true; shared: SharedState } | { ok: false; reason: string } {
  const entries = new Map<string, unknown>(kind === 'set' ? Object.entries(shared) : [])
  for (const k of Object.keys(value)) {
    if (value[k] === null) entries.delete(k)
    else entries.set(k, JSON.parse(JSON.stringify(value[k])))
  }
  if (entries.size > BRIDGE_LIMITS.keys) return { ok: false, reason: 'too-many-keys' }
  const next = Object.fromEntries(entries)
  if (jsonBytesOver(next, BRIDGE_LIMITS.sharedBytes)) return { ok: false, reason: 'too-large' }
  return { ok: true, shared: next }
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
function cleanPerson(p: BridgePerson | null | undefined): BridgePerson {
  const username = text(p?.username, 80)
  const avatarUrl = typeof p?.avatarUrl === 'string' && p.avatarUrl.length <= MAX_URL_LENGTH ? p.avatarUrl : ''
  return { username, displayName: text(p?.displayName, 80) || username, avatarUrl }
}
const cleanPeople = (list: BridgePerson[]) => (Array.isArray(list) ? list.slice(0, MAX_PEOPLE).map(cleanPerson) : [])
const cleanShared = (shared: unknown): SharedState => (isPlainObject(shared) ? shared : {})

interface BridgeOptions {
  /** The iframe's window right now, or null. Read on every message rather than captured once, so
   *  the check is always against the frame that is actually on the page. */
  getFrameWindow: () => Window | null
  /** What to answer a hello with: the freshest identity, participants and state the host has. */
  getSnapshot: () => BridgeSnapshot
  transport: BridgeTransport
}

export function createAppBridge({ getFrameWindow, getSnapshot, transport }: BridgeOptions): AppBridge {
  let destroyed = false
  let closed = false
  // Nothing is forwarded until the app has said hello and been welcomed: before that it has no
  // listener, and the welcome carries the current state anyway.
  let welcomed = false
  let sentRev = -1
  let sentParticipants = ''
  let held: { id: number; rev: number; timer: ReturnType<typeof setTimeout> }[] = []
  let tokens = BRIDGE_LIMITS.burst
  let tokensAt = Date.now()

  function post(message: Record<string, unknown>) {
    if (destroyed) return
    const frame = getFrameWindow()
    if (!frame) return
    // '*' because an opaque-origin frame has no origin that could be named here. That is only
    // acceptable because nothing secret ever goes through this function — public names and
    // avatars, and the app's own state and messages. Keep it that way: no tokens, no ids, nothing
    // from the session.
    try { frame.postMessage({ ...message, lanparty: BRIDGE_PROTOCOL }, '*') } catch { /* frame is going away */ }
  }
  // One bucket for everything the app sends, like the server's, so a runaway loop in an app is
  // absorbed here instead of becoming socket traffic.
  function allowed(): boolean {
    const now = Date.now()
    tokens = Math.min(BRIDGE_LIMITS.burst, tokens + Math.max(0, now - tokensAt) / 1000 * BRIDGE_LIMITS.perSecond)
    tokensAt = now
    if (tokens < 1) return false
    tokens -= 1
    return true
  }
  const ack = (id: number, ok: boolean, reason?: string) => post(reason ? { type: 'ack', id, ok, reason } : { type: 'ack', id, ok })
  function releaseHeld(upToRev: number) {
    const ready = held.filter((h) => h.rev <= upToRev)
    if (!ready.length) return
    held = held.filter((h) => h.rev > upToRev)
    for (const h of ready) { clearTimeout(h.timer); ack(h.id, true) }
  }

  function sendWelcome() {
    const snap = getSnapshot()
    welcomed = true
    sentRev = Number.isFinite(snap.rev) ? snap.rev : 0
    const participants = cleanPeople(snap.participants)
    sentParticipants = JSON.stringify(participants)
    post({ type: 'welcome', me: cleanPerson(snap.me), participants, shared: cleanShared(snap.shared), rev: sentRev })
    releaseHeld(sentRev)
  }

  function onChange(kind: 'set' | 'replace', m: Record<string, unknown>) {
    const id = m.id
    // Without a usable id there is nothing to answer; the SDK always sends one.
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) return
    if (!allowed()) { ack(id, false, 'rate-limited'); return }
    const value = kind === 'set' ? m.patch : m.shared
    const problem = changeProblem(value)
    if (problem) { ack(id, false, problem); return }
    let answered = false
    transport.change(kind, value as SharedState, (result) => {
      if (answered || destroyed) return
      answered = true
      const ok = !!result && result.ok === true
      if (!ok) { ack(id, false, typeof result?.reason === 'string' ? result.reason : 'rejected'); return }
      // The SDK drops its optimistic copy of a change the moment it is acked, so the state that
      // contains the change has to be in the frame first — otherwise the app would see its own
      // move vanish and come back. The server sends that state before the ack and the host
      // normally forwards it at once, so this is usually immediate; but the bridge does not get to
      // assume how its host delivers state (a render can sit in between), so an ack that arrives
      // ahead of its state is held until the state has gone out.
      const rev = typeof result.rev === 'number' ? result.rev : sentRev
      if (rev <= sentRev) { ack(id, true); return }
      const timer = setTimeout(() => {
        held = held.filter((h) => h.id !== id)
        ack(id, true)
      }, ACK_HOLD_MS)
      held.push({ id, rev, timer })
    })
  }

  function onMessage(event: MessageEvent) {
    if (destroyed || closed) return
    // The one check that identifies the sender. Any window can post to this one — another tab's
    // opener, an ad frame, a different uploaded app — but only the app's own iframe has this
    // exact window object.
    const frame = getFrameWindow()
    if (!frame || event.source !== frame) return
    const m: unknown = event.data
    if (!isPlainObject(m) || m.lanparty !== BRIDGE_PROTOCOL || typeof m.type !== 'string') return
    if (m.type === 'hello') {
      // Every hello gets a welcome (the SDK repeats it until answered), within the same budget
      // as everything else so a hello loop cannot make this tab serialise the state forever.
      if (allowed()) sendWelcome()
      return
    }
    if (!welcomed) return
    if (m.type === 'set') onChange('set', m)
    else if (m.type === 'replace') onChange('replace', m)
    else if (m.type === 'emit') {
      if (!allowed()) return
      if (m.data === undefined || !jsonSafe(m.data, 0, walkBudget(BRIDGE_LIMITS.messageBytes))) return
      if (jsonBytesOver(m.data, BRIDGE_LIMITS.messageBytes)) return
      transport.emit(m.data)
    }
    // Anything else is ignored. In particular there is no message that joins, leaves, starts or
    // ends an activity: those are choices a person makes in LAN Party's own UI.
  }

  window.addEventListener('message', onMessage)

  return {
    pushState(shared, rev, lastBy) {
      if (!welcomed || closed || destroyed || !Number.isFinite(rev)) return
      if (rev === sentRev) return
      sentRev = rev
      post({ type: 'state', shared: cleanShared(shared), rev, lastBy: typeof lastBy === 'string' ? lastBy : null })
      releaseHeld(rev)
    },
    pushParticipants(list) {
      if (!welcomed || closed || destroyed) return
      const participants = cleanPeople(list)
      const key = JSON.stringify(participants)
      if (key === sentParticipants) return
      sentParticipants = key
      post({ type: 'participants', participants })
    },
    pushMessage(from, data) {
      if (!welcomed || closed || destroyed) return
      post({ type: 'message', from: text(from, 80), data: data === undefined ? null : data })
    },
    close(reason) {
      if (closed || destroyed) return
      if (welcomed) post(reason ? { type: 'closed', reason } : { type: 'closed' })
      closed = true
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      window.removeEventListener('message', onMessage)
      for (const h of held) clearTimeout(h.timer)
      held = []
    },
  }
}

/** The bridge for an app opened on its own from the directory: the same SDK works, but there is
 *  no room. Identity is the viewer, the participants are just the viewer, and the shared state
 *  lives in this object — never sent anywhere, gone when the viewer closes. */
export function createSoloBridge({ getFrameWindow, getMe }: { getFrameWindow: () => Window | null; getMe: () => BridgePerson }): AppBridge {
  let shared: SharedState = {}
  let rev = 0
  const bridge: AppBridge = createAppBridge({
    getFrameWindow,
    getSnapshot: () => { const me = getMe(); return { me, participants: [me], shared, rev } },
    transport: {
      change(kind, value, done) {
        const result = applySharedChange(shared, kind, value)
        if (!result.ok) { done(result); return }
        shared = result.shared
        rev += 1
        bridge.pushState(shared, rev, getMe().username)
        done({ ok: true, rev })
      },
      emit() { /* nobody else is here to receive it */ },
    },
  })
  return bridge
}
