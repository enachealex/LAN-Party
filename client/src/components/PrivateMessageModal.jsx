import React, { useEffect, useRef, useState } from 'react'

/**
 * Compose a direct message to one person, opened from a member's right-click menu in a server or a
 * group chat. Sends and closes — the conversation then lives in Messages like any other DM.
 *
 * Send stays disabled until there is something to send: whitespace alone is not a message, and the
 * server rejects it anyway, so the button should not invite a round-trip that can only fail.
 * Cancel, the close button, Escape and the backdrop all dismiss without sending anything.
 */
export default function PrivateMessageModal({ open, recipient, sending = false, error = null, onCancel, onSend }) {
  const [text, setText] = useState('')
  const areaRef = useRef(null)

  // Fresh box each time it opens, so yesterday's abandoned draft never goes to today's recipient.
  useEffect(() => {
    if (!open) return
    setText('')
    const t = setTimeout(() => areaRef.current?.focus(), 40)
    return () => clearTimeout(t)
  }, [open, recipient])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => { if (e.key === 'Escape' && !sending) onCancel?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, sending, onCancel])

  if (!open) return null

  const canSend = Boolean(text.trim()) && !sending
  const submit = () => { if (canSend) onSend?.(text.trim()) }

  return (
    <>
      <div className="auth-overlay open" onClick={() => { if (!sending) onCancel?.() }} />
      <div className="auth-modal pm-modal open" role="dialog" aria-modal="true" aria-label={`Private message to ${recipient?.name || 'user'}`}>
        <div className="pm-modal-inner">
          <div className="pm-modal-head">
            <div className="pm-modal-title">Private message</div>
            <button type="button" className="pm-modal-close" onClick={() => onCancel?.()} disabled={sending} aria-label="Close">✕</button>
          </div>

          <div className="pm-modal-to">
            To <strong>{recipient?.name || recipient?.username}</strong>
          </div>

          <textarea
            ref={areaRef}
            className="pm-modal-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            // Enter inserts a newline — this is a message body, not a search box. Ctrl/Cmd+Enter sends,
            // which is the shortcut people already expect from a compose box with a Send button.
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() } }}
            placeholder={`Write a private message to ${recipient?.name || 'them'}…`}
            rows={5}
            maxLength={2000}
            disabled={sending}
          />

          {error && <div className="pm-modal-error">{error}</div>}
          <div className="pm-modal-hint">Only they will see this. Ctrl+Enter sends.</div>

          <div className="pm-modal-actions">
            <button type="button" className="pm-btn-cancel" onClick={() => onCancel?.()} disabled={sending}>Cancel</button>
            <button type="button" className="pm-btn-send" onClick={submit} disabled={!canSend} aria-disabled={!canSend}>
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
