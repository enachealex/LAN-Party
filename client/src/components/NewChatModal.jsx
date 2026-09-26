import React, { useMemo, useState } from 'react'

function initialsFor(name) {
  return (name || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '?'
}

// Also used to add people to an existing group: pass addToGroupName and the list is just the people
// who aren't in it yet, with no name field.
export default function NewChatModal({ open, users = [], selectedIds = [], groupName = '', addToGroupName = null, busy = false, onToggleUser, onGroupNameChange, onClose, onCreate }) {
  const [query, setQuery] = useState('')
  const selectedCount = selectedIds.length
  const adding = Boolean(addToGroupName)
  const disabled = busy || selectedCount === 0
  const filteredUsers = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return users
    return users.filter((user) => user.name.toLowerCase().includes(term))
  }, [query, users])

  if (!open) return null

  return (
    <div className="new-chat-modal auth-modal open" role="dialog" aria-modal="true" aria-labelledby="new-chat-title">
      <div className="new-chat-inner">
        <div className="new-chat-header">
          <div>
            <h2 id="new-chat-title">{adding ? 'Add people' : 'New Message'}</h2>
            <p>{adding
              ? `Pick who to add to ${addToGroupName}. They'll see the conversation so far.`
              : 'Select one person for a direct message or multiple people for a group chat.'}</p>
          </div>
          <button type="button" className="new-chat-close" onClick={onClose} aria-label="Close new message dialog">
            <svg className="new-chat-close-icon" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <input
          className="new-chat-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people"
          aria-label="Search people"
        />

        {!adding && selectedCount > 1 && (
          <label className="new-chat-group-field">
            <span>Group name (optional)</span>
            <input
              value={groupName}
              maxLength={60}
              onChange={(event) => onGroupNameChange?.(event.target.value)}
              placeholder="Leave empty to use everyone's names"
            />
          </label>
        )}

        <div className="new-chat-list" role="listbox" aria-multiselectable="true">
          {filteredUsers.length === 0 ? (
            <div className="new-chat-empty">{adding && !query.trim() ? 'Everyone you can add is already here.' : 'No matching users.'}</div>
          ) : (
            filteredUsers.map((user) => {
              const checked = selectedIds.includes(String(user.id))
              return (
                <button
                  key={user.id}
                  type="button"
                  className={`new-chat-user ${checked ? 'selected' : ''}`}
                  onClick={() => onToggleUser?.(String(user.id))}
                  role="option"
                  aria-selected={checked}
                >
                  <span className="new-chat-avatar" style={{ background: user.avatar || '#5865f2' }}>{initialsFor(user.name)}</span>
                  <span className="new-chat-user-meta">
                    <span className="new-chat-name">{user.name}</span>
                    <span className="new-chat-status">{user.status || 'available'}</span>
                  </span>
                  <span className="new-chat-check" aria-hidden="true">{checked ? '✓' : ''}</span>
                </button>
              )
            })
          )}
        </div>

        <div className="new-chat-actions">
          <button type="button" className="add-friend-cancel connect-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="connect-btn"
            disabled={disabled}
            aria-disabled={disabled}
            onClick={onCreate}
          >
            {adding ? (busy ? 'Adding…' : 'Add to group') : selectedCount > 1 ? (busy ? 'Creating…' : 'Create Group Chat') : 'Start Chat'}
          </button>
        </div>
      </div>
    </div>
  )
}