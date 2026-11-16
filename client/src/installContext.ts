// Is this page running inside one of LAN Party's installed apps, or on a phone that has one?
//
// Every "Download App" / "Install" prompt asks this first: someone already in the app must not be
// offered it again. The apps are this same site, so the page has to work it out from the outside.
// Each signal below can miss on its own; together they cover the cases that matter, and a miss
// only ever means a download button is shown that need not have been.

/** android/twa/twa-manifest.json `packageId`: the Trusted Web Activity's application id. */
export const ANDROID_PACKAGE = 'com.thejumpvault.lanparty'
/** android/twa/twa-manifest.json `host`. The app's intent filter only claims this host's /app/. */
const ANDROID_APP_HOST = 'lanparty.thejumpvault.com'

const SESSION_KEY = 'lanparty_in_android_app'
const DEVICE_KEY = 'lanparty_android_app_seen'
// How long "the Android app was opened on this device" is believed after the last time it was.
// Nothing tells a web page that an app was uninstalled; this lets the download button come back
// in the browser some weeks after the app stopped being used, rather than never.
const DEVICE_FLAG_TTL_MS = 30 * 24 * 60 * 60 * 1000

export type InstalledKind = 'android-app' | 'desktop-app' | 'installed-web-app'

export interface InstallContext {
  /** Which installed app this page is running in, or null for a plain browser tab. */
  installedIn: InstalledKind | null
  /**
   * A browser tab on an Android device where the LAN Party app was opened recently. The download
   * prompt becomes an "Open in the app" hint there. Never true inside an app (installedIn is set).
   */
  androidAppOnDevice: boolean
}

function readStorage(store: 'session' | 'local', key: string): string | null {
  try { return (store === 'session' ? sessionStorage : localStorage).getItem(key) } catch { return null }
}
function writeStorage(store: 'session' | 'local', key: string, value: string): void {
  // Private browsing and blocked storage throw; the referrer still works for this page load.
  try { (store === 'session' ? sessionStorage : localStorage).setItem(key, value) } catch { /* nothing to keep it in */ }
}

function rememberAndroidAppOnDevice(): void {
  writeStorage('local', DEVICE_KEY, String(Date.now()))
}

/**
 * Inside the Android app (a Trusted Web Activity, see android/).
 *
 * - The TWA's first navigation carries `document.referrer` = "android-app://<package>/". Only that
 *   first document has it: a reload or a later full navigation may not, so it is written to
 *   sessionStorage, which lasts as long as this app window. Chrome keeps a TWA's sessionStorage
 *   apart from its own tabs, so a browser tab never inherits it.
 * - It is also written to localStorage as "the app is on this device". A TWA shares localStorage
 *   with the Chrome tabs of the same site, so that flag is NOT proof of being in the app; it is
 *   only used for androidAppOnDevice. Limit: when the TWA runs on another browser (a phone whose
 *   default is Samsung Internet, say), the Chrome tabs never see it.
 */
function inAndroidApp(): boolean {
  let fromReferrer = false
  try { fromReferrer = document.referrer.startsWith(`android-app://${ANDROID_PACKAGE}`) } catch { /* no document */ }
  if (fromReferrer) {
    writeStorage('session', SESSION_KEY, '1')
    rememberAndroidAppOnDevice()
    return true
  }
  if (readStorage('session', SESSION_KEY) === '1') {
    rememberAndroidAppOnDevice() // still in use: keep the device flag fresh
    return true
  }
  return false
}

/**
 * Inside the Windows desktop shell (desktop/). Its preload exposes `window.desktop.isElectron`,
 * which is what the rest of the client already checks. Electron also leaves "Electron/<version>"
 * in the user agent unless told otherwise, which covers a window opened without that preload.
 */
function inDesktopApp(): boolean {
  if (typeof window === 'undefined') return false
  const bridge = (window as unknown as { desktop?: { isElectron?: boolean } }).desktop
  if (bridge?.isElectron) return true
  return typeof navigator !== 'undefined' && /\bElectron\//.test(navigator.userAgent || '')
}

/**
 * Installed as a web app (Add to Home Screen / Install app), or any window the browser draws
 * without its own address bar. The display-mode media queries match the manifest's `display`
 * once the page runs installed; a TWA usually matches standalone too, but not on every Chrome
 * version, which is why the referrer above is checked separately. iOS Safari reports a home-screen
 * web app through the non-standard navigator.standalone instead.
 */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const mm = window.matchMedia
  if (mm && ['standalone', 'fullscreen', 'minimal-ui'].some((mode) => mm(`(display-mode: ${mode})`).matches)) return true
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true
}

function androidFlagFresh(): boolean {
  const at = Number(readStorage('local', DEVICE_KEY))
  return Number.isFinite(at) && at > 0 && Date.now() - at < DEVICE_FLAG_TTL_MS
}

const isAndroidDevice = () => typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '')

/**
 * What this page is running as, from what can be known at once. Call it early (it records the TWA
 * launch referrer); it is cheap enough to call again. For the slower check that asks the browser
 * which related apps are installed, see findInstalledAndroidApp.
 */
export function detectInstallContext(): InstallContext {
  // Order matters only for the label: any one of them means "installed".
  const installedIn: InstalledKind | null = inAndroidApp()
    ? 'android-app'
    : inDesktopApp()
      ? 'desktop-app'
      : isStandalone() ? 'installed-web-app' : null
  return { installedIn, androidAppOnDevice: !installedIn && isAndroidDevice() && androidFlagFresh() }
}

interface RelatedApp { platform?: string; id?: string; url?: string }

/**
 * In a browser tab on Android: does the browser report the LAN Party app as installed?
 *
 * navigator.getInstalledRelatedApps() (Chrome on Android) lists the apps named in the web
 * manifest's `related_applications` that are installed AND that name this site back in their own
 * `asset_statements`. The manifest names the package; the APK's asset statements name the site
 * (android/twa/app/src/main/res/values/strings.xml). Resolves false wherever the API is missing
 * (every other browser, desktop, iOS) or refuses, so it can only ever hide a prompt, never show one.
 */
export async function findInstalledAndroidApp(): Promise<boolean> {
  const nav = (typeof navigator === 'undefined' ? null : navigator) as (Navigator & { getInstalledRelatedApps?: () => Promise<RelatedApp[]> }) | null
  if (!nav || typeof nav.getInstalledRelatedApps !== 'function') return false
  try {
    const apps = await nav.getInstalledRelatedApps()
    const found = Array.isArray(apps) && apps.some((app) => app && app.id === ANDROID_PACKAGE)
    if (found) rememberAndroidAppOnDevice()
    return found
  } catch {
    return false // not a top-level secure page, or the browser declined: no answer is "don't know"
  }
}

/**
 * A link that opens the Android app from a Chrome tab. An intent: URL naming the package goes
 * straight to the app's launcher activity with the app's own start address, which its intent
 * filter claims. If the app is not there after all, Chrome follows browser_fallback_url, back to
 * this page, rather than sending the person to a Play Store listing that does not exist.
 */
export function androidAppIntentUrl(): string {
  // Without the query or hash: an invite code in this page's address has no business in an intent.
  const fallback = typeof window === 'undefined' ? `https://${ANDROID_APP_HOST}/app/` : `${window.location.origin}${window.location.pathname}`
  return `intent://${ANDROID_APP_HOST}/app/#Intent;scheme=https;package=${ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(fallback)};end`
}
