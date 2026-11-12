import React, { useEffect, useRef } from 'react'
import { APP_FRAME_ALLOW, APP_FRAME_SANDBOX, createSoloBridge } from '../appBridge'

// Full-window overlay that runs an uploaded mini-app inside a sandboxed iframe.
//
// Isolation: the iframe carries `sandbox` WITHOUT `allow-same-origin`, so the app document is forced
// into an opaque origin and cannot read LAN Party's cookies/localStorage or call the API with the
// user's session. The server independently sends the same CSP `sandbox` on every /app-bundles
// response, so this holds even if the app is opened directly. `allow` grants only opt-in device
// features (fullscreen/gamepad/autoplay) that games tend to want.
//
// An app written against the SDK (/sdk/lanparty.js) works here too, through the same bridge it gets
// in a voice room, in "solo" form: it is told who is looking, the participant list is just that
// person, and its shared state lives in this viewer only — not synced, not saved, gone on close.
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

  // One bridge per viewing, created in the commit that mounts the iframe (so it is listening before
  // the app's first hello) and torn down with it. Keyed on the app, not on `me`: a re-render of the
  // parent must neither reload the frame nor wipe the app's state.
  const appKey = app ? `${app.id}:${app.url}` : null
  useEffect(() => {
    if (!appKey) return undefined
    const bridge = createSoloBridge({
      getFrameWindow: () => frameRef.current?.contentWindow ?? null,
      getMe: () => meRef.current || { username: '', displayName: '', avatarUrl: '' },
    })
    return () => { bridge.close('closed'); bridge.destroy() }
  }, [appKey])

  if (!app) return null
  const src = resolveSrc(app.url)

  return (
    <div className="app-viewer-overlay" role="dialog" aria-modal="true" aria-label={`${app.name || 'App'} viewer`}>
      <div className="app-viewer">
        <div className="app-viewer-header">
          <div className="app-viewer-title">
            {app.iconUrl ? <img className="app-viewer-icon" src={resolveSrc(app.iconUrl)} alt="" /> : <span className="app-viewer-icon app-viewer-icon-fallback">{(app.name || '?').slice(0, 1).toUpperCase()}</span>}
            <div className="app-viewer-name">
              <span>{app.name || 'App'}</span>
              {app.createdBy && <span className="app-viewer-by">by {app.createdBy}</span>}
            </div>
          </div>
          <div className="app-viewer-actions">
            <a className="app-viewer-btn" href={src} target="_blank" rel="noreferrer noopener">Open in new tab ↗</a>
            <button type="button" className="app-viewer-btn app-viewer-close" onClick={onClose} aria-label="Close app">✕</button>
          </div>
        </div>
        <iframe
          key={appKey}
          ref={frameRef}
          className="app-viewer-frame"
          title={app.name || 'App'}
          src={src}
          sandbox={APP_FRAME_SANDBOX}
          allow={APP_FRAME_ALLOW}
          referrerPolicy="no-referrer"
          allowFullScreen
        />
      </div>
    </div>
  )
}
