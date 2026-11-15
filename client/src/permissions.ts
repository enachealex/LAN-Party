// Roles and permissions on the client: the names and plain-language descriptions of the
// permissions, and the questions the UI asks before it shows a control ("may I kick this person?",
// "which roles may I hand out?", "what colour is this name?").
//
// Everything here mirrors server/services/permissions.js and decides NOTHING. The server enforces
// every rule on every request; these helpers only keep the interface from offering what would be
// refused. When the two disagree the server wins, and the person sees its error.

/** A permission a custom role can carry. Mirrors PERMISSIONS in server/services/permissions.js. */
export const PERMISSIONS = [
  { id: 'manage_server', label: 'Manage server', description: 'Rename the server, change its icon and reset its app rooms.' },
  { id: 'manage_channels', label: 'Manage channels', description: 'Create, rename, delete and arrange channels and categories, open every private channel, and choose who can access each one.' },
  { id: 'manage_roles', label: 'Manage roles', description: 'Create, edit and delete roles below their own highest role, and give those roles to members ranked below them.' },
  { id: 'invite', label: 'Invite people', description: 'Add people by name, and create or revoke invite links.' },
  { id: 'kick', label: 'Kick members', description: 'Remove members ranked below them. A kicked person can be invited back.' },
  { id: 'timeout', label: 'Time out members', description: 'Stop members ranked below them from posting, reacting and joining voice for a while.' },
  { id: 'ban', label: 'Ban members', description: 'Ban and unban people, and read the ban list.' },
  { id: 'view_audit_log', label: 'View audit log', description: 'Read the record of who did what in this server.' },
] as const

export type PermissionId = (typeof PERMISSIONS)[number]['id']
const ALL_PERMISSIONS: string[] = PERMISSIONS.map((p) => p.id)

/** A custom role as server:state and GET /servers/:id/roles send it. `permissions` is only present for people who manage roles. */
export interface ServerRole {
  id: string
  name: string
  color: string | null
  position: number
  permissions?: string[]
}

/** The parts of a roster entry these helpers read. */
export interface RoleHolder {
  username?: string | null
  /** The built-in standing: 'owner' | 'admin' | 'member'. */
  role?: string | null
  /** Ids of the custom roles they hold. */
  roles?: string[] | null
}

/** A channel category as server:state sends it. Presentation only: it never decides access. */
export interface ChannelCategory {
  id: string
  name: string
  position: number
}

// Ranks, as on the server: a custom role's rank is its position, the built-ins sit either side.
const RANK_ADMIN = 1_000_000
const RANK_OWNER = RANK_ADMIN + 1

const isStaff = (role?: string | null) => role === 'owner' || role === 'admin'

/**
 * What the viewer may do in a server. `sent` is what the server said (server:state's myPermissions,
 * or `permissions` on a GET /servers row); a server from before custom roles sends nothing, and
 * then the built-in standing alone decides, as it always did.
 */
export function effectivePermissions(role: string | null | undefined, sent?: readonly string[] | null): Set<string> {
  if (Array.isArray(sent)) return new Set(sent)
  return new Set(isStaff(role) ? ALL_PERMISSIONS : [])
}

const heldRoles = (who: RoleHolder | null | undefined, roles: readonly ServerRole[]): ServerRole[] => {
  const ids = who?.roles || []
  return roles.filter((r) => ids.includes(r.id))
}

/** owner > admins > custom roles by position > members with no role. */
export function rankOf(who: RoleHolder | null | undefined, roles: readonly ServerRole[]): number {
  if (who?.role === 'owner') return RANK_OWNER
  if (who?.role === 'admin') return RANK_ADMIN
  return heldRoles(who, roles).reduce((max, r) => Math.max(max, r.position), 0)
}

/** The position a role has to be strictly below for this person to act on it. */
function roleCeiling(who: RoleHolder | null | undefined, roles: readonly ServerRole[]): number {
  return isStaff(who?.role) ? Infinity : heldRoles(who, roles).reduce((max, r) => Math.max(max, r.position), 0)
}

/** May the viewer do what `permission` names to this member? Only to someone ranked strictly below them. */
export function mayActOn(viewer: RoleHolder | null | undefined, perms: ReadonlySet<string>, target: RoleHolder | null | undefined, roles: readonly ServerRole[], permission: PermissionId): boolean {
  if (!viewer || !target || !perms.has(permission)) return false
  if (viewer.username && viewer.username === target.username) return false
  if (target.role === 'owner') return false
  return rankOf(target, roles) < rankOf(viewer, roles)
}

/** May the viewer edit, delete, reorder or hand out this role at all? */
export function mayManageRole(viewer: RoleHolder | null | undefined, perms: ReadonlySet<string>, role: ServerRole, roles: readonly ServerRole[]): boolean {
  return perms.has('manage_roles') && role.position < roleCeiling(viewer, roles)
}

/**
 * The roles the viewer may give to, or take from, this member: roles below the viewer's own
 * highest, for a member ranked below the viewer (the owner may also change their own). A role
 * carrying a permission the viewer lacks can be taken away but not given, which `canGive` says.
 */
export function assignableRoles(viewer: RoleHolder | null | undefined, perms: ReadonlySet<string>, target: RoleHolder | null | undefined, roles: readonly ServerRole[]): { role: ServerRole; canGive: boolean }[] {
  if (!viewer || !target || !perms.has('manage_roles')) return []
  const ownerOnSelf = viewer.role === 'owner' && !!viewer.username && viewer.username === target.username
  if (!ownerOnSelf && !mayActOn(viewer, perms, target, roles, 'manage_roles')) return []
  return roles
    .filter((role) => mayManageRole(viewer, perms, role, roles))
    .map((role) => ({ role, canGive: (role.permissions || []).every((p) => perms.has(p)) }))
}

/** The colour a member's name is shown in: that of their highest role that has one. */
export function roleColorOf(who: RoleHolder | null | undefined, roles: readonly ServerRole[]): string | null {
  const coloured = heldRoles(who, roles).filter((r) => r.color).sort((a, b) => b.position - a.position)
  return coloured.length ? coloured[0].color : null
}

/** A member's roles, highest first, for chips. */
export function rolesHeldBy(who: RoleHolder | null | undefined, roles: readonly ServerRole[]): ServerRole[] {
  return heldRoles(who, roles).sort((a, b) => b.position - a.position)
}

/** What the member menus need to know about one member: which entries to offer. */
export interface MemberActions {
  kick: boolean
  timeout: boolean
  ban: boolean
  /** Roles the viewer may tick on or off for them (empty: no "Roles" entry). */
  roles: { role: ServerRole; canGive: boolean }[]
}

export function memberActionsFor(viewer: RoleHolder | null | undefined, perms: ReadonlySet<string>, target: RoleHolder | null | undefined, roles: readonly ServerRole[]): MemberActions {
  return {
    kick: mayActOn(viewer, perms, target, roles, 'kick'),
    timeout: mayActOn(viewer, perms, target, roles, 'timeout'),
    ban: mayActOn(viewer, perms, target, roles, 'ban'),
    roles: assignableRoles(viewer, perms, target, roles),
  }
}

export const NO_MEMBER_ACTIONS: MemberActions = { kick: false, timeout: false, ban: false, roles: [] }
