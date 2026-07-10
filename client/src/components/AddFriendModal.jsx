import React, { useEffect, useState } from 'react'

export default function AddFriendModal({
  open,
  username,
  onUsernameChange,
  onClose,
  onSend,
  loading,
  error,
  userExists,
  userChecking,
  isSelf,
}) {
  const [debounced, setDebounced] = useState(username)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(username), 400)
    return () => clearTimeout(t)
  }, [username])

  useEffect(() => {
    if (open) return undefined
    setDebounced('')
  }, [open])

  const showField = debounced.trim().length > 0
  const showOk = showField && !userChecking && userExists === true && !isSelf
  const showErr = showField && !userChecking && (userExists === false || isSelf)

  return (
    <>
      <div className={`auth-overlay ${open ? 'open' : ''}`} onClick={onClose} aria-hidden={!open} />
      <div
        className={`auth-modal add-friend-modal ${open ? 'open' : ''}`}
        role="dialog"
        aria-labelledby="add-friend-title"
        aria-hidden={!open}
      >
        <div className="add-friend-inner">
          <div className="add-friend-header">
            <h2 id="add-friend-title">Add a Friend</h2>
            <button type="button" className="members-close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
          <p className="add-friend-hint">You can add friends with their LAN Party username.</p>
          <label className="add-friend-label" htmlFor="add-friend-username">
            Username
          </label>
          <div className="add-friend-input-wrap">
            <input
              id="add-friend-username"
              type="text"
              className={`add-friend-input ${showErr ? 'input-error' : showOk ? 'input-ok' : ''}`}
              value={username}
              onChange={(e) => onUsernameChange(e.target.value)}
              placeholder="Enter a username"
              autoComplete="off"
              disabled={loading}
            />
            {showOk && (
              <span className="add-friend-field-icon ok" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
            {showErr && (
              <span className="add-friend-field-icon error" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
          </div>
          {isSelf && showField && !userChecking && (
            <div className="field-error-message">You cannot add yourself</div>
          )}
          {userExists === false && showField && !userChecking && !isSelf && (
            <div className="field-error-message">No user found with that username</div>
          )}
          {error && <div className="auth-error">{error}</div>}
          <div className="add-friend-actions">
            <button type="button" className="connect-btn add-friend-cancel" onClick={onClose} disabled={loading}>
              Cancel
            </button>
            <button
              type="button"
              className="connect-btn"
              onClick={onSend}
              disabled={loading || !showOk}
              aria-disabled={loading || !showOk}
            >
              {loading ? 'Sending...' : 'Send Friend Request'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
