import React, { useEffect, useRef, useState } from 'react'

// Centered modal listing public apps and an upload form to publish a new one.
export default function AppDirectoryModal({ open, apps = [], onClose, onUpload, resolveSrc = (u) => u }) {
  const [mode, setMode] = useState('browse') // 'browse' | 'upload'
  const [form, setForm] = useState({ name: '', description: '', url: '' })
  const [iconFile, setIconFile] = useState(null)
  const [iconPreview, setIconPreview] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)
  const iconInputRef = useRef(null)

  // Reset to browse view each time the modal opens.
  useEffect(() => {
    if (open) { setMode('browse'); setForm({ name: '', description: '', url: '' }); setIconFile(null); setError(null) }
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

  const submit = async () => {
    if (!form.name.trim()) { setError('App name is required.'); return }
    setSubmitting(true)
    setError(null)
    try {
      await onUpload({ ...form, iconFile })
      setMode('browse')
      setForm({ name: '', description: '', url: '' })
      setIconFile(null)
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
                      <div className="app-card-name">{app.name}</div>
                      {app.description && <div className="app-card-desc">{app.description}</div>}
                      <div className="app-card-foot">
                        <span className="app-card-by">by {app.createdBy || 'someone'}</span>
                        {app.url && <a className="app-card-try" href={app.url} target="_blank" rel="noreferrer">Try it →</a>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="app-dir-upload">
              <button type="button" className="app-upload-icon-btn" onClick={() => iconInputRef.current?.click()}>
                {iconPreview ? <img src={iconPreview} alt="App icon preview" /> : <span>+ Icon</span>}
              </button>
              <input ref={iconInputRef} type="file" accept="image/*" className="file-input" onChange={(e) => { const f = e.target.files?.[0]; if (f) setIconFile(f); if (e.target) e.target.value = '' }} />
              <label className="app-field-label">App name</label>
              <input className="profile-text-input" value={form.name} maxLength={80} placeholder="My cool app" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              <label className="app-field-label">Description</label>
              <textarea className="profile-textarea" rows={3} maxLength={500} placeholder="What does it do?" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
              <label className="app-field-label">Link (URL)</label>
              <input className="profile-text-input" value={form.url} placeholder="https://…" onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
              {error && <div className="composer-error">{error}</div>}
              <div className="app-dir-actions">
                <button type="button" className="connect-btn" onClick={() => setMode('browse')}>Cancel</button>
                <button type="button" className="connect-btn" onClick={submit} disabled={submitting || !form.name.trim()}>{submitting ? 'Publishing…' : 'Publish App'}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
