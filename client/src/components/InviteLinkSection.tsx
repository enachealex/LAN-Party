import { useEffect, useRef, useState } from 'react'

/** The API helper App.jsx already uses for every authenticated call. */
type AuthedFetch = (path: string, opts?: RequestInit) => Promise<Response>

/** One link, as POST/GET /servers/:id/invites return it. */
interface InviteLink {
  code: string
  /** `/app/?invite=CODE`. Appended to this page's origin to make the shareable URL. */
  path: string
  createdBy: string
  createdAt: number
  /** ms timestamp, or null for a link that never expires. */
  expiresAt: number | null
  /** null for unlimited. */
  maxUses: number | null
  uses: number
}

interface InviteLinkSectionProps {
  serverId: string
  authedFetch: AuthedFetch
}

// The three choices offered. The server accepts any whole number of hours up to 30 days; these are
// the ones people actually want, and "never" is sent as null rather than a huge number.
const EXPIRY_CHOICES = [
  { id: '24', label: '1 day', hours: 24 },
  { id: '168', label: '7 days', hours: 168 },
  { id: 'never', label: 'Never', hours: null },
] as const
type ExpiryId = (typeof EXPIRY_CHOICES)[number]['id']

const MAX_USES_LIMIT = 1000 // mirrors INVITE_MAX_USES in server/validation.js

// The link always points at the page the admin is looking at: the LAN address for someone on the
// LAN, the public hostname for someone coming through the tunnel. The server cannot know which.
const linkUrl = (link: InviteLink) => `${window.location.origin}${link.path}`

function expiryText(expiresAt: number | null, now: number): string {
  if (expiresAt == null) return 'never expires'
  const hours = (expiresAt - now) / 3_600_000
  if (hours <= 0) return 'expired'
  if (hours < 1) return 'expires in under an hour'
  if (hours < 36) return `expires in ${Math.round(hours)}h`
  return `expires in ${Math.round(hours / 24)} days`
}

function usesText(link: InviteLink): string {
  if (link.maxUses != null) return `${link.uses} / ${link.maxUses} uses`
  return link.uses === 1 ? '1 use' : `${link.uses} uses`
}

// navigator.clipboard only exists on https and localhost. This app is routinely opened over plain
// http on a LAN address, where it is undefined, so fall back to the selection-based copy.
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* permission denied or not focused: try the fallback */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

/**
 * The "Invite link" block of the invite dialog, shown to owner/admins only: mint a link, copy it,
 * and see or revoke the ones still live. Adding a friend by name (the list above this) needs them to
 * have an account already; a link works for anyone it is sent to.
 */
export default function InviteLinkSection({ serverId, authedFetch }: InviteLinkSectionProps) {
  const [links, setLinks] = useState<InviteLink[]>([])
  const [loading, setLoading] = useState(true)
  const [expiry, setExpiry] = useState<ExpiryId>('168')
  const [maxUses, setMaxUses] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The link just made. It gets its own field so it can be copied without opening the list.
  const [fresh, setFresh] = useState<InviteLink | null>(null)
  const [showList, setShowList] = useState(false)
  const [revoking, setRevoking] = useState<Set<string>>(new Set())
  const freshInputRef = useRef<HTMLInputElement | null>(null)
  // Confirmation is shown inside the section, not through the app toast: the toast sits underneath
  // this dialog's dimmed, blurred backdrop, where "copied" would go unread.
  const [note, setNote] = useState<string | null>(null)
  const noteTimer = useRef<number | undefined>(undefined)
  const flash = (text: string) => {
    setNote(text)
    window.clearTimeout(noteTimer.current)
    noteTimer.current = window.setTimeout(() => setNote(null), 2600)
  }
  useEffect(() => () => window.clearTimeout(noteTimer.current), [])

  // App.jsx builds a new authedFetch on every render. Reading it through a ref keeps the load
  // effect below from re-running (and refetching the list) each time the parent re-renders.
  const fetchRef = useRef(authedFetch)
  fetchRef.current = authedFetch

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLinks([])
    setFresh(null)
    setError(null)
    ;(async () => {
      try {
        const res = await fetchRef.current(`/servers/${encodeURIComponent(serverId)}/invites`)
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (res.ok) setLinks(Array.isArray(data.invites) ? data.invites : [])
        else setError(data.error || 'Could not load invite links')
      } catch {
        if (!cancelled) setError('Could not reach the server')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [serverId])

  const copy = async (link: InviteLink) => {
    if (await copyText(linkUrl(link))) { flash('Link copied'); return }
    // Nothing could write to the clipboard. Put the link where it can be copied by hand.
    setFresh(link)
    setTimeout(() => { freshInputRef.current?.focus(); freshInputRef.current?.select() }, 0)
    flash('Could not copy automatically. The link is selected for you.')
  }

  const create = async () => {
    if (creating) return
    setError(null)
    const wanted = maxUses.trim()
    const uses = wanted ? Number(wanted) : null
    // Checked here only so the message appears next to the field; the server enforces the same range.
    if (uses !== null && (!Number.isInteger(uses) || uses < 1 || uses > MAX_USES_LIMIT)) {
      setError(`Max uses must be a whole number between 1 and ${MAX_USES_LIMIT}`)
      return
    }
    const hours = EXPIRY_CHOICES.find((c) => c.id === expiry)?.hours ?? null
    setCreating(true)
    try {
      const res = await fetchRef.current(`/servers/${encodeURIComponent(serverId)}/invites`, {
        method: 'POST',
        body: JSON.stringify({ expiresInHours: hours, maxUses: uses }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.invite) { setError(data.error || 'Could not create the link'); return }
      const link: InviteLink = data.invite
      setLinks((prev) => [link, ...prev])
      setFresh(link)
      setMaxUses('')
      // Copy straight away: the reason to make a link is to paste it somewhere.
      flash((await copyText(linkUrl(link))) ? 'Link created and copied' : 'Link created')
    } catch {
      setError('Could not reach the server')
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (link: InviteLink) => {
    if (!window.confirm('Revoke this invite link? Anyone who has it will no longer be able to join with it.')) return
    setError(null)
    setRevoking((prev) => new Set(prev).add(link.code))
    try {
      const res = await fetchRef.current(`/servers/${encodeURIComponent(serverId)}/invites/${encodeURIComponent(link.code)}`, { method: 'DELETE' })
      // A 404 means it is already gone (revoked from another tab), which is what was asked for.
      if (res.ok || res.status === 404) {
        setLinks((prev) => prev.filter((l) => l.code !== link.code))
        setFresh((prev) => (prev?.code === link.code ? null : prev))
        flash('Link revoked')
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Could not revoke the link')
      }
    } catch {
      setError('Could not reach the server')
    } finally {
      setRevoking((prev) => { const next = new Set(prev); next.delete(link.code); return next })
    }
  }

  const now = Date.now()

  return (
    <div className="invite-link-section">
      <div className="invite-link-title">Invite link</div>
      <div className="invite-link-hint">Anyone with the link can join as a member, even without an account yet.</div>

      <div className="invite-link-controls">
        <label className="invite-link-field">
          <span>Expires after</span>
          <select value={expiry} onChange={(e) => setExpiry(e.target.value as ExpiryId)} disabled={creating}>
            {EXPIRY_CHOICES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label className="invite-link-field">
          <span>Max uses</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_USES_LIMIT}
            step={1}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create() } }}
            placeholder="No limit"
            disabled={creating}
          />
        </label>
        <button type="button" className="invite-add-btn" onClick={create} disabled={creating}>
          {creating ? 'Creating…' : 'Create link'}
        </button>
      </div>

      {error && <div className="invite-link-error" role="alert">{error}</div>}
      {note && <div className="invite-link-note" role="status">{note}</div>}

      {fresh && (
        <div className="invite-link-fresh">
          <input
            ref={freshInputRef}
            className="invite-link-url"
            type="text"
            readOnly
            value={linkUrl(fresh)}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Invite link"
          />
          <button type="button" className="invite-link-btn" onClick={() => copy(fresh)}>Copy</button>
        </div>
      )}

      {loading ? (
        <div className="invite-loading">Loading links…</div>
      ) : links.length > 0 && (
        <>
          <button type="button" className="invite-link-toggle" aria-expanded={showList} onClick={() => setShowList((v) => !v)}>
            {showList ? '▾' : '▸'} Active links ({links.length})
          </button>
          {showList && (
            <ul className="invite-link-list">
              {links.map((link) => (
                <li key={link.code} className="invite-link-row">
                  <div className="invite-link-row-main">
                    {/* The tail is enough to tell two links apart; the whole code is one Copy away. */}
                    <span className="invite-link-code" title={linkUrl(link)}>…{link.code.slice(-6)}</span>
                    <span className="invite-link-meta">{usesText(link)} · {expiryText(link.expiresAt, now)} · by {link.createdBy}</span>
                  </div>
                  <div className="invite-link-row-actions">
                    <button type="button" className="invite-link-btn" onClick={() => copy(link)}>Copy</button>
                    <button type="button" className="invite-link-btn danger" disabled={revoking.has(link.code)} onClick={() => revoke(link)}>
                      {revoking.has(link.code) ? 'Revoking…' : 'Revoke'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
