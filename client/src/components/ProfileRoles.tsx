import { useState } from 'react'
import type { ServerRole } from '../permissions'

interface ProfileRolesProps {
  username: string
  /** The roles this person holds in the server on screen, highest first. */
  held: ServerRole[]
  /** The roles the viewer may tick on or off for them (permissions.ts, assignableRoles); empty for most people. */
  options: { role: ServerRole; canGive: boolean }[]
  onToggle?: (username: string, roleId: string, on: boolean) => void
}

/**
 * A member's roles on their profile card, as chips in each role's colour. Someone who may hand
 * roles out to this person also gets "Edit roles": the same ticks as "Roles ▸" in the member
 * menu, for people who open the card instead of right-clicking.
 *
 * Roles belong to a server, so this is only shown for the server on screen; a card opened from
 * Home or a DM has none. What it offers is only what to show: the server decides.
 */
export default function ProfileRoles({ username, held, options, onToggle }: ProfileRolesProps) {
  const [editing, setEditing] = useState(false)
  if (held.length === 0 && options.length === 0) return null
  const heldIds = held.map((r) => r.id)
  return (
    <div className="profilecard-roles">
      <div className="profilecard-section profilecard-roles-head">
        <span>🏷️ Roles</span>
        {options.length > 0 && (
          <button type="button" className="profilecard-roles-edit" aria-expanded={editing} onClick={() => setEditing((v) => !v)}>{editing ? 'Done' : 'Edit roles'}</button>
        )}
      </div>
      {held.length > 0 ? (
        <div className="role-chips">
          {held.map((role) => (
            <span key={role.id} className="role-chip" style={role.color ? { borderColor: role.color, color: role.color } : undefined}>
              <span className="role-dot" style={{ background: role.color || 'transparent' }} aria-hidden="true" />{role.name}
            </span>
          ))}
        </div>
      ) : (
        <div className="profilecard-roles-none">No roles in this server.</div>
      )}
      {editing && (
        <div className="cc-members profilecard-roles-list" role="group" aria-label={`Roles for ${username}`}>
          {options.map(({ role, canGive }) => {
            const on = heldIds.includes(role.id)
            const disabled = !on && !canGive
            return (
              <button key={role.id} type="button" className={`cc-member${on ? ' on' : ''}`} aria-pressed={on} disabled={disabled}
                title={disabled ? 'This role carries a permission you do not hold, so you cannot give it out' : undefined}
                onClick={() => onToggle?.(username, role.id, !on)}>
                <span className="cc-member-check">{on ? '✓' : ''}</span>
                <span className="role-dot" style={{ background: role.color || 'transparent' }} aria-hidden="true" />
                <span className="cc-member-name">{role.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
