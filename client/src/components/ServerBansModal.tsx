import { useEffect, useRef, useState } from 'react'
import { formatMoment, type AuthedFetch, type ServerBan } from '../moderation'

interface ServerBansModalProps {
  serverId: string
  serverName: string
  authedFetch: AuthedFetch
  onClose: () => void
}

/**
 * "Bans" from a server's menu (owner/admins): who is banned, why, by whom and when, with Unban.
 * The server refuses the list to anyone else; the menu entry is only hidden for them.
 *
 * Unbanning does not put anyone back. Someone who was a member when they were banned is where a
 * kick would have left them, and returns when an admin invites them by name; the note at the foot
 * says so, because "unban" on its own reads as "let back in".
 */
export default function ServerBansModal({ serverId, serverName, authedFetch, onClose }: ServerBansModalProps) {
  const [bans, setBans] = useState<ServerBan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())
  // App.jsx builds a new authedFetch on every render; a ref keeps the load effect from refetching.
  const fetchRef = useRef(authedFetch)
  fetchRef.current = authedFetch

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetchRef.current(`/servers/${encodeURIComponent(serverId)}/bans`)
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok) setBans(Array.isArray(data.bans) ? data.bans : [])
        else setError(data.error || 'Could not load the ban list')
      } catch {
        if (!cancelled) setError('Could not reach the server')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [serverId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const unban = async (username: string) => {
    setBusy((prev) => new Set(prev).add(username))
    setError(null)
    try {
      const res = await fetchRef.current(`/servers/${encodeURIComponent(serverId)}/bans/${encodeURIComponent(username)}`, { method: 'DELETE' })
      // 404 is "not banned": someone else lifted it meanwhile, which is the outcome asked for.
      if (res.ok || res.status === 404) setBans((prev) => prev.filter((b) => b.username !== username))
      else setError((await res.json().catch(() => ({}))).error || `Could not unban ${username}`)
    } catch {
      setError('Could not reach the server')
    } finally {
      setBusy((prev) => { const next = new Set(prev); next.delete(username); return next })
    }
  }

  return (
    <div className="invite-overlay" role="dialog" aria-modal="true" aria-labelledby="bans-title" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="invite-card mod-card">
        <div className="invite-header">
          <span id="bans-title" className="invite-title">Bans in <strong>{serverName}</strong></span>
          <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        {error && <div className="cc-access-error">{error}</div>}
        {loading ? (
          <div className="invite-empty">Loading…</div>
        ) : bans.length === 0 ? (
          <div className="invite-empty">Nobody is banned from this server.</div>
        ) : (
          <ul className="invite-list mod-list">
            {bans.map((ban) => (
              <li key={ban.username} className="invite-row mod-row">
                <div className="mod-row-text">
                  <span className="invite-row-name">{ban.username}</span>
                  <span className="mod-row-meta">
                    Banned{ban.bannedBy ? ` by ${ban.bannedBy}` : ''} · {formatMoment(ban.bannedAt, Date.now(), true)}
                  </span>
                  {ban.reason && <span className="mod-row-reason">Reason: {ban.reason}</span>}
                </div>
                <button type="button" className="invite-add-btn" disabled={busy.has(ban.username)} onClick={() => unban(ban.username)}>
                  {busy.has(ban.username) ? 'Unbanning…' : 'Unban'}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mod-note">
          A banned person cannot rejoin by any invite link or be invited by name. Unbanning lifts that; it does not put
          them back in the server. Invite them by name when you want them back.
        </p>
        <div className="invite-actions">
          <button type="button" className="feedback-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
