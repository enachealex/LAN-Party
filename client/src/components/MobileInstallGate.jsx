import React, { useEffect, useState } from 'react'

// Phones and tablets are steered to the installed (home-screen) app rather than the browser tab:
// standalone mode gets a real app icon, no URL bar stealing vertical space, better background audio
// behaviour, and notification support. This gate is shown on mobile browsers only — never in
// standalone mode, never in the Electron shell, and never on desktop browsers.
//
// Install is only actually possible in some browsers, so the gate always keeps a "continue anyway"
// escape: blocking outright would lock out anyone in an in-app webview (Instagram/Facebook links)
// or a browser without PWA support.

const DISMISS_KEY = 'lanparty_install_gate_dismissed'

/** Is the page already running as an installed app? */
export function isStandalone() {
  if (typeof window === 'undefined') return false
  const mm = window.matchMedia
  const modes = ['standalone', 'minimal-ui', 'fullscreen']
  if (mm && modes.some((m) => mm(`(display-mode: ${m})`).matches)) return true
  return window.navigator.standalone === true // iOS Safari
}

/** Platform facts that decide which instructions to show. */
export function detectPlatform() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent || ''
  const isIOS = /iphone|ipod|ipad/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) // iPadOS reports as Mac
  const isAndroid = /android/i.test(ua)
  // iOS only allows "Add to Home Screen" from Safari; Chrome/Firefox/Edge on iOS cannot install.
  const iosNonSafari = isIOS && /crios|fxios|edgios|opios/i.test(ua)
  // Embedded webviews (opening a link inside another app) can't install either.
  const inAppBrowser = /fban|fbav|instagram|line\/|twitter|micromessenger|snapchat|linkedin/i.test(ua)
  return { isIOS, isAndroid, iosNonSafari, inAppBrowser, isMobile: isIOS || isAndroid }
}

export default function MobileInstallGate({ deferredPrompt, onInstalled, onDismiss }) {
  const [platform] = useState(detectPlatform)
  const [installing, setInstalling] = useState(false)
  const [promptFailed, setPromptFailed] = useState(false)

  // If the app gets installed while this is open, close it immediately.
  useEffect(() => {
    const onAppInstalled = () => onInstalled?.()
    window.addEventListener('appinstalled', onAppInstalled)
    return () => window.removeEventListener('appinstalled', onAppInstalled)
  }, [onInstalled])

  const install = async () => {
    if (!deferredPrompt) return
    setInstalling(true)
    try {
      deferredPrompt.prompt()
      const choice = await deferredPrompt.userChoice
      if (choice?.outcome === 'accepted') onInstalled?.()
      else setPromptFailed(true) // declined — leave the gate up with the manual steps
    } catch (_) {
      setPromptFailed(true)
    } finally {
      setInstalling(false)
    }
  }

  // What the user should actually do, per platform.
  const steps = (() => {
    if (platform.inAppBrowser) {
      return {
        title: 'Open in your browser first',
        lines: ['This link opened inside another app, which can’t install LAN Party.',
                'Tap the ••• menu and choose “Open in browser”, then install from there.'],
      }
    }
    if (platform.iosNonSafari) {
      return {
        title: 'Open in Safari to install',
        lines: ['On iPhone and iPad, only Safari can add apps to the home screen.',
                'Copy this page’s address, open Safari, paste it, then use Share → Add to Home Screen.'],
      }
    }
    if (platform.isIOS) {
      return {
        title: 'Add LAN Party to your home screen',
        lines: ['Tap the Share button at the bottom of Safari.',
                'Choose “Add to Home Screen”, then tap Add.',
                'Open LAN Party from your home screen — it runs like a real app.'],
      }
    }
    return {
      title: 'Install LAN Party',
      lines: ['Tap Install below to add it to your home screen.',
              'If nothing happens, open your browser’s ⋮ menu and choose “Install app” or “Add to Home screen”.'],
    }
  })()

  const canPrompt = !!deferredPrompt && !platform.isIOS

  return (
    <div className="install-gate" role="dialog" aria-modal="true" aria-label="Install LAN Party">
      <div className="install-gate-card">
        <img className="install-gate-logo" src="icons/logo-192.png" alt="" />
        <h1 className="install-gate-title">{steps.title}</h1>
        <p className="install-gate-sub">
          LAN Party works best as an installed app — full screen, its own icon, and voice chat that
          keeps running while you switch away.
        </p>

        {canPrompt && (
          <button type="button" className="install-gate-btn" onClick={install} disabled={installing}>
            {installing ? 'Installing…' : 'Install app'}
          </button>
        )}

        <ol className="install-gate-steps">
          {steps.lines.map((line, i) => <li key={i}>{line}</li>)}
        </ol>

        {promptFailed && (
          <p className="install-gate-note">Install was dismissed — you can still add it from your browser’s menu.</p>
        )}

        <button type="button" className="install-gate-skip" onClick={onDismiss}>
          Continue in the browser
        </button>
      </div>
    </div>
  )
}

/** Has the user chosen to skip the gate for this browser session? */
export function installGateDismissed() {
  try { return sessionStorage.getItem(DISMISS_KEY) === '1' } catch (_) { return false }
}

/** Remember the skip for this session only, so the next visit nudges again. */
export function rememberInstallGateDismissed() {
  try { sessionStorage.setItem(DISMISS_KEY, '1') } catch (_) { /* private mode */ }
}
