import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'

// In-app notification toasts: a bubble in the top-right corner for a message that would otherwise
// go unseen (a DM, a group message, an @mention, or chatter in an "All messages" channel), with a
// Teams-style quick reply. App.jsx decides WHAT is worth a toast (the same rules that decide the
// sound and the desktop notification); this file only shows them.
//
// A toast lasts TOAST_MS. Hovering it, focusing it or opening its reply box stops the clock; it
// starts again from where it was when the pointer or focus leaves and the reply box is closed.

/** Where a toast's conversation is, in the shape App.jsx's openNotificationTarget takes. */
export type ToastTarget =
  | { kind: 'channel'; serverId: string; channelId: string }
  | { kind: 'dm'; userId: string; username: string }
  | { kind: 'group'; groupId: string }

export interface NotificationToast {
  id: number
  /** One toast per conversation: a second message from it updates the toast that is already up. */
  key: string
  /** Bumped by each update, which restarts the toast's clock. */
  seq: number
  author: string
  /** "Server · #channel", "Direct message" or the group's name. */
  where: string
  preview: string
  /** The preview is a description ("sent an image") rather than what they wrote. */
  previewIsNote?: boolean
  target: ToastTarget
}

export type NewNotificationToast = Omit<NotificationToast, 'id' | 'key' | 'seq'>

export const TOAST_MS = 2000
const MAX_VISIBLE = 3
const SENT_MS = 1200

export function toastKey(target: ToastTarget): string {
  if (target.kind === 'channel') return `channel:${target.serverId}:${target.channelId}`
  if (target.kind === 'dm') return `dm:${target.userId || target.username}`
  return `group:${target.groupId}`
}

/** The toast list and what changes it. `push` and `dismiss` are stable, so a socket handler
 *  registered once can keep calling them. */
export function useNotificationToasts() {
  const [toasts, setToasts] = useState<NotificationToast[]>([])
  const nextId = useRef(1)
  // Toasts someone is busy with (reply box open, sending). They are never pushed out by newer ones.
  const engaged = useRef(new Set<number>())

  const push = useCallback((toast: NewNotificationToast) => {
    const key = toastKey(toast.target)
    setToasts((prev) => {
      const existing = prev.find((t) => t.key === key)
      if (existing) {
        // Same conversation: refresh it in place and move it to the top. Its id stays, so a reply
        // being typed into it is kept.
        const updated = { ...existing, ...toast, seq: existing.seq + 1 }
        return [updated, ...prev.filter((t) => t.id !== existing.id)]
      }
      const next = [{ ...toast, id: nextId.current++, key, seq: 0 }, ...prev]
      // Newest first. Past the limit, the oldest one nobody is using goes.
      while (next.length > MAX_VISIBLE) {
        let drop = -1
        for (let i = next.length - 1; i >= 0; i -= 1) {
          if (!engaged.current.has(next[i].id)) { drop = i; break }
        }
        if (drop < 0) break
        next.splice(drop, 1)
      }
      return next
    })
  }, [])

  const dismiss = useCallback((id: number) => {
    engaged.current.delete(id)
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const setEngaged = useCallback((id: number, on: boolean) => {
    if (on) engaged.current.add(id)
    else engaged.current.delete(id)
  }, [])

  const clear = useCallback(() => { engaged.current.clear(); setToasts([]) }, [])

  return { toasts, push, dismiss, setEngaged, clear }
}

interface NotificationToastsProps {
  toasts: NotificationToast[]
  onDismiss: (id: number) => void
  setEngaged: (id: number, on: boolean) => void
  /** Go to the toast's conversation. */
  onOpen: (target: ToastTarget) => void
  /** Send a reply to the toast's conversation. Rejects with the reason when it was not sent. */
  onReply: (target: ToastTarget, text: string) => Promise<void>
  renderAvatar: (username: string) => ReactNode
}

export default function NotificationToasts({ toasts, onDismiss, setEngaged, onOpen, onReply, renderAvatar }: NotificationToastsProps) {
  return (
    <div className="ntoast-stack" role="status" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <ToastItem
          key={t.id}
          toast={t}
          onDismiss={onDismiss}
          setEngaged={setEngaged}
          onOpen={onOpen}
          onReply={onReply}
          renderAvatar={renderAvatar}
        />
      ))}
    </div>
  )
}

type Mode = 'idle' | 'reply' | 'sending' | 'sent'

interface ToastItemProps extends Omit<NotificationToastsProps, 'toasts'> {
  toast: NotificationToast
}

function ToastItem({ toast, onDismiss, setEngaged, onOpen, onReply, renderAvatar }: ToastItemProps) {
  const [mode, setMode] = useState<Mode>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const remaining = useRef(TOAST_MS)
  const seenSeq = useRef(toast.seq)
  const { id } = toast

  const close = useCallback(() => onDismiss(id), [onDismiss, id])

  const busy = mode !== 'idle'
  useEffect(() => { setEngaged(id, busy) }, [setEngaged, id, busy])

  // The clock. Paused while pointed at, focused or in use; a fresh message restarts it.
  const paused = hovered || focused || busy
  useEffect(() => {
    if (seenSeq.current !== toast.seq) { seenSeq.current = toast.seq; remaining.current = TOAST_MS }
    if (paused) return undefined
    const started = Date.now()
    const timer = setTimeout(close, Math.max(0, remaining.current))
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(400, remaining.current - (Date.now() - started))
    }
  }, [paused, toast.seq, close])

  useEffect(() => {
    if (mode !== 'sent') return undefined
    const timer = setTimeout(close, SENT_MS)
    return () => clearTimeout(timer)
  }, [mode, close])

  useEffect(() => {
    if (mode === 'reply') inputRef.current?.focus()
    // Leaving the reply box removes the element that had focus, and the browser does not always
    // say so with a blur: ask where focus is now, or the toast would wait for a blur that never comes.
    else if (mode === 'idle') setFocused(Boolean(rootRef.current?.contains(document.activeElement)))
  }, [mode])

  const cancelReply = () => { setMode('idle'); setText(''); setError('') }

  const send = async () => {
    const body = text.trim()
    if (!body || mode === 'sending') return
    setMode('sending')
    setError('')
    try {
      await onReply(toast.target, body)
      setText('')
      setMode('sent')
    } catch (err) {
      // Kept as typed, with the reason under it, so it can be fixed or tried again.
      setError(err instanceof Error && err.message ? err.message : 'Could not send')
      setMode('reply')
    }
  }

  const onReplyKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelReply() }
  }

  const open = () => { onOpen(toast.target); close() }
  const replyLabel = `Reply to ${toast.author}${toast.target.kind === 'channel' ? ` in ${toast.where}` : ''}`

  return (
    <div
      ref={rootRef}
      className={`ntoast${mode === 'sent' ? ' is-sent' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false) }}
    >
      {mode === 'sent' ? (
        <div className="ntoast-sent"><span aria-hidden="true">✓</span> Sent to {toast.target.kind === 'dm' ? toast.author : toast.where}</div>
      ) : (
        <>
          <button type="button" className="ntoast-body" onClick={open} title="Open the conversation">
            <span className="ntoast-avatar" aria-hidden="true">{renderAvatar(toast.author)}</span>
            <span className="ntoast-text">
              <span className="ntoast-head">
                <span className="ntoast-author">{toast.author}</span>
                <span className="ntoast-where">{toast.where}</span>
              </span>
              <span className={`ntoast-preview${toast.previewIsNote ? ' is-note' : ''}`}>{toast.preview}</span>
            </span>
          </button>
          <button type="button" className="ntoast-close" onClick={close} aria-label="Dismiss notification" title="Dismiss">✕</button>
          {mode === 'idle' ? (
            <div className="ntoast-actions">
              <button type="button" className="ntoast-reply-btn" onClick={() => setMode('reply')}>Reply</button>
            </div>
          ) : (
            <div className="ntoast-reply">
              <textarea
                ref={inputRef}
                className="ntoast-input"
                rows={1}
                value={text}
                maxLength={4000}
                aria-label={replyLabel}
                placeholder={`Reply to ${toast.author}…`}
                disabled={mode === 'sending'}
                onChange={(e) => { setText(e.target.value); if (error) setError('') }}
                onKeyDown={onReplyKey}
              />
              <div className="ntoast-reply-row">
                <span className="ntoast-hint">{mode === 'sending' ? 'Sending…' : 'Enter to send · Esc to cancel'}</span>
                <button type="button" className="ntoast-cancel" onClick={cancelReply} disabled={mode === 'sending'}>Cancel</button>
                <button type="button" className="ntoast-send" onClick={send} disabled={mode === 'sending' || !text.trim()}>Send</button>
              </div>
              {error && <div className="ntoast-error" role="alert">{error}</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
