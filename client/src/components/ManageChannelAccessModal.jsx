import React, { useEffect, useState, useCallback } from 'react'

// Manage who can access an existing PRIVATE channel: the roles on its list (everyone who holds
// one gets in, for as long as they hold it) and the members named on it. Owner/admins and anyone
// whose role manages channels always have access, so they aren't listed — this edits the list only.
export default function ManageChannelAccessModal({ open, serverId, channel, roster = [], roles = [], serverUrl, token, onClose }) {
  const [granted, setGranted] = useState([]) // usernames with access (from the server)
  const [grantedRoles, setGrantedRoles] = useState([]) // ids of the roles on the list
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
      setGrantedRoles(d.roles || [])
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

  // Put a role on the list, or take it off. Taking it off closes the channel at once for every
  // holder with no other way in; the server does that, this only asks.
  const toggleRole = async (roleId, on) => {
    setBusy(`role:${roleId}`); setError('')
    try {
      const r = on
        ? await fetch(`${serverUrl}/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(cid)}/roles`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ roleId }) })
        : await fetch(`${serverUrl}/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(cid)}/roles/${encodeURIComponent(roleId)}`, { method: 'DELETE', headers: auth })
      if (!r.ok) throw new Error((await r.json()).error || (on ? 'Could not add the role' : 'Could not remove the role'))
      setGrantedRoles((g) => (on ? (g.includes(roleId) ? g : [...g, roleId]) : g.filter((id) => id !== roleId)))
    } catch (e) { setError(e.message) } finally { setBusy('') }
  }

  return (
    <div className="cc-overlay" onClick={onClose}>
      <div className="cc-modal" role="dialog" aria-label="Manage channel access" onClick={(e) => e.stopPropagation()}>
        <div className="cc-title">🔑 Manage access</div>
        <div className="cc-sub">for 🔒 {channel.name}</div>

        {error && <div className="cc-access-error">{error}</div>}

        {roles.length > 0 && (
          <>
            <div className="cc-label">Roles with access {grantedRoles.length > 0 && <span className="cc-count">· {grantedRoles.length} added</span>}</div>
            <div className="cc-members">
              {loading ? (
                <div className="cc-members-empty">Loading…</div>
              ) : (
                roles.map((role) => {
                  const on = grantedRoles.includes(role.id)
                  return (
                    <button
                      type="button"
                      key={role.id}
                      className={`cc-member${on ? ' on' : ''}`}
                      disabled={busy === `role:${role.id}`}
                      onClick={() => toggleRole(role.id, !on)}
                      aria-pressed={on}
                    >
                      <span className="cc-member-check">{on ? '✓' : ''}</span>
                      <span className="role-dot" style={{ background: role.color || 'transparent' }} aria-hidden="true" />
                      <span className="cc-member-name">{role.name}</span>
                      {busy === `role:${role.id}` && <span className="cc-member-busy">…</span>}
                    </button>
                  )
                })
              )}
            </div>
            <div className="cc-members-note">Everyone who holds one of these roles can open the channel, for as long as they hold it.</div>
          </>
        )}

        <div className="cc-label">{roles.length > 0 ? 'Members with access' : 'Who can access it'} {granted.length > 0 && <span className="cc-count">· {granted.length} added</span>}</div>
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
