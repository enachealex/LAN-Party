import React, { useEffect, useRef, useState } from 'react'

const MAX_BUNDLE_BYTES = 15 * 1024 * 1024 // must match the server's bundleUpload limit

// Centered modal listing public apps and an upload form to publish a new one. An app is either a
// LINK (opens an external URL in a new tab) or an uploaded BUNDLE (a self-contained .html/.zip that
// LAN Party hosts + runs sandboxed inside the in-app viewer).
export default function AppDirectoryModal({ open, apps = [], onClose, onUpload, onRemove, onOpenApp, currentUser = '', resolveSrc = (u) => u }) {
  const [mode, setMode] = useState('browse') // 'browse' | 'upload'
  const [source, setSource] = useState('bundle') // 'bundle' | 'link'
  const [form, setForm] = useState({ name: '', description: '', url: '' })
  const [iconFile, setIconFile] = useState(null)
  const [iconPreview, setIconPreview] = useState(null)
  const [bundleFile, setBundleFile] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const iconInputRef = useRef(null)
  const bundleInputRef = useRef(null)

  // Reset to browse view each time the modal opens.
  useEffect(() => {
    if (open) { setMode('browse'); setSource('bundle'); setForm({ name: '', description: '', url: '' }); setIconFile(null); setBundleFile(null); setError(null) }
  }, [open])

  // Manage the icon preview object URL.
  useEffect(() => {
    if (!iconFile) { setIconPreview(null); return }
    const u = URL.createObjectURL(iconFile)
    setIconPreview(u)
    return () => URL.revokeObjectURL(u)
  }, [iconFile])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const pickBundle = (f) => {
    if (!f) return
    const okExt = /\.(html?|zip)$/i.test(f.name)
    if (!okExt) { setError('Choose a .html file or a .zip bundle.'); return }
    if (f.size > MAX_BUNDLE_BYTES) { setError('Bundle is larger than 15 MB.'); return }
    setError(null)
    setBundleFile(f)
    // Default the name to the file's base name if the user hasn't typed one yet.
    setForm((prev) => (prev.name.trim() ? prev : { ...prev, name: f.name.replace(/\.[^.]+$/, '').slice(0, 80) }))
  }

  const canSubmit = form.name.trim() && (source === 'link' || bundleFile)

  const submit = async () => {
    if (!form.name.trim()) { setError('App name is required.'); return }
    if (source === 'bundle' && !bundleFile) { setError('Choose a .html file or a .zip bundle.'); return }
    setSubmitting(true)
    setError(null)
    try {
      await onUpload({ source, ...form, iconFile, bundleFile })
      setMode('browse')
      setSource('bundle')
      setForm({ name: '', description: '', url: '' })
      setIconFile(null)
      setBundleFile(null)
    } catch (err) {
      setError(err.message || 'Upload failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <div className={`auth-overlay ${open ? 'open' : ''}`} onClick={onClose} />
      <div className={`auth-modal app-directory-modal ${open ? 'open' : ''}`} role="dialog" aria-modal="true" aria-hidden={!open} onClick={(e) => e.stopPropagation()}>
        <div className="app-dir-header">
          <h2>App Directory</h2>
          <button type="button" className="members-close app-dir-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="app-dir-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'browse'} className={`app-dir-tab${mode === 'browse' ? ' active' : ''}`} onClick={() => setMode('browse')}>Browse Apps</button>
          <button type="button" role="tab" aria-selected={mode === 'upload'} className={`app-dir-tab${mode === 'upload' ? ' active' : ''}`} onClick={() => setMode('upload')}>Upload App</button>
        </div>

        <div className="app-dir-body">
          {mode === 'browse' ? (
            apps.length === 0 ? (
              <div className="app-dir-empty">No public apps yet. Be the first to upload one!</div>
            ) : (
              <div className="app-dir-grid">
                {apps.map((app) => (
                  <div className="app-card" key={app.id}>
                    <div className="app-card-icon">
                      {app.iconUrl ? <img src={resolveSrc(app.iconUrl)} alt="" /> : <span>{(app.name || '?').slice(0, 1).toUpperCase()}</span>}
                    </div>
                    <div className="app-card-meta">
                      <div className="app-card-name">
                        {app.name}
                        {app.embeddable && <span className="app-card-badge" title="Runs inside LAN Party">embedded</span>}
                      </div>
                      {app.description && <div className="app-card-desc">{app.description}</div>}
                      <div className="app-card-foot">
                        <span className="app-card-by">by {app.createdBy || 'someone'}</span>
                        {app.embeddable ? (
                          <button type="button" className="app-card-try" onClick={() => onOpenApp?.(app)}>Open →</button>
                        ) : (
                          app.url && <a className="app-card-try" href={app.url} target="_blank" rel="noreferrer">Try it →</a>
                        )}
                        {currentUser && app.createdBy === currentUser && (
                          <button type="button" className="app-card-remove" onClick={() => onRemove?.(app.id)} title="Remove your app">Remove</button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="app-dir-upload">
              <div className="app-source-toggle" role="tablist" aria-label="App type">
                <button type="button" role="tab" aria-selected={source === 'bundle'} className={`app-source-btn${source === 'bundle' ? ' active' : ''}`} onClick={() => { setSource('bundle'); setError(null) }}>Upload a mini-app</button>
                <button type="button" role="tab" aria-selected={source === 'link'} className={`app-source-btn${source === 'link' ? ' active' : ''}`} onClick={() => { setSource('link'); setError(null) }}>Link (external URL)</button>
              </div>

              <button type="button" className="app-upload-icon-btn" onClick={() => iconInputRef.current?.click()}>
                {iconPreview ? <img src={iconPreview} alt="App icon preview" /> : <span>+ Icon</span>}
              </button>
              <input ref={iconInputRef} type="file" accept="image/*" className="file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) setIconFile(f); if (e.target) e.target.value = '' }} />

              <label className="app-field-label">App name</label>
              <input className="profile-text-input" value={form.name} maxLength={80} placeholder="My cool app" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <label className="app-field-label">Description</label>
              <textarea className="profile-textarea" rows={3} maxLength={500} placeholder="What does it do?" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />

              {source === 'link' ? (
                <>
                  <label className="app-field-label">Link (URL)</label>
                  <input className="profile-text-input" value={form.url} placeholder="https://…" onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
                </>
              ) : (
                <>
                  <label className="app-field-label">App bundle</label>
                  <button type="button" className="app-bundle-pick" onClick={() => bundleInputRef.current?.click()}>
                    {bundleFile ? `📦 ${bundleFile.name}` : 'Choose a .html file or .zip bundle…'}
                  </button>
                  <input ref={bundleInputRef} type="file" accept=".html,.htm,.zip,text/html,application/zip" className="file-input" onChange={(e) => { pickBundle(e.target.files?.[0]); if (e.target) e.target.value = '' }} />
                  <div className="app-bundle-hint">A single <code>.html</code> file, or a <code>.zip</code> containing <code>index.html</code> plus its assets. It runs sandboxed inside LAN Party — no access to your account. Max 15 MB.</div>
                </>
              )}

              {error && <div className="composer-error">{error}</div>}
              <div className="app-dir-actions">
                <button type="button" className="connect-btn" onClick={() => setMode('browse')}>Cancel</button>
                <button type="button" className="connect-btn" onClick={submit} disabled={submitting || !canSubmit}>{submitting ? 'Publishing…' : 'Publish App'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
