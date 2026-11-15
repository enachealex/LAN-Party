import { useState } from 'react'
import type { MemberActions } from '../permissions'

interface MemberActionItemsProps {
  username: string
  /**
   * What the viewer may do to this member in the server on screen (permissions.ts,
   * memberActionsFor): time out and ban need those permissions and a member ranked below the
   * viewer; `roles` lists the roles the viewer may tick on or off for them.
   */
  actions: MemberActions
  /** Ids of the roles the member holds right now (live, so a tick shows as soon as the server says so). */
  heldRoleIds?: readonly string[]
  /** Whether this member is timed out in the server right now. */
  timedOut: boolean
  /** Whether the signed-in person has blocked them. */
  blocked: boolean
  /** Closes the menu these items sit in. Called before the action, as the other items do. */
  onDone: () => void
  onTimeout?: (username: string) => void
  onLiftTimeout?: (username: string) => void
  onBan?: (username: string) => void
  onBlock?: (username: string) => void
  onUnblock?: (username: string) => void
  /** Give (`on`) or take a role. The menu stays open, so several can be ticked in one visit. */
  onToggleRole?: (username: string, roleId: string, on: boolean) => void
}

/**
 * The entries a member's right-click menu gains for roles, moderation and blocking. There are two
 * such menus (the server's member list in AppLeftPane, and the members panel in App.jsx); both
 * render this, so the two cannot drift apart.
 *
 * "Roles ▸" opens a list inside the menu rather than a fly-out: a fly-out has nowhere to go on a
 * phone, and this menu is already positioned against the window's edges. Only roles the viewer may
 * hand out are listed.
 *
 * Time out and Ban sit next to "Remove from server". The "…" on them is a promise that nothing
 * happens yet: each opens a dialog first. Block is for everyone.
 * What these offer is only what to show; the server decides who may do what.
 */
export default function MemberActionItems({ username, actions, heldRoleIds = [], timedOut, blocked, onDone, onTimeout, onLiftTimeout, onBan, onBlock, onUnblock, onToggleRole }: MemberActionItemsProps) {
  const [rolesOpen, setRolesOpen] = useState(false)
  const run = (action?: (username: string) => void) => () => { onDone(); action?.(username) }
  return (
    <>
      {actions.roles.length > 0 && (
        <>
          <button type="button" role="menuitem" className="dc-ctx-item" aria-expanded={rolesOpen} onClick={() => setRolesOpen((open) => !open)}>
            🏷️ Roles <span className="dc-ctx-caret" aria-hidden="true">{rolesOpen ? '▾' : '▸'}</span>
          </button>
          {rolesOpen && (
            <div className="dc-ctx-sub" role="group" aria-label={`Roles for ${username}`}>
              {actions.roles.map(({ role, canGive }) => {
                const held = heldRoleIds.includes(role.id)
                // A role carrying a permission the viewer lacks can be taken away, never given.
                const disabled = !held && !canGive
                return (
                  <button
                    key={role.id}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={held}
                    className="dc-ctx-item dc-ctx-check"
                    disabled={disabled}
                    title={disabled ? 'This role carries a permission you do not hold, so you cannot give it out' : undefined}
                    onClick={() => onToggleRole?.(username, role.id, !held)}
                  >
                    <span className="dc-ctx-checkbox" aria-hidden="true">{held ? '✓' : ''}</span>
                    <span className="role-dot" style={{ background: role.color || 'transparent' }} aria-hidden="true" />
                    <span className="dc-ctx-check-label">{role.name}</span>
                  </button>
                )
              })}
            </div>
          )}
        </>
      )}
      {actions.timeout && (timedOut
        ? <button type="button" role="menuitem" className="dc-ctx-item" onClick={run(onLiftTimeout)}>⏳ Remove time out</button>
        : <button type="button" role="menuitem" className="dc-ctx-item" onClick={run(onTimeout)}>⏳ Time out…</button>)}
      {actions.ban && (
        <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={run(onBan)}>⛔ Ban…</button>
      )}
      <div className="dc-ctx-sep" role="separator" />
      {blocked
        ? <button type="button" role="menuitem" className="dc-ctx-item" onClick={run(onUnblock)}>Unblock</button>
        : <button type="button" role="menuitem" className="dc-ctx-item danger" onClick={run(onBlock)}>🙅 Block</button>}
    </>
  )
}
