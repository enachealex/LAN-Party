import { useCallback, useEffect, useRef, useState } from 'react'

// Arriving through an invite link: <origin>/app/?invite=CODE.
//
// The code is taken out of the address bar straight away (so it is not left in history, bookmarks
// or a screenshot) and parked in sessionStorage. That is what carries it across the login or
// register step for someone who arrives signed out: the join is offered the moment they are in.
// sessionStorage rather than localStorage on purpose, so an invite somebody opened and ignored does
// not reappear in a later session.

/** The API helper App.jsx already uses for every authenticated call. */
type AuthedFetch = (path: string, opts?: RequestInit) => Promise<Response>

/** Everything GET /invites/:code is willing to say about a server to someone who is not in it. */
export interface InvitePreview {
  name: string
  iconUrl: string | null
  memberCount: number
}

export type InviteJoinState =
  | { status: 'none' }
  | { status: 'loading'; code: string }
  | { status: 'ready'; code: string; server: InvitePreview; joining: boolean; error: string | null }
  /** The lookup itself could not be made (offline, rate limited). The code is kept for a retry. */
  | { status: 'failed'; code: string; error: string }
  /** Revoked, expired, used up or never real. The server does not say which, and neither do we. */
  | { status: 'invalid' }

/** What POST /invites/:code/accept hands back once the caller is a member. */
export interface JoinedServer {
  server: { id: string; name: string; iconUrl: string | null }
  alreadyMember: boolean
}

const STORAGE_KEY = 'lanparty_pending_invite'
const CODE_RE = /^[A-Za-z0-9_-]{10,64}$/ // same shape check as server/routes/invites.js
const INVALID_TEXT = 'This invite link is invalid or has expired.'

// Storage throws in some private-browsing modes. An invite that cannot be remembered still works
// for someone already signed in, so never let that take the page down.
const stored = {
  get: () => { try { return sessionStorage.getItem(STORAGE_KEY) } catch { return null } },
  set: (code: string) => { try { sessionStorage.setItem(STORAGE_KEY, code) } catch { /* see above */ } },
  clear: () => { try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* see above */ } },
}

/**
 * Read the pending invite: from the URL if this page load came through a link, otherwise whatever
 * an earlier load in this tab parked. Always removes `invite` from the address bar, and leaves every
 * other parameter alone (the reset/deactivate email links read theirs from the same query string).
 */
function takePendingInvite(): { code: string | null; malformed: boolean } {
  let fromUrl: string | null = null
  try {
    const url = new URL(window.location.href)
    fromUrl = url.searchParams.get('invite')
    if (fromUrl !== null) {
      url.searchParams.delete('invite')
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    }
  } catch { /* no usable URL: fall through to storage */ }

  if (fromUrl !== null) {
    const code = fromUrl.trim()
    if (!CODE_RE.test(code)) return { code: null, malformed: true }
    stored.set(code)
    return { code, malformed: false }
  }
  const kept = stored.get()
  if (kept && CODE_RE.test(kept)) return { code: kept, malformed: false }
  return { code: null, malformed: false }
}

/**
 * Owns the pending invite for the lifetime of the page. `serverUrl` is the API origin ('' when the
 * client is served by the server itself).
 */
export function useInviteJoin(serverUrl: string) {
  const [state, setState] = useState<InviteJoinState>({ status: 'none' })
  // Bumped by every lookup, so a slow answer to an older one can never overwrite a newer result.
  const lookupSeq = useRef(0)

  const lookup = useCallback(async (code: string) => {
    const seq = ++lookupSeq.current
    setState({ status: 'loading', code })
    try {
      // No Authorization header: this has to work for a visitor who has no account yet.
      const res = await fetch(`${serverUrl}/invites/${encodeURIComponent(code)}`)
      const data = await res.json().catch(() => ({}))
      if (seq !== lookupSeq.current) return
      if (res.ok && data.valid && data.server) {
        setState({ status: 'ready', code, server: data.server, joining: false, error: null })
      } else if (res.status === 404) {
        stored.clear() // a dead link must not be offered again after login
        setState({ status: 'invalid' })
      } else {
        setState({ status: 'failed', code, error: data.error || 'Could not check this invite link.' })
      }
    } catch {
      if (seq === lookupSeq.current) setState({ status: 'failed', code, error: 'Could not reach the server to check this invite link.' })
    }
  }, [serverUrl])

  useEffect(() => {
    const pending = takePendingInvite()
    if (pending.malformed) { setState({ status: 'invalid' }); return }
    if (pending.code) lookup(pending.code)
  }, [lookup])

  const dismiss = useCallback(() => {
    lookupSeq.current += 1 // drop any lookup still in flight
    stored.clear()
    setState({ status: 'none' })
  }, [])

  const retry = useCallback(() => {
    if (state.status === 'failed') lookup(state.code)
  }, [state, lookup])

  /** Join the server. Resolves with where the caller landed, or null if it did not go through. */
  const accept = useCallback(async (authedFetch: AuthedFetch): Promise<JoinedServer | null> => {
    if (state.status !== 'ready' || state.joining) return null
    const pending = state
    setState({ ...pending, joining: true, error: null })
    try {
      const res = await authedFetch(`/invites/${encodeURIComponent(pending.code)}/accept`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.server) {
        stored.clear()
        setState({ status: 'none' })
        return { server: data.server, alreadyMember: !!data.alreadyMember }
      }
      if (res.status === 404) {
        // It was valid when the dialog opened and is not now: revoked, or someone took the last use.
        stored.clear()
        setState({ status: 'invalid' })
        return null
      }
      setState({ ...pending, joining: false, error: data.error || 'Could not join the server.' })
      return null
    } catch {
      setState({ ...pending, joining: false, error: 'Could not reach the server.' })
      return null
    }
  }, [state])

  return { state, accept, dismiss, retry }
}

interface ServerBadgeProps {
  server: InvitePreview
  resolveSrc: (url: string) => string
}

// The server as a stranger is allowed to see it: icon (or its initial), name, head count.
function ServerBadge({ server, resolveSrc }: ServerBadgeProps) {
  const members = server.memberCount === 1 ? '1 member' : `${server.memberCount} members`
  return (
    <div className="invite-join-server">
      {server.iconUrl ? (
        <img className="invite-join-icon" src={resolveSrc(server.iconUrl)} alt="" draggable={false} />
      ) : (
        <span className="invite-join-icon" aria-hidden="true">{(server.name || '?').slice(0, 1).toUpperCase()}</span>
      )}
      <div className="invite-join-text">
        <div className="invite-join-name">{server.name}</div>
        <div className="invite-join-meta">{members}</div>
      </div>
    </div>
  )
}

interface InviteJoinNoticeProps {
  invite: InviteJoinState
  onDismiss: () => void
  onRetry: () => void
  resolveSrc?: (url: string) => string
}

/**
 * Shown on the sign-in screen to a visitor who followed an invite link while signed out, so they
 * can see what they were invited to before deciding to log in or make an account.
 */
export function InviteJoinNotice({ invite, onDismiss, onRetry, resolveSrc = (u) => u }: InviteJoinNoticeProps) {
  if (invite.status === 'none') return null
  return (
    <div className={`invite-join-notice${invite.status === 'invalid' || invite.status === 'failed' ? ' bad' : ''}`} role="status">
      {invite.status === 'loading' && <div className="invite-join-line">Checking your invite link…</div>}
      {invite.status === 'ready' && (
        <>
          <div className="invite-join-line">You’ve been invited to join</div>
          <ServerBadge server={invite.server} resolveSrc={resolveSrc} />
          <div className="invite-join-line">Log in or create an account and you’ll be asked to join.</div>
        </>
      )}
      {invite.status === 'invalid' && <div className="invite-join-line">{INVALID_TEXT} Ask whoever sent it for a new one.</div>}
      {invite.status === 'failed' && (
        <div className="invite-join-line">
          {invite.error} <button type="button" className="invite-join-link" onClick={onRetry}>Try again</button>
        </div>
      )}
      {invite.status !== 'loading' && (
        <button type="button" className="invite-join-dismiss" onClick={onDismiss} aria-label="Dismiss invite">✕</button>
      )}
    </div>
  )
}

interface InviteJoinDialogProps {
  /** False while something else owns the screen (not signed in yet, boot splash, onboarding). */
  open: boolean
  invite: InviteJoinState
  onAccept: () => void
  onDismiss: () => void
  onRetry: () => void
  resolveSrc?: (url: string) => string
}

/**
 * The confirm step for a signed-in user: "Join <server>?". Nobody is added to a server just by
 * opening a URL, because a link can be disguised and a click on one is not consent to join.
 * Also carries the bad news when the link turns out to be dead.
 */
export default function InviteJoinDialog({ open, invite, onAccept, onDismiss, onRetry, resolveSrc = (u) => u }: InviteJoinDialogProps) {
  const joining = invite.status === 'ready' && invite.joining
  // Nothing to show while the lookup is in flight: it is quick, and a dialog that flashes up empty
  // and then fills in reads as a glitch.
  const visible = open && (invite.status === 'ready' || invite.status === 'invalid' || invite.status === 'failed')

  useEffect(() => {
    if (!visible) return undefined
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !joining) onDismiss() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [visible, joining, onDismiss])

  if (!visible) return null

  return (
    <>
      <div className="auth-overlay open" onClick={() => { if (!joining) onDismiss() }} />
      <div className="auth-modal pm-modal open" role="dialog" aria-modal="true" aria-label="Server invite">
        <div className="pm-modal-inner">
          <div className="pm-modal-head">
            <div className="pm-modal-title">Server invite</div>
            <button type="button" className="pm-modal-close" onClick={onDismiss} disabled={joining} aria-label="Close">✕</button>
          </div>

          {invite.status === 'ready' && (
            <>
              <div className="invite-join-question">Join <strong>{invite.server.name}</strong>?</div>
              <ServerBadge server={invite.server} resolveSrc={resolveSrc} />
              {invite.error && <div className="pm-modal-error" role="alert">{invite.error}</div>}
              <div className="pm-modal-actions">
                <button type="button" className="pm-btn-cancel" onClick={onDismiss} disabled={joining}>Not now</button>
                <button type="button" className="pm-btn-send" onClick={onAccept} disabled={joining}>
                  {joining ? 'Joining…' : 'Join server'}
                </button>
              </div>
            </>
          )}

          {invite.status === 'invalid' && (
            <>
              <div className="invite-join-question">That invite didn’t work</div>
              <div className="pm-modal-hint">{INVALID_TEXT} Ask whoever sent it for a new one.</div>
              <div className="pm-modal-actions">
                <button type="button" className="pm-btn-send" onClick={onDismiss} autoFocus>OK</button>
              </div>
            </>
          )}

          {invite.status === 'failed' && (
            <>
              <div className="invite-join-question">Couldn’t check that invite</div>
              <div className="pm-modal-error" role="alert">{invite.error}</div>
              <div className="pm-modal-actions">
                <button type="button" className="pm-btn-cancel" onClick={onDismiss}>Cancel</button>
                <button type="button" className="pm-btn-send" onClick={onRetry} autoFocus>Try again</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}
