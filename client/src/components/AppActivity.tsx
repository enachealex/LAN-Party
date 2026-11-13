import { useCallback, useEffect, useRef, useState } from 'react'
import {
  APP_FRAME_ALLOW, APP_FRAME_SANDBOX, HOSTED_FRAME_ALLOW, HOSTED_FRAME_SANDBOX,
  bridgeRoom, createAppBridge, hostedAppFrame,
  type AppBridge, type BridgePerson, type BridgeRoom, type ChangeResult,
} from '../appBridge'

// An app running as the voice room's activity: an uploaded mini-app (a bundle), or a hosted app —
// somebody's own site, set to run inside LAN Party.
//
// Unlike the built-in activities this one does NOT open by itself. The code was uploaded by some
// member, so another person starting it is not a reason for it to run in this client: everyone in
// the room sees a card saying what is running and who started it, and the iframe is only created
// once this person presses Join (whoever started it has already made that choice). Leaving
// destroys the iframe for this person alone; "End" ends the activity for the room.

/** The state the server keeps for an app activity (server/services/activities.js appActivityInit). */
interface AppActivityState {
  appId: number
  name: string
  /** A bundle's /app-bundles/<dir>/ path, or a hosted app's own absolute address. */
  url: string
  /** True for a hosted app: its frame is on the site's real origin, not in the opaque sandbox. */
  hosted?: boolean
  iconUrl: string
  createdBy: string
  /** False while the app has not been approved by an instance owner: its uploader (or an instance
   *  owner) started it to try it out. The card says so, and each person decides whether to join. */
  approved?: boolean
  /** Names this run of the app; sent back with every event so a stale one can be dropped. */
  run: string
  /** The app's opaque id for this voice channel. The server sends it only to a socket that has
   *  joined the app; for everyone else (and after leaving) it is null. */
  roomKey?: string | null
  shared: Record<string, unknown>
  rev: number
  lastBy: string | null
  joined: string[]
}
type ActivityEvent = Record<string, unknown>
type EventAck = (result: ChangeResult) => void

/** What App.jsx passes on from the socket, as it arrives and in the order it arrives. */
export type AppHostEvent =
  | { type: 'activity'; activity: unknown }
  | { type: 'message'; from: string; data: unknown }
  /** The socket connected again. A new socket is in no voice room and has joined nothing. */
  | { type: 'reconnected' }

interface AppActivityProps {
  activity: { type: 'app'; by: string; state: AppActivityState }
  /** This user's name as the server knows it. */
  me: string
  /** Sends an activity event for the current voice room; the ack is the server's verdict. `run`
   *  says which run of the app the event is for, so the server can drop it if the room has moved on. */
  onEvent: (event: ActivityEvent, ack?: EventAck, run?: string) => void
  /** Ends the activity for everyone. */
  onClose: () => void
  /** Public identity (name, avatar) of a member, for the card and for the app. */
  describePerson: (username: string) => BridgePerson
  /** Makes a server-relative url absolute (the dev client runs on a different origin). Must be
   *  stable in what it answers: the frame's src is built from it on every render. */
  resolveSrc: (url: string) => string
  /** Subscribe to this room's activity updates and transient app messages. Must be stable. */
  subscribe: (handler: (event: AppHostEvent) => void) => () => void
  /** True when this client is the one that just started the app. */
  autoJoin?: boolean
  /** The uploader's description, when the directory listing is loaded. */
  description?: string
}

const JOIN_TIMEOUT_MS = 5000
// Refusals that mean this client is no longer part of the app at all, as opposed to one change
// being turned down: the server does not have this socket as joined, or as in the voice room (a
// reconnect gives it a new socket that is in neither), or the activity is gone.
const OUT_REASONS = new Set(['not-joined', 'not-in-room', 'ended'])
const LOST_ROOM = 'The connection to the room was lost. Rejoin the voice channel to use this app.'

interface Latest { shared: Record<string, unknown>; rev: number; lastBy: string | null }
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const toLatest = (state: Record<string, unknown>): Latest => ({
  shared: isRecord(state.shared) ? state.shared : {},
  rev: typeof state.rev === 'number' && Number.isFinite(state.rev) ? state.rev : 0,
  lastBy: typeof state.lastBy === 'string' ? state.lastBy : null,
})

function PersonChip({ person }: { person: BridgePerson }) {
  return (
    <span className="app-activity-person">
      {person.avatarUrl
        ? <img className="app-activity-person-pic" src={person.avatarUrl} alt="" />
        : <span className="app-activity-person-pic app-activity-person-initial">{(person.displayName || '?').slice(0, 1).toUpperCase()}</span>}
      <span className="app-activity-person-name">{person.displayName}</span>
    </span>
  )
}

export default function AppActivity({ activity, me, onEvent, onClose, describePerson, resolveSrc, subscribe, autoJoin = false, description = '' }: AppActivityProps) {
  const { state, by } = activity
  const joinedNames = Array.isArray(state.joined) ? state.joined.filter((n): n is string => typeof n === 'string') : []
  const participants = joinedNames.map(describePerson)

  // 'joined' is about THIS client: the same person can be in the room on a second device that has
  // not joined, and state.joined (names) cannot tell the two apart.
  const [phase, setPhase] = useState<'card' | 'joining' | 'joined'>('card')
  const [error, setError] = useState('')
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const bridgeRef = useRef<AppBridge | null>(null)
  const phaseRef = useRef(phase)
  const aliveRef = useRef(true)
  const seenSelfRef = useRef(false)
  // Read by callbacks that outlive the render that made them (socket acks, the bridge answering a
  // hello), so they are refreshed on every render rather than captured.
  const onEventRef = useRef(onEvent)
  onEventRef.current = onEvent
  // Fixed for the life of this component (the parent keys it by run), and sent with every event.
  const run = state.run
  const send = useCallback((event: ActivityEvent, ack: EventAck) => onEventRef.current(event, ack, run), [run])
  const peopleRef = useRef({ me: describePerson(me), participants })
  peopleRef.current = { me: describePerson(me), participants }
  // The app's state as last heard from the server. Written by the socket subscription below, in
  // arrival order, NOT taken from props: React may fold two quick updates into one render, and an
  // app that cares who moved first (a buzzer) needs to see every one of them. Props only ever win
  // when they are strictly newer, which covers an update that landed before the subscription did.
  const latestRef = useRef<Latest>(toLatest(state as unknown as Record<string, unknown>))
  if ((state.rev || 0) > latestRef.current.rev) latestRef.current = toLatest(state as unknown as Record<string, unknown>)
  // What the app is told this room is called. Kept the same two ways as the state: from the socket
  // as it arrives, and from props on every render. It is read when the app says hello, and the
  // update that carries it reaches this socket just before the server confirms the join — so it is
  // here before the frame is.
  const roomRef = useRef<BridgeRoom | null>(null)
  roomRef.current = bridgeRoom(state.roomKey)

  // Which frame this app gets. Worked out from the run's own url and kind, which never change
  // while this component lives (the parent keys it by run), so every render arrives at the same
  // strings and the iframe below is never given a new src or sandbox.
  //   - a bundle: the server's own /app-bundles/<dir>/ path, in the opaque sandbox;
  //   - a hosted app: its own address plus lanparty=1, on its real origin — unless that origin is
  //     LAN Party's, in which case there is no frame at all (see hostedAppFrame).
  const hosted = state.hosted === true
  const hostedFrame = hosted ? hostedAppFrame(state.url, [resolveSrc('/')]) : null
  // The url comes from the server's own database row, but it is about to become an iframe src, so
  // it is checked for the one shape it can legitimately have.
  const src = hostedFrame
    ? (hostedFrame.ok ? hostedFrame.src : '')
    : typeof state.url === 'string' && /^\/app-bundles\/[A-Za-z0-9_-]+\/$/.test(state.url) ? resolveSrc(state.url) : ''
  // undefined for a bundle: its frame has no origin, and the bridge then goes by the window alone.
  const frameOrigin = hostedFrame ? (hostedFrame.ok ? hostedFrame.origin : '') : undefined
  // The real-origin sandbox only ever goes with a src that hostedAppFrame() passed.
  const realOrigin = !!hostedFrame && hostedFrame.ok

  const setPhaseNow = useCallback((next: 'card' | 'joining' | 'joined') => { phaseRef.current = next; setPhase(next) }, [])

  const join = useCallback(() => {
    if (phaseRef.current !== 'card') return
    setPhaseNow('joining')
    setError('')
    let settled = false
    const fail = (message: string) => { if (aliveRef.current) { setPhaseNow('card'); setError(message) } }
    // An emit made while the socket is down is never acked; do not leave the button spinning.
    const timer = setTimeout(() => { if (!settled) { settled = true; fail('Could not join. Check your connection and try again.') } }, JOIN_TIMEOUT_MS)
    // The iframe is only created once the server has this socket down as joined: from then on it
    // is sent the app's state, and its changes are accepted.
    send({ kind: 'join' }, (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!aliveRef.current) return
      if (result && result.ok === true) { seenSelfRef.current = false; setPhaseNow('joined') }
      else fail(result?.reason === 'not-in-room' ? 'Join the voice channel to use this app.' : 'Could not join. Try again in a moment.')
    })
  }, [setPhaseNow, send])

  const leave = useCallback(() => {
    if (phaseRef.current === 'card') return
    bridgeRef.current?.close('left')
    send({ kind: 'leave' }, () => {})
    setPhaseNow('card')
  }, [setPhaseNow, send])

  // The server no longer counts this client as in the app. A frame left up would be dead — every
  // change refused and rolled back, no state arriving — with nothing to say so; the card, with the
  // reason on it, is the honest thing to show.
  const dropOut = useCallback((reason?: string) => {
    if (!aliveRef.current || phaseRef.current !== 'joined') return
    bridgeRef.current?.close('left')
    setPhaseNow('card')
    setError(reason === 'not-joined' ? '' : LOST_ROOM)
  }, [setPhaseNow])

  // Whoever started the app is joined by the server from the first update. Sending join again is a
  // no-op there, and it lets the starter go through exactly the same confirmed path as anyone else.
  useEffect(() => {
    aliveRef.current = true
    if (autoJoin) join()
    return () => {
      aliveRef.current = false
      // The panel went away while this person was in (they switched view, or the activity ended).
      // The iframe is gone with it, so the room should stop listing them. If the activity itself
      // ended there is nothing to leave, and the sender drops this instead of emitting it.
      if (phaseRef.current !== 'card') send({ kind: 'leave' }, () => {})
    }
    // Mount/unmount only: the parent keys this component per app run, so starting the same app
    // again is a new mount (and a new auto-join for whoever started it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Every update for this app, straight from the socket and in order. The bridge may not exist yet
  // (card showing) or may not have been greeted yet; either way the latest state is kept, and the
  // welcome is built from it.
  useEffect(() => subscribe((event) => {
    if (event.type === 'message') { bridgeRef.current?.pushMessage(event.from, event.data); return }
    // A new socket has joined neither the voice room nor the app, and will be told nothing more
    // about either — including that the old socket was taken off the joined list.
    if (event.type === 'reconnected') { dropOut('not-in-room'); return }
    const a = event.activity
    if (!isRecord(a) || a.type !== 'app' || !isRecord(a.state) || a.state.run !== run) return
    latestRef.current = toLatest(a.state)
    roomRef.current = bridgeRoom(a.state.roomKey)
    bridgeRef.current?.pushState(latestRef.current.shared, latestRef.current.rev, latestRef.current.lastBy)
  }), [subscribe, run, dropOut])

  // The server can also take this socket off the list while it is still connected (the same
  // person's other device does not count as this one). Only once this name HAS been seen in the
  // list, so a name the server spells differently can never bounce someone straight back out.
  const listed = joinedNames.includes(me)
  useEffect(() => {
    if (phase !== 'joined') return
    if (listed) seenSelfRef.current = true
    else if (seenSelfRef.current) setPhaseNow('card')
  }, [phase, listed, setPhaseNow])

  // The bridge lives exactly as long as the iframe. This effect runs in the same commit that puts
  // the iframe on the page, which is before any script inside it can have run, so the listener is
  // there for the app's first hello (and the SDK repeats its hello anyway).
  useEffect(() => {
    if (phase !== 'joined') return undefined
    const bridge = createAppBridge({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      getSnapshot: () => ({ ...peopleRef.current, shared: latestRef.current.shared, rev: latestRef.current.rev, room: roomRef.current }),
      // A hosted app is spoken to at its own origin and nowhere else, and only heard from there.
      frameOrigin,
      transport: {
        // Fixed event kinds: the app supplies the payload and nothing else.
        change: (kind, value, done) => {
          send(kind === 'set' ? { kind: 'set', patch: value } : { kind: 'replace', shared: value }, (result) => {
            done(result)
            if (typeof result?.reason === 'string' && OUT_REASONS.has(result.reason)) dropOut(result.reason)
          })
        },
        emit: (data) => send({ kind: 'emit', data }, (result) => {
          if (typeof result?.reason === 'string' && OUT_REASONS.has(result.reason)) dropOut(result.reason)
        }),
      },
    })
    bridgeRef.current = bridge
    return () => {
      bridge.close('ended')
      bridge.destroy()
      if (bridgeRef.current === bridge) bridgeRef.current = null
    }
  }, [phase, send, dropOut, frameOrigin])

  // After every render, pass on anything the socket path has not already sent: a state that only
  // reached this component as props, and the participant list (which needs names resolved to
  // people, so it comes from render). Deliberately not props of the iframe: the element below
  // never changes once mounted, so an update re-renders this component without reloading the app.
  // The bridge skips what it has already sent.
  useEffect(() => {
    const bridge = bridgeRef.current
    if (!bridge) return
    bridge.pushState(latestRef.current.shared, latestRef.current.rev, latestRef.current.lastBy)
    bridge.pushParticipants(peopleRef.current.participants)
  })

  const name = state.name || 'App'
  // Anything but an explicit yes from the server is treated as not approved.
  const unapproved = state.approved !== true
  const icon = state.iconUrl
    ? <img className="app-activity-icon" src={resolveSrc(state.iconUrl)} alt="" />
    : <span className="app-activity-icon app-activity-icon-fallback">{name.slice(0, 1).toUpperCase()}</span>

  return (
    <div className="activity-panel">
      <div className="activity-head">
        <span className="activity-head-title app-activity-head-title">
          {icon}
          <span className="app-activity-head-name">{name}</span>
          {unapproved && <span className="app-activity-unapproved-chip" title="This app has not been approved by an instance owner">Not approved</span>}
          <span className="activity-by">· started by {by}</span>
        </span>
        <span className="app-activity-head-actions">
          {phase === 'joined' && <button type="button" className="app-activity-leave" onClick={leave} title="Close the app for you. It keeps running for everyone else.">Leave</button>}
          <button type="button" className="activity-close" onClick={onClose} title={`End ${name} for everyone`} aria-label="End for everyone">✕ End</button>
        </span>
      </div>
      <div className="activity-body">
        {phase === 'joined' && src ? (
          <iframe
            ref={frameRef}
            className="app-activity-frame"
            title={name}
            src={src}
            sandbox={realOrigin ? HOSTED_FRAME_SANDBOX : APP_FRAME_SANDBOX}
            allow={realOrigin ? HOSTED_FRAME_ALLOW : APP_FRAME_ALLOW}
            referrerPolicy="no-referrer"
            allowFullScreen
          />
        ) : (
          <div className="app-activity-card-wrap">
            <div className="app-activity-card">
              <div className="app-activity-card-icon">{icon}</div>
              <div className="app-activity-card-name">{name}</div>
              <div className="app-activity-card-meta">Started by {by} · by {state.createdBy || 'someone'}</div>
              {description && <div className="app-activity-card-desc">{description}</div>}
              {unapproved && (
                <div className="app-activity-unapproved" role="note">
                  <b>Not approved yet.</b> This app has not been reviewed by whoever runs this LAN Party. {by} started it to try it out — joining is up to you.
                </div>
              )}
              <div className="app-activity-joined">
                {participants.length > 0
                  ? participants.map((p) => <PersonChip key={p.username} person={p} />)
                  : <span className="app-activity-nobody">Nobody is in yet</span>}
              </div>
              {src
                ? <button type="button" className="app-activity-join" onClick={join} disabled={phase !== 'card'}>{phase === 'card' ? 'Join' : 'Joining…'}</button>
                : <div className="composer-error">{hostedFrame && !hostedFrame.ok && hostedFrame.problem === 'own-origin' ? 'This app’s address is LAN Party’s own, so it can’t run inside it.' : 'This app can’t be opened.'}</div>}
              {error && <div className="composer-error" role="alert">{error}</div>}
              {hostedFrame
                ? <div className="app-activity-note">Community app on its own website{hostedFrame.ok ? <> (<b>{hostedFrame.host}</b>)</> : ''}, not in LAN Party’s sandbox. LAN Party tells it your name and avatar; what you do or type inside it goes to that site.</div>
                : <div className="app-activity-note">Community-uploaded app. It runs in a sandbox and only sees your name and avatar.</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
