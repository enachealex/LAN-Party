// Noticing that a newer build of the app has been deployed while this one is still on screen.
//
// A fresh load always gets the newest build (the service worker fetches the page network-first).
// The problem is a page that is never loaded again: the desktop app sits in the tray for days with
// "Run in background" on, an installed phone app is resumed rather than relaunched, a browser tab is
// left open. "Opening" any of those just shows the page that was already there.
//
// A build is identified by the hashed asset files its index.html points at, so there is nothing to
// keep in step by hand: the deployed index.html IS the statement of what the current build is.

const ASSET = /assets\/[\w.-]+\.(?:js|css)/g

function signature(found: Iterable<string>): string {
  return Array.from(new Set(found)).sort().join('|')
}

// What this page was built from: the hashed assets its own document loaded.
function runningBuild(): string {
  const urls: string[] = []
  document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]').forEach((el) => {
    const url = el.getAttribute('src') || el.getAttribute('href') || ''
    const match = url.match(ASSET)
    if (match) urls.push(...match)
  })
  return signature(urls)
}

const RELOADED_FOR = 'lanparty_reloaded_for'

/**
 * Resolves to the deployed build's signature when it differs from the one running, otherwise null.
 * Null also covers "could not tell" (offline, an error page, the dev server): never guess.
 */
export async function findNewerBuild(): Promise<string | null> {
  if (import.meta.env.DEV) return null
  const running = runningBuild()
  if (!running) return null
  try {
    // no-store plus a throwaway query: this must be the server's answer, not any cache's.
    const url = new URL(import.meta.env.BASE_URL || '/', window.location.origin)
    url.searchParams.set('build-check', String(Date.now()))
    const res = await fetch(url.toString(), { cache: 'no-store', credentials: 'omit' })
    if (!res.ok) return null
    const deployed = signature((await res.text()).match(ASSET) || [])
    if (!deployed || deployed === running) return null
    return deployed
  } catch {
    return null
  }
}

/**
 * True if this page already reloaded to pick up `build` and still is not running it — a stale cache
 * somewhere between here and the server. Reloading again would loop, so the caller should only offer
 * the reload, not perform it.
 */
export function alreadyReloadedFor(build: string): boolean {
  try { return sessionStorage.getItem(RELOADED_FOR) === build } catch { return false }
}

export function reloadForBuild(build: string): void {
  try { sessionStorage.setItem(RELOADED_FOR, build) } catch { /* private mode: the worst case is one extra reload */ }
  window.location.reload()
}
