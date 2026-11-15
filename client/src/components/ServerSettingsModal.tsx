import { useEffect, useRef, useState } from 'react'
import type { AuthedFetch, AskConfirm } from '../moderation'
import { PERMISSIONS, assignableRoles, mayManageRole, type RoleHolder, type ServerRole } from '../permissions'

interface ServerSettingsModalProps {
  serverId: string
  serverName: string
  currentUsername: string
  authedFetch: AuthedFetch
  /** In-app confirm (App.jsx askConfirm): the desktop app has no window.confirm. */
  askConfirm: AskConfirm
  /** Changes whenever the server's roles or who holds them change elsewhere, so the list reloads. */
  syncKey?: string
  onClose: () => void
}

type RoleWithMembers = ServerRole & { members: string[] }
interface RolesData {
  roles: RoleWithMembers[]
  members: { username: string; role: string; roles: string[] }[]
  myRole: string
  myPermissions: string[]
  maxRoles: number
}
interface Draft { name: string; color: string; permissions: string[] }

// Colours that read well on the dark panels. Any hex colour can be typed instead.
const SWATCHES = ['#e0574d', '#faa61a', '#f1c40f', '#3ba55c', '#57f287', '#29b6f6', '#5865f2', '#7e57c2', '#eb459e', '#95a5a6']
const HEX = /^#[0-9a-f]{6}$/i
const ROLE_NAME_MAX = 32 // mirrors server/routes/roles.js

const draftOf = (role: ServerRole): Draft => ({ name: role.name, color: role.color || '', permissions: role.permissions || [] })
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/**
 * "Server settings" from a server's menu. One tab so far, Roles: the server's custom roles in
 * rank order, what each permits, and who holds it.
 *
 * Every member of the server may open it and read the roles (they are what the member list
 * already shows). Changing anything needs the Manage roles permission, a role below your own
 * highest one, and, for handing a role out, a member ranked below you. A control the viewer may
 * not use is disabled and says why. All of that is only what to show: the server checks every
 * request again (server/routes/roles.js).
 */
export default function ServerSettingsModal({ serverId, serverName, currentUsername, authedFetch, askConfirm, syncKey, onClose }: ServerSettingsModalProps) {
  const [data, setData] = useState<RolesData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  // App.jsx builds a new authedFetch on every render; a ref keeps the load effect from refetching.
  const fetchRef = useRef(authedFetch)
  fetchRef.current = authedFetch
  const base = `/servers/${encodeURIComponent(serverId)}`

  const load = async (): Promise<RolesData | null> => {
    try {
      const res = await fetchRef.current(`${base}/roles`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error || 'Could not load the roles'); return null }
      const next: RolesData = {
        roles: Array.isArray(body.roles) ? body.roles : [],
        members: Array.isArray(body.members) ? body.members : [],
        myRole: body.myRole || 'member',
        myPermissions: Array.isArray(body.myPermissions) ? body.myPermissions : [],
        maxRoles: typeof body.maxRoles === 'number' ? body.maxRoles : 50,
      }
      setData(next)
      return next
    } catch {
      setError('Could not reach the server')
      return null
    }
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => { const next = await load(); if (cancelled || !next) return })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, syncKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const roles = data?.roles || []
  const selected = roles.find((r) => r.id === selectedId) || null
  // Keep a role selected, and start its form from what the server holds. The form is only reset
  // when a different role is picked: a reload behind an edit in progress must not wipe it.
  useEffect(() => {
    if (!data) return
    if (!selected) {
      const first = data.roles[0] || null
      setSelectedId(first ? first.id : null)
      setDraft(first ? draftOf(first) : null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedId])
  const pick = (role: RoleWithMembers) => { setSelectedId(role.id); setDraft(draftOf(role)); setError(null) }

  const perms = new Set(data?.myPermissions || [])
  const me = data?.members.find((m) => m.username === currentUsername)
  const viewer: RoleHolder = { username: currentUsername, role: data?.myRole || 'member', roles: me?.roles || [] }
  const managesRoles = perms.has('manage_roles')
  const manageable = (role: ServerRole) => mayManageRole(viewer, perms, role, roles)
  const whyNot = (role: ServerRole) => (managesRoles
    ? 'This role is at or above your own highest role, so you cannot change it'
    : 'Changing roles needs the Manage roles permission')

  // One request, then the list again: the server is the only place the order and the ranks live.
  const send = async (path: string, init: RequestInit, failure: string): Promise<Record<string, any> | null> => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetchRef.current(`${base}${path}`, init)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) { setError(body.error || failure); return null }
      await load()
      return body
    } catch {
      setError('Could not reach the server')
      return null
    } finally {
      setBusy(false)
    }
  }

  const createRole = async () => {
    const body = await send('/roles', { method: 'POST', body: JSON.stringify({ name: 'New role', permissions: [] }) }, 'Could not create the role')
    if (body?.role) { setSelectedId(body.role.id); setDraft(draftOf(body.role)) }
  }
  const moveRole = (role: ServerRole, direction: 'up' | 'down') =>
    send(`/roles/${encodeURIComponent(role.id)}/move`, { method: 'POST', body: JSON.stringify({ direction }) }, 'Could not move the role')
  const saveRole = async () => {
    if (!selected || !draft) return
    const changes: Record<string, unknown> = {}
    if (draft.name.trim() !== selected.name) changes.name = draft.name.trim()
    if ((draft.color || null) !== (selected.color || null)) changes.color = draft.color || null
    if (selected.permissions && !sameSet(draft.permissions, selected.permissions)) changes.permissions = draft.permissions
    const body = await send(`/roles/${encodeURIComponent(selected.id)}`, { method: 'PATCH', body: JSON.stringify(changes) }, 'Could not save the role')
    if (body?.role) setDraft(draftOf(body.role))
  }
  const deleteRole = async () => {
    if (!selected) return
    const holders = selected.members.length
    const ok = await askConfirm({
      title: `Delete the role “${selected.name}”?`,
      message: `${holders === 0 ? 'Nobody holds it.' : `${holders} member${holders === 1 ? ' holds' : 's hold'} it, and will lose what it permits and any private channel that only this role opened for them.`} This cannot be undone.`,
      submitLabel: 'Delete role',
    })
    if (!ok) return
    const done = await send(`/roles/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }, 'Could not delete the role')
    if (done) { setSelectedId(null); setDraft(null) }
  }
  const toggleHolder = (username: string, on: boolean) => {
    if (!selected) return
    return send(`/members/${encodeURIComponent(username)}/roles/${encodeURIComponent(selected.id)}`, { method: on ? 'PUT' : 'DELETE' }, on ? `Could not give ${username} the role` : `Could not take the role from ${username}`)
  }

  const canEdit = !!selected && manageable(selected)
  const colorOk = !draft || draft.color === '' || HEX.test(draft.color)
  const nameOk = !!draft && draft.name.trim().length >= 1 && draft.name.trim().length <= ROLE_NAME_MAX
  const dirty = !!selected && !!draft && (
    draft.name.trim() !== selected.name
    || (draft.color || null) !== (selected.color || null)
    || (!!selected.permissions && !sameSet(draft.permissions, selected.permissions))
  )
  const atLimit = roles.length >= (data?.maxRoles || 50)

  return (
    <div className="invite-overlay" role="dialog" aria-modal="true" aria-labelledby="server-settings-title" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="invite-card srv-settings-card">
        <div className="invite-header">
          <span id="server-settings-title" className="invite-title">Server settings · <strong>{serverName}</strong></span>
          <button type="button" className="invite-close" aria-label="Close" onClick={onClose}>✕</button>
        </div>
        <div className="srv-settings-tabs" role="tablist" aria-label="Server settings">
          <button type="button" role="tab" aria-selected="true" className="srv-settings-tab active">Roles</button>
        </div>
        {error && <div className="cc-access-error" role="alert">{error}</div>}
        {!data ? (
          <div className="invite-empty">{error ? 'The roles could not be loaded.' : 'Loading…'}</div>
        ) : (
          <div className="srv-settings-body" role="tabpanel" aria-label="Roles">
            <div className="roles-list-pane">
              <p className="mod-note roles-intro">
                Highest first. A role outranks every role below it; people can only act on members and roles ranked below their own.
              </p>
              <ul className="roles-list">
                <li className="roles-row roles-row-fixed" title="The owner can do everything, and nobody can act on them">
                  <span className="roles-row-name">👑 Owner</span><span className="roles-row-meta">everything</span>
                </li>
                <li className="roles-row roles-row-fixed" title="Admins hold every permission. Only the owner makes or removes an admin, from the member list">
                  <span className="roles-row-name">🛡️ Admin</span><span className="roles-row-meta">every permission</span>
                </li>
                {roles.map((role, index) => {
                  const mine = manageable(role)
                  const above = roles[index - 1]
                  const canUp = mine && !!above && manageable(above)
                  const canDown = mine && index < roles.length - 1
                  return (
                    <li key={role.id} className={`roles-row ${role.id === selectedId ? 'active' : ''}`}>
                      <button type="button" className="roles-row-pick" aria-current={role.id === selectedId} onClick={() => pick(role)}>
                        <span className="role-dot" style={{ background: role.color || 'transparent' }} aria-hidden="true" />
                        <span className="roles-row-name" style={role.color ? { color: role.color } : undefined}>{role.name}</span>
                        <span className="roles-row-meta">{role.members.length}</span>
                      </button>
                      <button type="button" className="roles-move" aria-label={`Move ${role.name} up`} disabled={busy || !canUp}
                        title={canUp ? 'Move up' : !mine ? whyNot(role) : above ? 'The role above is at or above your own' : 'Already the highest role'} onClick={() => moveRole(role, 'up')}>▲</button>
                      <button type="button" className="roles-move" aria-label={`Move ${role.name} down`} disabled={busy || !canDown}
                        title={canDown ? 'Move down' : !mine ? whyNot(role) : 'Already the lowest role'} onClick={() => moveRole(role, 'down')}>▼</button>
                    </li>
                  )
                })}
                <li className="roles-row roles-row-fixed" title="Members with no role have none of the permissions below">
                  <span className="roles-row-name">Everyone else</span><span className="roles-row-meta">no permissions</span>
                </li>
              </ul>
              <button type="button" className="feedback-btn ghost roles-new" disabled={busy || !managesRoles || atLimit}
                title={!managesRoles ? 'Creating roles needs the Manage roles permission' : atLimit ? `A server can have at most ${data.maxRoles} roles` : 'A new role starts at the bottom, with no permissions'}
                onClick={createRole}>+ New role</button>
              {!managesRoles && <p className="mod-note">You can see this server’s roles here. Changing them needs the Manage roles permission.</p>}
              {managesRoles && atLimit && <p className="mod-note">This server has as many roles as it can have ({data.maxRoles}).</p>}
            </div>

            <div className="roles-edit-pane">
              {!selected || !draft ? (
                <div className="invite-empty">{roles.length === 0 ? 'This server has no custom roles yet.' : 'Pick a role to see it.'}</div>
              ) : (
                <>
                  {!canEdit && <p className="mod-note roles-locked">{whyNot(selected)}.</p>}
                  <label className="cc-label" htmlFor="role-name">Role name</label>
                  <input id="role-name" className="feedback-input roles-name-input" maxLength={ROLE_NAME_MAX} value={draft.name} disabled={!canEdit || busy}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })} />

                  <div className="cc-label">Colour <span className="roles-hint">— names of people whose highest coloured role this is are shown in it</span></div>
                  <div className="roles-swatches">
                    <button type="button" className={`roles-swatch roles-swatch-none ${draft.color === '' ? 'active' : ''}`} disabled={!canEdit || busy} title="No colour" aria-label="No colour" onClick={() => setDraft({ ...draft, color: '' })}>∅</button>
                    {SWATCHES.map((c) => (
                      <button key={c} type="button" className={`roles-swatch ${draft.color.toLowerCase() === c ? 'active' : ''}`} style={{ background: c }} disabled={!canEdit || busy} title={c} aria-label={`Colour ${c}`} onClick={() => setDraft({ ...draft, color: c })} />
                    ))}
                    <input className="feedback-input roles-hex" aria-label="Hex colour" placeholder="#rrggbb" maxLength={7} value={draft.color} disabled={!canEdit || busy}
                      onChange={(e) => setDraft({ ...draft, color: e.target.value.trim() })} />
                  </div>
                  {!colorOk && <p className="roles-field-error">A colour is written like #3ba55c.</p>}

                  <div className="cc-label">Permissions</div>
                  {!selected.permissions ? (
                    <p className="mod-note">What a role permits is shown to people who manage roles.</p>
                  ) : (
                    <ul className="roles-perms">
                      {PERMISSIONS.map((p) => {
                        const on = draft.permissions.includes(p.id)
                        // Only adding is granting: a permission the role already carries can be taken off.
                        const cannotGrant = !on && !perms.has(p.id)
                        const disabled = !canEdit || busy || cannotGrant
                        return (
                          <li key={p.id}>
                            <label className={`roles-perm ${disabled ? 'disabled' : ''}`} title={canEdit && cannotGrant ? 'You do not hold this permission yourself, so you cannot grant it' : undefined}>
                              <input type="checkbox" checked={on} disabled={disabled}
                                onChange={() => setDraft({ ...draft, permissions: on ? draft.permissions.filter((x) => x !== p.id) : [...draft.permissions, p.id] })} />
                              <span className="roles-perm-text">
                                <span className="roles-perm-name">{p.label}</span>
                                <span className="roles-perm-desc">{p.description}</span>
                                {canEdit && cannotGrant && <span className="roles-perm-why">You do not hold this permission, so you cannot grant it.</span>}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  <div className="roles-actions">
                    <button type="button" className="feedback-btn ghost roles-delete" disabled={!canEdit || busy} title={canEdit ? undefined : whyNot(selected)} onClick={deleteRole}>Delete role</button>
                    <button type="button" className="feedback-btn primary" disabled={!canEdit || busy || !dirty || !nameOk || !colorOk} onClick={saveRole}>{busy ? 'Saving…' : 'Save changes'}</button>
                  </div>

                  <div className="cc-label">Who has this role <span className="cc-count">· {selected.members.length}</span></div>
                  <div className="cc-members roles-holders">
                    {data.members.map((m) => {
                      const held = selected.members.includes(m.username)
                      const option = assignableRoles(viewer, perms, m, roles).find((o) => o.role.id === selected.id)
                      const allowed = !!option && (held || option.canGive)
                      const why = allowed ? undefined
                        : !managesRoles ? 'Giving out roles needs the Manage roles permission'
                        : !manageable(selected) ? whyNot(selected)
                        : !option ? (m.username === currentUsername ? 'You cannot change your own roles' : 'You can only change the roles of members ranked below you')
                        : 'This role carries a permission you do not hold, so you cannot give it out'
                      return (
                        <button type="button" key={m.username} className={`cc-member${held ? ' on' : ''}`} aria-pressed={held} disabled={busy || !allowed} title={why}
                          onClick={() => toggleHolder(m.username, !held)}>
                          <span className="cc-member-check">{held ? '✓' : ''}</span>
                          <span className="cc-member-name">{m.username}{m.role === 'owner' ? ' 👑' : m.role === 'admin' ? ' 🛡️' : ''}</span>
                          {/* Said in the row as well as in the tooltip: a disabled button shows no tooltip on a phone. */}
                          {!allowed && canEdit && (
                            <span className="roles-holder-why">{!option ? (m.username === currentUsername ? 'you' : 'not ranked below you') : 'has a permission you lack'}</span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                  <div className="cc-members-note">Changes to who holds a role save immediately. Taking a role away also takes away any private channel that only it opened.</div>
                </>
              )}
            </div>
          </div>
        )}
        <div className="invite-actions">
          <button type="button" className="feedback-btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
