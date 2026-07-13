import React, { useEffect, useRef, useState } from 'react'

// Modal for creating a channel: name + type (Text/Voice) + privacy (Public/Private).
// Opened from either section's "+" — the clicked section pre-selects the type, but the user can
// switch to make either kind.
export default function CreateChannelModal({ open, initialType = 'text', serverName = 'this server', onCreate, onClose }) {
  const [name, setName] = useState('')
  const [type, setType] = useState(initialType)
  const [privacy, setPrivacy] = useState('public')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  // Reset the form each time the modal opens (and honor the section that was clicked).
  useEffect(() => {
    if (open) {
      setName('')
      setType(initialType === 'voice' ? 'voice' : 'text')
      setPrivacy('public')
      setBusy(false)
      setTimeout(() => inputRef.current?.focus(), 40)
    }
  }, [open, initialType])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const submit = async () => {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    try { await onCreate?.({ name: clean, type, privacy }) }
    finally { setBusy(false) }
  }

  return (
    <div className="cc-overlay" onClick={onClose}>
      <div className="cc-modal" role="dialog" aria-label="Create channel" onClick={(e) => e.stopPropagation()}>
        <div className="cc-title">Create Channel</div>
        <div className="cc-sub">in {serverName}</div>

        <div className="cc-label">Channel type</div>
        <div className="cc-type-row">
          <button type="button" className={`cc-type${type === 'text' ? ' active' : ''}`} onClick={() => setType('text')}>
            <span className="cc-type-glyph">#</span>
            <span className="cc-type-text"><span className="cc-type-name">Text</span><span className="cc-type-hint">Messages, files &amp; GIFs</span></span>
          </button>
          <button type="button" className={`cc-type${type === 'voice' ? ' active' : ''}`} onClick={() => setType('voice')}>
            <span className="cc-type-glyph">🔊</span>
            <span className="cc-type-text"><span className="cc-type-name">Voice</span><span className="cc-type-hint">Talk, video &amp; screen share</span></span>
          </button>
        </div>

        <div className="cc-label">Channel name</div>
        <div className="cc-name-wrap">
          <span className="cc-name-prefix">{type === 'voice' ? '🔊' : '#'}</span>
          <input
            ref={inputRef}
            className="cc-name-input"
            placeholder={type === 'voice' ? 'game-night' : 'new-channel'}
            maxLength={30}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
        </div>

        <div className="cc-label">Privacy</div>
        <div className="cc-priv-row">
          <button type="button" className={`cc-priv${privacy === 'public' ? ' active' : ''}`} onClick={() => setPrivacy('public')}>
            <span className="cc-priv-glyph">🌐</span>
            <span className="cc-type-text"><span className="cc-type-name">Public</span><span className="cc-type-hint">Everyone in {serverName} can see &amp; join</span></span>
          </button>
          <button type="button" className={`cc-priv${privacy === 'private' ? ' active' : ''}`} onClick={() => setPrivacy('private')}>
            <span className="cc-priv-glyph">🔒</span>
            <span className="cc-type-text"><span className="cc-type-name">Private</span><span className="cc-type-hint">Marked with a lock for members</span></span>
          </button>
        </div>

        <div className="cc-footer">
          <button type="button" className="cc-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="cc-create" onClick={submit} disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create Channel'}</button>
        </div>
      </div>
    </div>
  )
}
