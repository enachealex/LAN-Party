// "Check app": a quick diagnostic for the person who uploaded a bundle. It loads the app once in a
// frame nobody can see, with the same solo bridge the viewer uses, watches for a few seconds and
// says three plain things: did the page load, did it say hello to the bridge, did it set any state.
//
// It is NOT a review of the app. Nothing here looks at what the code does, and a clean result says
// nothing about whether the app is safe or will be approved.
import { createSoloBridge, type BridgePerson } from './appBridge'

// Deliberately narrower than the viewer's sandbox (APP_FRAME_SANDBOX), and with no `allow` list:
// nobody can see or touch this frame, so it must not be able to put up an alert, open a window or
// start playing sound. A frame's sandbox can only ever be narrowed — the server's CSP on
// /app-bundles still applies on top — and there is no allow-same-origin, as everywhere else.
const CHECK_SANDBOX = 'allow-scripts allow-forms'
/** How long the app is watched. The SDK gives up on its host after 1.5 s by default, so a hello
 *  that is coming has come long before this. */
export const APP_CHECK_MS = 6000
// Once the app has both said hello and set state there is nothing left to wait for; this short
// pause only lets a state set in the same breath be counted.
const SETTLE_MS = 400

export interface AppCheckResult {
  /** The frame's load event fired. */
  loaded: boolean
  /** What the server answered for the app's page, when that could be asked; null when it could not. */
  httpStatus: number | null
  /** The app said hello to the bridge, i.e. the SDK is in the page and connect() was called. */
  hello: boolean
  /** How many accepted setState/replaceState calls were seen. */
  stateChanges: number
  /** Keys in the shared state when the check ended. */
  stateKeys: number
  /** How long the app was watched, in milliseconds. */
  watchedMs: number
}

export interface AppCheckRun {
  /** Resolves with the result, or with null when the check was cancelled. Never rejects. */
  done: Promise<AppCheckResult | null>
  /** Stop now and remove the frame. Safe to call at any time, any number of times. */
  cancel: () => void
}

/** Start a check of the bundle at `src` (an absolute or same-origin /app-bundles/<dir>/ url). */
export function startAppCheck({ src, me }: { src: string; me: BridgePerson }): AppCheckRun {
  const startedAt = Date.now()
  const result: AppCheckResult = { loaded: false, httpStatus: null, hello: false, stateChanges: 0, stateKeys: 0, watchedMs: 0 }
  let finished = false
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let resolveDone: (r: AppCheckResult | null) => void = () => {}
  const done = new Promise<AppCheckResult | null>((resolve) => { resolveDone = resolve })

  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', CHECK_SANDBOX)
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('tabindex', '-1')
  frame.title = 'App check'
  // Off screen rather than display:none, with a real size: an app that measures its window or
  // waits for an animation frame before starting should behave as it would when shown.
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:800px;height:600px;border:0;visibility:hidden;pointer-events:none'

  const bridge = createSoloBridge({
    getFrameWindow: () => frame.contentWindow,
    getMe: () => me,
    watch: {
      onHello: () => { result.hello = true; settleSoon() },
      onStateChange: (keys) => { result.stateChanges += 1; result.stateKeys = keys; settleSoon() },
    },
  })

  // The one way out, whatever ended the check: the bridge stops listening and the frame (and the
  // app running in it) is taken off the page.
  function finish(cancelled: boolean) {
    if (finished) return
    finished = true
    clearTimeout(deadline)
    if (settleTimer) clearTimeout(settleTimer)
    frame.removeEventListener('load', onLoad)
    bridge.close('closed')
    bridge.destroy()
    frame.remove()
    result.watchedMs = Date.now() - startedAt
    resolveDone(cancelled ? null : result)
  }
  function settleSoon() {
    if (finished || settleTimer || !result.hello || result.stateChanges === 0) return
    settleTimer = setTimeout(() => finish(false), SETTLE_MS)
  }
  const onLoad = () => { result.loaded = true }
  frame.addEventListener('load', onLoad)
  const deadline = setTimeout(() => finish(false), APP_CHECK_MS)

  // A frame's load event fires for an error page too, so the server is also asked directly what
  // it answers for the page. Best effort: if that cannot be asked, the result just says less.
  fetch(src, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' })
    .then((res) => { if (!finished) result.httpStatus = res.status })
    .catch(() => { /* unknown; the load event is all there is */ })

  frame.src = src
  document.body.appendChild(frame)

  return { done, cancel: () => finish(true) }
}
