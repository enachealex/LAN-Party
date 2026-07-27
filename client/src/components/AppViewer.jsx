import React, { useEffect } from 'react'

// Full-window overlay that runs an uploaded mini-app inside a sandboxed iframe.
//
// Isolation: the iframe carries `sandbox` WITHOUT `allow-same-origin`, so the app document is forced
// into an opaque origin and cannot read LAN Party's cookies/localStorage or call the API with the
// user's session. The server independently sends the same CSP `sandbox` on every /app-bundles
// response, so this holds even if the app is opened directly. `allow` grants only opt-in device
// features (fullscreen/gamepad/autoplay) that games tend to want.
export default function AppViewer({ app, resolveSrc = (u) => u, onClose }) {
  useEffect(() => {
    if (!app) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [app, onClose])

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
          className="app-viewer-frame"
          title={app.name || 'App'}
          src={src}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock"
          allow="fullscreen; gamepad; autoplay"
          allowFullScreen
        />
      </div>
    </div>
  )
}
