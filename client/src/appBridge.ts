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
// In the other direction the frame is sent five things and nothing else: the viewer's public
// identity, the public identities of the people who joined, the app's own opaque id for the voice
// channel it is running in, the app's own shared state, and the app's own transient messages.
//
// A HOSTED app (a link app set to run inside LAN Party) is somebody's site on its own server, and
// its frame is on that site's real origin. Everything above still holds for it, and two things are
// tighter, because this frame does have an origin that can be named: messages are posted to that
// exact origin, never '*', and one is accepted only when it came from the iframe's window AND from
// that origin. See hostedAppFrame() for the rule that makes a real-origin frame safe to have.

/** The sandbox for every uploaded app frame. No allow-same-origin, ever: that is what keeps the
 *  app in an opaque origin, away from LAN Party's cookies, storage and API. The server sends the
 *  same list as a CSP header on /app-bundles, so this holds even if the attribute were lost. */
export const APP_FRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock'
/** Opt-in device features games tend to want. Nothing here exposes the camera or microphone. */
export const APP_FRAME_ALLOW = 'fullscreen; gamepad; autoplay'

/** The sandbox for a hosted app's frame. allow-same-origin is here because the site needs to be
 *  itself: its own cookies, storage and backend. Next to allow-scripts that is safe for ONE reason
 *  only — the frame's origin is not this page's. A frame that is same-origin with the page around
 *  it and has both flags can reach up, take its own sandbox off and read the session. So this
 *  string is never put on a frame except through hostedAppFrame(), which refuses our own origin.
 *  No allow-top-navigation: a hosted site cannot take the LAN Party window somewhere else. */
export const HOSTED_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock'
/** What a hosted app's frame is granted: enough to play media. Still no camera or microphone. */
export const HOSTED_FRAME_ALLOW = 'autoplay; encrypted-media; fullscreen; gamepad'
/** Added to a hosted app's address as `lanparty=1`, so the site knows to try the bridge. It is the
 *  only thing LAN Party ever puts in the url: no name, no token, no room. */
export const HOSTED_APP_PARAM = 'lanparty'
// Plain http is allowed for an app on these hosts, and only while this page is itself on a loopback
// address: a developer running LAN Party and their app on one machine. On a real instance an
// http://localhost address would frame whatever each viewer happens to run on their own computer.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])
const LOOPBACK_PAGE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
const pageIsLoopback = () => LOOPBACK_PAGE_HOSTS.has(window.location.hostname)
// Scheme, host and port, with "example.com." read as "example.com": the browser calls those two
// origins, but they are one machine, and this comparison errs towards refusing.
const originKey = (u: URL) => `${u.protocol}//${u.hostname.replace(/\.+$/, '')}:${u.port}`

export type HostedFrame =
  /** `src` is the address with lanparty=1 added; `origin` is what the bridge posts to and checks. */
  | { ok: true; src: string; origin: string; host: string }
  | { ok: false; problem: 'invalid' | 'own-origin' }

/**
 * What to put in the iframe for a hosted app, or why there must not be one.
 *
 * The server checked the address when it was saved, published and started. This is the client's
 * own, independent answer, asked at the moment a frame is about to exist: the server cannot always
 * know the name this page was reached by (a proxy may rewrite it), and the page always does.
 * `ownAddresses` are other places this LAN Party is served from, as far as the caller knows — the
 * API server's address, when the client runs on a different one.
 */
export function hostedAppFrame(url: unknown, ownAddresses: string[] = []): HostedFrame {
  const invalid = { ok: false, problem: 'invalid' } as const
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return invalid
  // As typed, with nothing for the parser to quietly repair: a scheme, two slashes, a host.
  // eslint-disable-next-line no-control-regex
  if (/[\s\\\u0000-\u001f\u007f]/.test(url) || !/^https?:\/\/[^/?#]/i.test(url)) return invalid
  let u: URL
  try { u = new URL(url) } catch { return invalid }
  const host = u.hostname.replace(/\.+$/, '')
  if (!host || u.username || u.password) return invalid
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK_HOSTS.has(host) && pageIsLoopback())) return invalid
  const own = new Set<string>()
  for (const address of [window.location.href, ...ownAddresses]) {
    try { own.add(originKey(new URL(address, window.location.href))) } catch { /* names nothing */ }
  }
  if (own.has(originKey(u))) return { ok: false, problem: 'own-origin' }
  // Added to whatever query the address already has, which is left exactly as it was written.
  const flag = u.searchParams.get(HOSTED_APP_PARAM)
  if (flag === null) u.search = u.search ? `${u.search}&${HOSTED_APP_PARAM}=1` : `?${HOSTED_APP_PARAM}=1`
  else if (flag !== '1') u.searchParams.set(HOSTED_APP_PARAM, '1')
  return { ok: true, src: u.href, origin: u.origin, host: u.host }
}

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
/** The voice channel, as this app is told about it: an opaque id the server makes for (this app,
 *  this channel). The same every time for the same pair, different for every other app. */
export interface BridgeRoom { id: string }
export type SharedState = Record<string, unknown>
export interface BridgeSnapshot {
  me: BridgePerson
  participants: BridgePerson[]
  shared: SharedState
  rev: number
  /** null (or left out) when there is no voice channel: the solo viewer. */
  room?: BridgeRoom | null
}
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
/** The room key as the server sends it in the activity state (`roomKey`), as the bridge's `room`.
 *  Only the one shape the server makes counts: 32 lower-case hex characters. Anything else is no
 *  room, which an app treats as "on my own" — the safe way to be wrong. */
export const bridgeRoom = (key: unknown): BridgeRoom | null => (typeof key === 'string' && /^[0-9a-f]{32}$/.test(key) ? { id: key } : null)
const cleanRoom = (room: BridgeRoom | null | undefined): BridgeRoom | null => bridgeRoom(room?.id)

interface BridgeOptions {
  /** The iframe's window right now, or null. Read on every message rather than captured once, so
   *  the check is always against the frame that is actually on the page. */
  getFrameWindow: () => Window | null
  /** What to answer a hello with: the freshest identity, participants and state the host has. */
  getSnapshot: () => BridgeSnapshot
  transport: BridgeTransport
  /** A hosted app's exact origin (hostedAppFrame().origin). Left out for an uploaded bundle, whose
   *  frame has no origin to name. Once given it is all there is: a value that is not an origin
   *  means nothing is sent and nothing accepted — never a quiet return to '*'. */
  frameOrigin?: string
}

export function createAppBridge({ getFrameWindow, getSnapshot, transport, frameOrigin }: BridgeOptions): AppBridge {
  const exact = frameOrigin !== undefined
  // Spelled the way event.origin spells one, or it could never match (and '*' and "null" are out).
  // '' when what was given is not that: `exact` with no origin is the closed state.
  const origin = typeof frameOrigin === 'string' && /^https?:\/\/[^/?#@\s\\*]+$/.test(frameOrigin) ? frameOrigin : ''
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
    // A hosted app has an origin, so it is named: the browser then hands the message over only if
    // the document in the frame really is on it. Whatever the frame has since navigated itself to
    // (a sign-in page, another site) receives nothing.
    if (exact) {
      if (!origin) return
      try { frame.postMessage({ ...message, lanparty: BRIDGE_PROTOCOL }, origin) } catch { /* frame is going away */ }
      return
    }
    // '*' because an opaque-origin frame has no origin that could be named here. That is only
    // acceptable because nothing secret ever goes through this function — public names and
    // avatars, the app's own state and messages, and the app's own id for the room (made for this
    // app alone, and its to know). Keep it that way: no tokens, no LAN Party ids, nothing from the
    // session.
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
    post({ type: 'welcome', me: cleanPerson(snap.me), participants, room: cleanRoom(snap.room), shared: cleanShared(snap.shared), rev: sentRev })
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
    // For a hosted app the origin is checked as well. The window alone is not enough there: the
    // frame can navigate (or be redirected) to any other site and stay the same window, and that
    // site is not the app that was reviewed and joined.
    if (exact && (!origin || event.origin !== origin)) return
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

/** What a solo host may want to know about the app it is running. Only the "Check app"
 *  diagnostic uses it; the callbacks are told that something happened, never handed app data. */
export interface SoloBridgeWatch {
  /** The app said hello and was welcomed (once per hello, and the SDK may repeat it). */
  onHello?: () => void
  /** A set/replace from the app was accepted; `keys` is how many keys the state now has. */
  onStateChange?: (keys: number) => void
}

/** The bridge for an app opened on its own from the directory: the same SDK works, but there is
 *  no room. Identity is the viewer, the participants are just the viewer, and the shared state
 *  lives in this object — never sent anywhere, gone when the viewer closes. `frameOrigin` is for a
 *  hosted app, as in createAppBridge. */
export function createSoloBridge({ getFrameWindow, getMe, watch, frameOrigin }: { getFrameWindow: () => Window | null; getMe: () => BridgePerson; watch?: SoloBridgeWatch; frameOrigin?: string }): AppBridge {
  let shared: SharedState = {}
  let rev = 0
  const bridge: AppBridge = createAppBridge({
    getFrameWindow,
    frameOrigin,
    // Only ever asked for when a hello is being answered, which is what makes it the place to
    // notice one. No room: there is no voice channel here, and an app that keys its own backend by
    // room must not be handed one that other people share.
    getSnapshot: () => { const me = getMe(); watch?.onHello?.(); return { me, participants: [me], shared, rev, room: null } },
    transport: {
      change(kind, value, done) {
        const result = applySharedChange(shared, kind, value)
        if (!result.ok) { done(result); return }
        shared = result.shared
        rev += 1
        bridge.pushState(shared, rev, getMe().username)
        done({ ok: true, rev })
        watch?.onStateChange?.(Object.keys(shared).length)
      },
      emit() { /* nobody else is here to receive it */ },
    },
  })
  return bridge
}
