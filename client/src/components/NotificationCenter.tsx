import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toastKey, type ToastTarget } from './NotificationToasts'

// The bell in the top bar: every message notification, not only the 2-second bubble. Each one is
// recorded here whether or not a bubble was shown (a hidden window gets the desktop notification
// instead), so nothing is missed by looking away. Kept in this browser per account (localStorage),
// newest first, up to MAX_ENTRIES.

export interface NotificationEntry {
  id: string
  key: string
  author: string
  where: string
  preview: string
  previewIsNote?: boolean
  target: ToastTarget
  at: number
  /** More messages from the same conversation folded into this entry while it was unseen. */
  count: number
  seen: boolean
}

export type NewNotificationEntry = Pick<NotificationEntry, 'author' | 'where' | 'preview' | 'previewIsNote' | 'target'>

const MAX_ENTRIES = 50
const storageKey = (user: string) => `lanparty_notifs_${user}`

function load(user: string): NotificationEntry[] {
  if (!user) return []
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey(user)) || '[]')
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.id === 'string' && e.target).slice(0, MAX_ENTRIES) : []
  } catch { return [] }
}

export function useNotificationHistory(user: string) {
  const [entries, setEntries] = useState<NotificationEntry[]>(() => load(user))
  const loadedFor = useRef(user)
  // A different account signed in: its own list.
  useEffect(() => {
    if (loadedFor.current === user) return
    loadedFor.current = user
    setEntries(load(user))
  }, [user])
  useEffect(() => {
    if (!user || loadedFor.current !== user) return
    try { localStorage.setItem(storageKey(user), JSON.stringify(entries)) } catch { /* storage full or blocked */ }
  }, [entries, user])

  const add = useCallback((n: NewNotificationEntry) => {
    const key = toastKey(n.target)
    const at = Date.now()
    setEntries((prev) => {
      const top = prev[0]
      // A run of messages from one conversation is one line ("3 new messages"), until it is seen.
      if (top && top.key === key && !top.seen) {
        return [{ ...top, ...n, at, count: top.count + 1 }, ...prev.slice(1)]
      }
      const entry: NotificationEntry = { ...n, id: `${at}-${Math.random().toString(36).slice(2, 8)}`, key, at, count: 1, seen: false }
      return [entry, ...prev].slice(0, MAX_ENTRIES)
    })
  }, [])

  const markAllSeen = useCallback(() => setEntries((prev) => (prev.some((e) => !e.seen) ? prev.map((e) => (e.seen ? e : { ...e, seen: true })) : prev)), [])
  /** Opening a conversation (however it was opened) means its notifications have been seen. */
  const markSeen = useCallback((target: ToastTarget) => {
    const key = toastKey(target)
    setEntries((prev) => (prev.some((e) => e.key === key && !e.seen) ? prev.map((e) => (e.key === key ? { ...e, seen: true } : e)) : prev))
  }, [])
  const remove = useCallback((id: string) => setEntries((prev) => prev.filter((e) => e.id !== id)), [])
  const clear = useCallback(() => setEntries([]), [])

  // Messages, not lines: three messages folded into one line are still three.
  const unseen = entries.reduce((n, e) => n + (e.seen ? 0 : e.count), 0)
  return { entries, unseen, add, markAllSeen, markSeen, remove, clear }
}

type History = ReturnType<typeof useNotificationHistory>

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  if (d < 7) return `${d}d`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

interface BellProps {
  history: History
  onOpen: (target: ToastTarget) => void
  renderAvatar: (username: string) => ReactNode
}

export default function NotificationBell({ history, onOpen, renderAvatar }: BellProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const { entries, unseen } = history

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: PointerEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // What was unseen when the list opened stays highlighted while it is open; closing it marks them seen.
  const toggle = () => {
    if (open) history.markAllSeen()
    setOpen((v) => !v)
  }
  const close = () => { history.markAllSeen(); setOpen(false) }

  const now = Date.now()
  const label = unseen ? `Notifications, ${unseen} new` : 'Notifications'
  return (
    <div className="nbell" ref={rootRef}>
      <button type="button" className={`topbar-icon-btn nbell-btn${open ? ' active' : ''}`} onClick={toggle} title="Notifications" aria-label={label} aria-expanded={open} aria-haspopup="dialog">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unseen > 0 && <span className="nbell-badge" aria-hidden="true">{unseen > 99 ? '99+' : unseen}</span>}
      </button>
      {open && (
        <div className="nbell-panel" role="dialog" aria-label="Notifications">
          <div className="nbell-head">
            <span className="nbell-title">Notifications</span>
            {entries.length > 0 && <button type="button" className="nbell-clear" onClick={history.clear}>Clear all</button>}
          </div>
          {entries.length === 0 ? (
            <div className="nbell-empty">
              <span aria-hidden="true">🔔</span>
              Nothing yet. Direct messages, mentions and the channels you follow show up here.
            </div>
          ) : (
            <ul className="nbell-list">
              {entries.map((e) => (
                <li key={e.id} className={`nbell-item${e.seen ? '' : ' unseen'}`}>
                  <button type="button" className="nbell-open" onClick={() => { onOpen(e.target); history.markSeen(e.target); close() }}>
                    <span className="nbell-avatar" aria-hidden="true">{renderAvatar(e.author)}</span>
                    <span className="nbell-text">
                      <span className="nbell-line">
                        <span className="nbell-author">{e.author}</span>
                        <span className="nbell-time">{ago(e.at, now)}</span>
                      </span>
                      <span className="nbell-where">{e.where}{e.count > 1 ? ` · ${e.count} new messages` : ''}</span>
                      <span className={`nbell-preview${e.previewIsNote ? ' is-note' : ''}`}>{e.preview}</span>
                    </span>
                  </button>
                  <button type="button" className="nbell-remove" onClick={() => history.remove(e.id)} aria-label={`Remove notification from ${e.author}`} title="Remove">✕</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
