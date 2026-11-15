import React, { useEffect, useRef, useState } from 'react'

// Modal for creating a channel: name + type (Text/Voice) + privacy (Public/Private).
// Opened from either section's "+" — the clicked section pre-selects the type, but the user can
// switch to make either kind. When Private is chosen, pick which roles and members get access
// (owner/admins always have access, so they aren't listed). `categoryName` is set when the "+" of
// a category was used: the channel is filed there, which changes nothing about who can open it.
export default function CreateChannelModal({ open, initialType = 'text', serverName = 'this server', categoryName = '', members = [], roles = [], onCreate, onClose }) {
  const [name, setName] = useState('')
  const [type, setType] = useState(initialType)
  const [privacy, setPrivacy] = useState('public')
  const [allowed, setAllowed] = useState([]) // usernames granted access to the private channel
  const [allowedRoles, setAllowedRoles] = useState([]) // ids of the roles granted access to it
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  // Reset the form each time the modal opens (and honor the section that was clicked).
  useEffect(() => {
    if (open) {
      setName('')
      setType(initialType === 'voice' ? 'voice' : 'text')
      setPrivacy('public')
      setAllowed([])
      setAllowedRoles([])
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

  const toggleMember = (username) => {
    setAllowed((prev) => (prev.includes(username) ? prev.filter((u) => u !== username) : [...prev, username]))
  }

  const toggleRole = (roleId) => {
    setAllowedRoles((prev) => (prev.includes(roleId) ? prev.filter((id) => id !== roleId) : [...prev, roleId]))
  }

  const submit = async () => {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    try { await onCreate?.({ name: clean, type, privacy, members: privacy === 'private' ? allowed : [], roles: privacy === 'private' ? allowedRoles : [] }) }
    finally { setBusy(false) }
  }

  return (
    <div className="cc-overlay" onClick={onClose}>
      <div className="cc-modal" role="dialog" aria-label="Create channel" onClick={(e) => e.stopPropagation()}>
        <div className="cc-title">Create Channel</div>
        <div className="cc-sub">in {serverName}{categoryName ? ` › ${categoryName}` : ''}</div>

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
            <span className="cc-type-text"><span className="cc-type-name">Private</span><span className="cc-type-hint">Only you, admins &amp; chosen members</span></span>
          </button>
        </div>

        {privacy === 'private' && roles.length > 0 && (
          <>
            <div className="cc-label">Roles with access {allowedRoles.length > 0 && <span className="cc-count">· {allowedRoles.length} selected</span>}</div>
            <div className="cc-members">
              {roles.map((role) => (
                <button
                  type="button"
                  key={role.id}
                  className={`cc-member${allowedRoles.includes(role.id) ? ' on' : ''}`}
                  onClick={() => toggleRole(role.id)}
                  aria-pressed={allowedRoles.includes(role.id)}
                >
                  <span className="cc-member-check">{allowedRoles.includes(role.id) ? '✓' : ''}</span>
                  <span className="role-dot" style={{ background: role.color || 'transparent' }} aria-hidden="true" />
                  <span className="cc-member-name">{role.name}</span>
                </button>
              ))}
            </div>
            <div className="cc-members-note">Everyone who holds one of these roles can open the channel.</div>
          </>
        )}

        {privacy === 'private' && (
          <>
            <div className="cc-label">Who can access it {allowed.length > 0 && <span className="cc-count">· {allowed.length} selected</span>}</div>
            <div className="cc-members">
              {members.length === 0 ? (
                <div className="cc-members-empty">No other members yet — invite people to the server first, then add them here. You and the server's admins will have access.</div>
              ) : (
                members.map((m) => (
                  <button
                    type="button"
                    key={m.username}
                    className={`cc-member${allowed.includes(m.username) ? ' on' : ''}`}
                    onClick={() => toggleMember(m.username)}
                    aria-pressed={allowed.includes(m.username)}
                  >
                    <span className="cc-member-check">{allowed.includes(m.username) ? '✓' : ''}</span>
                    <span className="cc-member-name">{m.name || m.username}</span>
                  </button>
                ))
              )}
            </div>
            <div className="cc-members-note">Owner &amp; admins always have access.</div>
          </>
        )}

        <div className="cc-footer">
          <button type="button" className="cc-cancel" onClick={onClose}>Cancel</button>
          <button type="button" className="cc-create" onClick={submit} disabled={!name.trim() || busy}>{busy ? 'Creating…' : 'Create Channel'}</button>
        </div>
      </div>
    </div>
  )
}
