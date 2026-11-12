import { useCallback, useEffect, useState } from 'react'

// Web Push on the client: registering this browser so notifications arrive while the app is closed,
// and following a clicked notification to the conversation it was about.
//
// It rides on the existing notifications toggle (lanparty_notify in App.jsx) and adds no setting of
// its own. Everything here is optional equipment: where push cannot work, every function is a quiet
// no-op and the in-page notifications carry on exactly as before. That matters in three places:
// - the Electron desktop shell, which exposes PushManager but has no push service behind it;
// - iOS, where PushManager only exists for a web app installed to the home screen;
// - a server whose web-push module is not installed (GET /push/public-key says available: false).
// None of those is an error, so nothing here ever alerts or throws.

/** The API helper App.jsx already uses for every authenticated call. */
type AuthedFetch = (path: string, opts?: RequestInit) => Promise<Response>

/** Can this browser receive Web Push at all? */
export function pushSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  // The desktop app is always running while it is useful, and its in-page notifications already
  // work. Its PushManager is a stub: subscribe() there fails or never settles.
  if ((window as unknown as { desktop?: { isElectron?: boolean } }).desktop?.isElectron) return false
  return window.isSecureContext === true
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

// Whether this browser is currently registered with the server. Only ever true after the server
// accepted the subscription, so it is safe to act on.
let active = false

/**
 * Should an in-page notification be skipped because a push is covering it? The server pushes DMs,
 * group messages and @mentions to anyone with no focused window, so a background tab that also
 * raised its own would alert twice for one message. Ordinary channel chatter is never pushed, and a
 * focused window is never pushed to, so in both of those cases the in-page one stays.
 */
export function pushCovers(kind: string, mentioned: boolean): boolean {
  if (!active) return false
  if (kind === 'channel' && !mentioned) return false
  return !windowFocused()
}

/** Is this window in front of its user? The same test the server is told about ('presence:focus'). */
export function windowFocused(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

// Subscribing and unsubscribing are each several awaits long, and a sign-out followed straight away
// by a sign-in would otherwise interleave them and leave the wrong one standing. One at a time.
let queue: Promise<unknown> = Promise.resolve()
function serially<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** Resolve with null if `promise` has not settled in time, so a stuck browser API cannot hang us. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => { setTimeout(() => resolve(null), ms) })])
}

/** The VAPID key as the bytes pushManager.subscribe wants (the server sends base64url). */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(existing: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!existing) return false
  const have = new Uint8Array(existing)
  return have.length === wanted.length && have.every((byte, i) => byte === wanted[i])
}

/**
 * Make sure this browser is subscribed and that the server knows it belongs to the signed-in user.
 * Called whenever someone is signed in with the toggle on: at login, on a restored session, and when
 * the toggle is switched on. Re-sending an existing subscription is deliberate — it is how a browser
 * that changed hands moves to its new user, and how the server recovers a row it had pruned.
 * Resolves true only when push is now live for this browser.
 */
export function syncPush(authedFetch: AuthedFetch): Promise<boolean> {
  return serially(async () => {
    active = false
    // Permission is asked for by the toggle (it needs a click); never prompt from here.
    if (!pushSupported() || Notification.permission !== 'granted') return false
    try {
      // main.jsx registers the worker on window load; `ready` waits until one is active.
      const registration = await within(navigator.serviceWorker.ready, 10_000)
      if (!registration) return false
      const res = await authedFetch('/push/public-key')
      if (!res.ok) return false
      const info = await res.json()
      if (!info.available || typeof info.publicKey !== 'string') return false
      const wanted = keyBytes(info.publicKey)

      let subscription = await registration.pushManager.getSubscription()
      // Subscribed against a different server key (the server's keys were replaced, or this browser
      // last used another deployment on the same origin). That subscription can never be delivered
      // to, and the browser refuses to subscribe again while it exists.
      if (subscription && !sameKey(subscription.options.applicationServerKey, wanted)) {
        await subscription.unsubscribe()
        subscription = null
      }
      if (!subscription) {
        subscription = await within(
          registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted }),
          20_000,
        )
      }
      if (!subscription) return false

      const { endpoint, keys } = subscription.toJSON()
      const saved = await authedFetch('/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint, keys }) })
      active = saved.ok
      return active
    } catch {
      // Blocked by the browser, offline, a push service that is unreachable from this network…
      // The toggle still gives in-page notifications, so there is nothing to tell the user.
      return false
    }
  })
}

/**
 * Stop this browser receiving pushes: the toggle was switched off, or the user is signing out — and
 * the next person to sign in on this device must not get the previous one's notifications.
 *
 * Pass `authedFetch` while the session is still valid so the server forgets the subscription at
 * once. Without it (the token is already gone) the local unsubscribe alone is enough: it kills the
 * endpoint, and the server drops its row the first time the push service answers 410.
 */
export function stopPush(authedFetch?: AuthedFetch): Promise<void> {
  return serially(async () => {
    active = false
    if (!pushSupported()) return
    try {
      const registration = await navigator.serviceWorker.getRegistration()
      const subscription = await registration?.pushManager.getSubscription()
      if (!subscription) return
      if (authedFetch) {
        await within(
          authedFetch('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) }).catch(() => null),
          5_000,
        )
      }
      await subscription.unsubscribe()
    } catch { /* nothing to undo, and nothing the user could do about it */ }
  })
}

// ---- Opening what a notification was about ----
// The server puts a destination on every push as /app/?open=<kind>/<ids…>. It reaches the app in one
// of two ways: as the page url when the click had to open a new window, or as a message from the
// service worker when a window was already open (so the running app is steered, not reloaded).

export type OpenTarget =
  | { kind: 'dm'; userId: string; username: string }
  | { kind: 'group'; groupId: string }
  | { kind: 'channel'; serverId: string; channelId: string }
  | { kind: 'requests' }

/** Read the ?open= destination out of a url. Null for anything that is not one we understand. */
export function parseOpenTarget(url: string): OpenTarget | null {
  let raw: string | null = null
  try {
    raw = new URL(url, window.location.href).searchParams.get('open')
  } catch { return null }
  if (!raw) return null
  const [kind, first = '', ...rest] = raw.split('/')
  if (kind === 'requests') return { kind: 'requests' }
  if (kind === 'group' && first && rest.length === 0) return { kind: 'group', groupId: first }
  if (kind === 'channel' && first && rest.length === 1 && rest[0]) return { kind: 'channel', serverId: first, channelId: rest[0] }
  // The username comes last and may itself contain a slash, so it takes whatever is left.
  if (kind === 'dm' && /^\d+$/.test(first) && rest.join('/')) return { kind: 'dm', userId: first, username: rest.join('/') }
  return null
}

/** Take ?open= out of the address bar, leaving every other parameter alone, and return its target. */
function takeTargetFromLocation(): OpenTarget | null {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('open')) return null
    const target = parseOpenTarget(url.href)
    // Removed either way: left in place it would re-open the same conversation on every reload.
    url.searchParams.delete('open')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    return target
  } catch {
    return null
  }
}

/**
 * The conversation a clicked notification wants opened, if any. App.jsx acts on `target` once it is
 * signed in and its lists are loaded, then calls `clear`. Held in memory only: a destination that
 * was not reached in this page load is stale by the next one.
 */
export function useNotificationTarget() {
  const [target, setTarget] = useState<OpenTarget | null>(null)

  useEffect(() => {
    const initial = takeTargetFromLocation()
    if (initial) setTarget(initial)
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return undefined
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; url?: unknown } | null
      if (!data || data.type !== 'lanparty:open' || typeof data.url !== 'string') return
      const next = parseOpenTarget(data.url)
      if (next) setTarget(next)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  const clear = useCallback(() => setTarget(null), [])
  return { target, clear }
}
