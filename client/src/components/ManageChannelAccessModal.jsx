import React, { useEffect, useState, useCallback } from 'react'

// Manage which members can access an existing PRIVATE channel. Owner/admins always have access,
// so they aren't listed — this edits the explicit-grant list only.
export default function ManageChannelAccessModal({ open, serverId, channel, roster = [], serverUrl, token, onClose }) {
  const [granted, setGranted] = useState([]) // usernames with access (from the server)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('') // username currently being toggled

  const cid = channel?.id
  const auth = { Authorization: `Bearer ${token}` }

  const load = useCallback(async () => {
    if (!open || !cid) return
    setLoading(true); setError('')
    try {
      const r = await fetch(`${serverUrl}/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(cid)}/members`, { headers: auth })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Could not load access list')
      setGranted(d.members || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cid, serverId, serverUrl, token])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || !channel) return null

  // Members who can be added: everyone on the roster except staff (they always have access) and self.
  const addable = roster.filter((m) => m.username && m.role !== 'owner' && m.role !== 'admin')

  const grant = async (username) => {
    setBusy(username); setError('')
    try {
      const r = await fetch(`${serverUrl}/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(cid)}/members`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ username }),
      })
      if (!r.ok) throw new Error((await r.json()).error || 'Could not add member')
      setGranted((g) => (g.includes(username) ? g : [...g, username]))
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }
  const revoke = async (username) => {
    setBusy(username); setError('')
    try {
      const r = await fetch(`${serverUrl}/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(cid)}/members/${encodeURIComponent(username)}`, { method: 'DELETE', headers: auth })
      if (!r.ok) throw new Error((await r.json()).error || 'Could not remove member')
      setGranted((g) => g.filter((u) => u !== username))
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  return (
    <div className="cc-overlay" onClick={onClose}>
      <div className="cc-modal" role="dialog" aria-label="Manage channel access" onClick={(e) => e.stopPropagation()}>
        <div className="cc-title">🔑 Manage access</div>
        <div className="cc-sub">for 🔒 {channel.name}</div>

        {error && <div className="cc-access-error">{error}</div>}

        <div className="cc-label">Who can access it {granted.length > 0 && <span className="cc-count">· {granted.length} added</span>}</div>
        <div className="cc-members">
          {loading ? (
            <div className="cc-members-empty">Loading…</div>
          ) : addable.length === 0 ? (
            <div className="cc-members-empty">No other members yet — invite people to the server first, then grant them access here. You and the server's admins always have access.</div>
          ) : (
            addable.map((m) => {
              const on = granted.includes(m.username)
              return (
                <button
                  type="button"
                  key={m.username}
                  className={`cc-member${on ? ' on' : ''}`}
                  disabled={busy === m.username}
                  onClick={() => (on ? revoke(m.username) : grant(m.username))}
                  aria-pressed={on}
                >
                  <span className="cc-member-check">{on ? '✓' : ''}</span>
                  <span className="cc-member-name">{m.name || m.username}</span>
                  {busy === m.username && <span className="cc-member-busy">…</span>}
                </button>
              )
            })
          )}
        </div>
        <div className="cc-members-note">Owner &amp; admins always have access. Changes save immediately.</div>

        <div className="cc-footer">
          <button type="button" className="cc-create" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
