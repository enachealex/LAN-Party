import { useEffect, useRef, useState } from 'react'
import { describeAudit, formatMoment, type AuditEntry, type AuthedFetch } from '../moderation'

interface AuditLogModalProps {
  serverId: string
  serverName: string
  authedFetch: AuthedFetch
  onClose: () => void
}

// A screenful or so. The server sends at most 100 per page.
const PAGE = 40

/**
 * "Audit log" from a server's menu (owner/admins): who did what to whom, newest first, a page at a
 * time. It records moderation and management (kicks, bans, timeouts, roles, channels, invite
 * links), never what anyone wrote. The server refuses it to anyone who is not staff.
 */
export default function AuditLogModal({ serverId, serverName, authedFetch, onClose }: AuditLogModalProps) {
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const fetchRef = useRef(authedFetch)
  fetchRef.current = authedFetch
  // Which load is current. A page that comes back after the dialog moved on to another server (or
  // after a newer request) is dropped rather than appended to the wrong list.
  const loadSeq = useRef(0)

  const load = async (before: number | null) => {
    const seq = ++loadSeq.current
    setLoading(true)
    setError(null)
    try {
      const cursor = before ? `&before=${before}` : ''
      const res = await fetchRef.current(`/servers/${encodeURIComponent(serverId)}/audit?limit=${PAGE}${cursor}`)
      const data = await res.json().catch(() => ({}))
      if (seq !== loadSeq.current) return
      if (!res.ok) { setError(data.error || 'Could not load the audit log'); return }
      const page: AuditEntry[] = Array.isArray(data.entries) ? data.entries : []
      setEntries((prev) => (before ? [...prev, ...page.filter((e) => !prev.some((p) => p.id === e.id))] : page))
      setHasMore(!!data.hasMore)
    } catch {
      if (seq === loadSeq.current) setError('Could not reach the server')
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }

  useEffect(() => {
    setEntries([])
    setHasMore(false)
    load(null)
    return () => { loadSeq.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const oldest = entries.length ? entries[entries.length - 1].id : null

  return (
    <div className="invite-overlay" role="dialog" aria-modal="true" aria-labelledby="audit-title" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="invite-card mod-card mod-card-wide">
        <div className="invite-header">
          <span id="audit-title" className="invite-title">Audit log of <strong>{serverName}</strong></span>
          <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {error && <div className="cc-access-error">{error}</div>}
        {entries.length === 0 && !loading && !error ? (
          <div className="invite-empty">Nothing has been recorded yet.</div>
        ) : (
          <ul className="invite-list mod-list mod-audit-list">
            {entries.map((entry) => (
              <li key={entry.id} className="mod-audit-row">
                <span className="mod-audit-text">{describeAudit(entry)}</span>
                <time className="mod-row-meta" dateTime={new Date(entry.ts).toISOString()}>{formatMoment(entry.ts, Date.now(), true)}</time>
              </li>
            ))}
            {loading && <li className="invite-loading">Loading…</li>}
            {!loading && hasMore && oldest != null && (
              <li className="mod-audit-more">
                <button type="button" className="feedback-btn ghost" onClick={() => load(oldest)}>Load older entries</button>
              </li>
            )}
          </ul>
        )}
        <p className="mod-note">Who did what, and when. Messages are never recorded here. Only owners and admins can read it.</p>
        <div className="invite-actions">
          <button type="button" className="feedback-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
