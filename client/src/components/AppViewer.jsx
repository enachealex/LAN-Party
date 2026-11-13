import React, { useEffect, useRef } from 'react'
import { APP_FRAME_ALLOW, APP_FRAME_SANDBOX, HOSTED_FRAME_ALLOW, HOSTED_FRAME_SANDBOX, createSoloBridge, hostedAppFrame } from '../appBridge'
import { safeLinkUrl } from './AppDirectoryParts'

// Full-window overlay that runs an app on its own, inside an iframe: an uploaded mini-app (a
// bundle), or a hosted app — somebody's own site, set to run inside LAN Party.
//
// Isolation, for a bundle: the iframe carries `sandbox` WITHOUT `allow-same-origin`, so the app
// document is forced into an opaque origin and cannot read LAN Party's cookies/localStorage or call
// the API with the user's session. The server independently sends the same CSP `sandbox` on every
// /app-bundles response, so this holds even if the app is opened directly. `allow` grants only
// opt-in device features (fullscreen/gamepad/autoplay) that games tend to want.
//
// Isolation, for a hosted app: it is a real site and has to be itself (its own storage, its own
// backend), so its frame does get `allow-same-origin`. What keeps it away from LAN Party's session
// is then the browser's ordinary rule between two different origins — which is why a hosted app
// whose address is LAN Party's own is not framed at all (hostedAppFrame in appBridge.ts).
//
// An app written against the SDK (/sdk/lanparty.js) works here too, through the same bridge it gets
// in a voice room, in "solo" form: it is told who is looking, the participant list is just that
// person, there is no room, and its shared state lives in this viewer only — not synced, not saved,
// gone on close.
export default function AppViewer({ app, me, resolveSrc = (u) => u, onClose }) {
  const frameRef = useRef(null)
  // Read when the app says hello, which is long after the render that opened the viewer.
  const meRef = useRef(me)
  meRef.current = me

  useEffect(() => {
    if (!app) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [app, onClose])

  // Which frame this app gets. Plain strings worked out from the app's own url and kind, so every
  // render of the same app arrives at the same ones and the iframe is never handed a new src.
  const hosted = !!app && app.hosted === true
  const hostedFrame = hosted ? hostedAppFrame(app.url, [resolveSrc('/')]) : null
  const src = !app ? '' : hostedFrame ? (hostedFrame.ok ? hostedFrame.src : '') : resolveSrc(app.url)
  // undefined for a bundle: its frame has no origin, and the bridge then goes by the window alone.
  const frameOrigin = hostedFrame && hostedFrame.ok ? hostedFrame.origin : undefined

  // One bridge per viewing, created in the commit that mounts the iframe (so it is listening before
  // the app's first hello) and torn down with it. Keyed on the app, not on `me`: a re-render of the
  // parent must neither reload the frame nor wipe the app's state.
  const appKey = app ? `${app.id}:${hosted ? 'hosted' : 'bundle'}:${app.url}` : null
  useEffect(() => {
    if (!appKey || !src) return undefined
    const bridge = createSoloBridge({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      getMe: () => meRef.current || { username: '', displayName: '', avatarUrl: '' },
      frameOrigin,
    })
    return () => { bridge.close('closed'); bridge.destroy() }
  }, [appKey, src, frameOrigin])

  if (!app) return null
  // "Open in new tab" is the app as anyone would visit it: a hosted app's own address, without the
  // lanparty=1 that only means something inside a frame.
  const tabHref = hosted ? safeLinkUrl(app.url) : src

  return (
    <div className="app-viewer-overlay" role="dialog" aria-modal="true" aria-label={`${app.name || 'App'} viewer`}>
      <div className="app-viewer">
        <div className="app-viewer-header">
          <div className="app-viewer-title">
            {app.iconUrl ? <img className="app-viewer-icon" src={resolveSrc(app.iconUrl)} alt="" /> : <span className="app-viewer-icon app-viewer-icon-fallback">{(app.name || '?').slice(0, 1).toUpperCase()}</span>}
            <div className="app-viewer-name">
              <span>{app.name || 'App'}</span>
              {(app.createdBy || (hostedFrame && hostedFrame.ok)) && (
                <span className="app-viewer-by">
                  {app.createdBy ? `by ${app.createdBy}` : ''}
                  {/* Said where it can be seen: this frame is that site, not a sandboxed upload. */}
                  {hostedFrame && hostedFrame.ok ? `${app.createdBy ? ' · ' : ''}running from ${hostedFrame.host}` : ''}
                </span>
              )}
            </div>
          </div>
          <div className="app-viewer-actions">
            {tabHref && <a className="app-viewer-btn" href={tabHref} target="_blank" rel="noreferrer noopener">Open in new tab ↗</a>}
            <button type="button" className="app-viewer-btn app-viewer-close" onClick={onClose} aria-label="Close app">✕</button>
          </div>
        </div>
        {src ? (
          <iframe
            key={appKey}
            ref={frameRef}
            className="app-viewer-frame"
            title={app.name || 'App'}
            src={src}
            sandbox={frameOrigin ? HOSTED_FRAME_SANDBOX : APP_FRAME_SANDBOX}
            allow={frameOrigin ? HOSTED_FRAME_ALLOW : APP_FRAME_ALLOW}
            referrerPolicy="no-referrer"
            allowFullScreen
          />
        ) : (
          // A hosted app that must not be framed. Nothing is loaded; the reason is said instead.
          <div className="app-viewer-blocked" role="alert">
            <b>This app can’t run inside LAN Party.</b>
            <span>
              {hostedFrame && hostedFrame.problem === 'own-origin'
                ? 'Its address is this LAN Party’s own. An app that runs on its own site has to be on a different one, or it could reach your session here.'
                : 'Its address is not a full https:// web address.'}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
