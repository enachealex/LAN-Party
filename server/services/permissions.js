// @ts-check
// Who may do what in a server. Every permission check in the routes and the socket layer asks
// this module, so each rule below is written down once.
//
// STANDING. Three things decide what a member may do:
//   owner    server_members.role = 'owner'. Everything, and nobody acts on them.
//   admin    server_members.role = 'admin'. Every permission in PERMISSIONS, exactly as before
//            custom roles existed. Only the owner makes or unmakes one.
//   roles    Custom roles (server_roles), any number per member (server_member_roles). Each carries
//            a set of PERMISSIONS and they add up. A member with no role has no permission.
//
// RANK. owner > admins > custom roles by `position` (higher position = higher rank) > members with
// no role > people who are not members. A member's rank is that of their highest role.
//   - Acting on a person (kick, ban, time out, lift, give or take a role): only on someone whose
//     rank is STRICTLY below your own. Never sideways, never upwards, never yourself.
//   - Acting on a role (edit, delete, reorder, hand out): only a role strictly below your own
//     highest one. Admins and the owner are above every custom role.
//   - Nobody grants a permission they do not hold: not by adding it to a role, and not by handing
//     out a role that carries it.
// Custom roles never touch server_members.role, so nothing done to them can make or unmake an
// owner or an admin.
//
// CHANNELS. A public channel is open to every member. A private one is open to the owner and
// admins, to anyone with manage_channels, to the members its list names (channel_members) and to
// the holders of the roles its list names (channel_roles). A category (channel_categories) is
// presentation only and never part of this: a private channel keeps its own list wherever it sits.
//
// THE COMMONS has no staff and no roles. Everyone is a 'member' of it with no permission, whatever
// the tables hold, and the routes refuse it by name before they get here.

/**
 * The permissions a custom role can carry. Fixed and named: a role stores a JSON array of these,
 * and anything else found in one is ignored.
 */
const PERMISSIONS = Object.freeze([
  'manage_server',   // rename the server, change its icon, reset app rooms
  'manage_channels', // create/rename/delete channels and categories, edit private channel access
  'manage_roles',    // create/edit/delete roles below your own, and hand them out
  'invite',          // add people by name, create and revoke invite links
  'kick',
  'timeout',
  'ban',             // ban, unban, read the ban list
  'view_audit_log',
]);
/** @type {ReadonlySet<string>} */
const PERMISSION_SET = new Set(PERMISSIONS);

const MAX_ROLES = 50;
// Ranks. A custom role's rank is its position (1..MAX_ROLES); the built-ins sit either side.
const RANK_OUTSIDER = -1;
const RANK_MEMBER = 0;
const RANK_ADMIN = 1_000_000;
const RANK_OWNER = RANK_ADMIN + 1;

/** @param {string | null | undefined} role */
const isStaffRole = (role) => role === 'owner' || role === 'admin';

/**
 * The rank of a built-in standing alone, for someone who holds no custom role.
 * @param {string | null | undefined} role
 */
function builtinRank(role) {
  if (role === 'owner') return RANK_OWNER;
  if (role === 'admin') return RANK_ADMIN;
  return role ? RANK_MEMBER : RANK_OUTSIDER;
}

/**
 * The stored permissions of a role, as the known names only.
 * @param {unknown} stored the JSON text from server_roles.permissions
 * @returns {string[]}
 */
function parsePermissions(stored) {
  let list = [];
  try { list = typeof stored === 'string' ? JSON.parse(stored) : []; } catch (_) { list = []; }
  if (!Array.isArray(list)) return [];
  return PERMISSIONS.filter((name) => list.includes(name));
}

/**
 * THE rule for acting on a person, as a pure decision. `reason` says which line refused, and each
 * route words that for itself (a kick and a ban have always answered differently).
 * @param {{ actorCan: boolean, self: boolean, targetIsOwner: boolean, actorRank: number, targetRank: number }} facts
 * @returns {{ ok: true } | { ok: false, reason: 'no-permission' | 'self' | 'owner' | 'rank' }}
 */
function decideAction({ actorCan, self, targetIsOwner, actorRank, targetRank }) {
  if (!actorCan) return { ok: false, reason: 'no-permission' };
  if (self) return { ok: false, reason: 'self' };
  if (targetIsOwner) return { ok: false, reason: 'owner' };
  if (targetRank >= actorRank) return { ok: false, reason: 'rank' };
  return { ok: true };
}

/**
 * @typedef {import('../db/migrate').Db} Db
 * @typedef {{ id: string, name: string, color: string | null, position: number, permissions: string[] }} Role
 * @typedef {{ role: string | null, rank: number, ceiling: number, permissions: Set<string>, roleIds: string[] }} Standing
 * @param {{ db: Db, commonsId: string }} deps
 */
function createPermissions({ db, commonsId }) {
  /**
   * The built-in standing: 'owner' | 'admin' | 'member', or null for someone who is not a member.
   * Everyone is a 'member' of the commons.
   * @param {string} serverId @param {string | null | undefined} username
   * @returns {Promise<string | null>}
   */
  async function roleOf(serverId, username) {
    if (!username) return null;
    if (serverId === commonsId) return 'member';
    const row = await db.get('SELECT role FROM server_members WHERE server_id = ? AND username = ?', serverId, username);
    return row ? row.role : null;
  }

  /** @param {string} serverId @param {string | null | undefined} username */
  async function isMember(serverId, username) { return (await roleOf(serverId, username)) != null; }

  /**
   * The custom roles a member holds. Joined to server_roles of the SAME server, so a row that
   * outlived its role, or names a role of another server, counts for nothing.
   * @param {string} serverId @param {string} username
   * @returns {Promise<Role[]>}
   */
  async function heldRoles(serverId, username) {
    if (serverId === commonsId) return [];
    const rows = await db.all(
      `SELECT r.id, r.name, r.color, r.position, r.permissions FROM server_member_roles mr
         JOIN server_roles r ON r.id = mr.role_id AND r.server_id = mr.server_id
        WHERE mr.server_id = ? AND mr.username = ? ORDER BY r.position DESC`,
      serverId, username
    );
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color || null, position: r.position, permissions: parsePermissions(r.permissions) }));
  }

  /**
   * Everything about one person in one server, read once: what the rest of this module is made of.
   * `ceiling` is the position a role must be strictly below for this person to act on it.
   * @param {string} serverId @param {string | null | undefined} username
   * @returns {Promise<Standing>}
   */
  async function standingOf(serverId, username) {
    const role = await roleOf(serverId, username);
    if (!role || !username) return { role: null, rank: RANK_OUTSIDER, ceiling: 0, permissions: new Set(), roleIds: [] };
    // Membership first: role rows for someone who is no longer a member grant nothing.
    const held = await heldRoles(serverId, username);
    const roleIds = held.map((r) => r.id);
    if (isStaffRole(role)) return { role, rank: builtinRank(role), ceiling: Infinity, permissions: new Set(PERMISSIONS), roleIds };
    const top = held.reduce((max, r) => Math.max(max, r.position), 0);
    const permissions = new Set(held.flatMap((r) => r.permissions));
    return { role, rank: Math.min(Math.max(top, RANK_MEMBER), RANK_ADMIN - 1), ceiling: top, permissions, roleIds };
  }

  /** @param {string} serverId @param {string | null | undefined} username @returns {Promise<Set<string>>} */
  async function permissionsOf(serverId, username) { return (await standingOf(serverId, username)).permissions; }

  /**
   * Does this person hold that permission in that server?
   * @param {string} serverId @param {string | null | undefined} username @param {string} permission
   */
  async function can(serverId, username, permission) {
    if (!PERMISSION_SET.has(permission)) throw new Error(`unknown permission "${permission}"`);
    return (await permissionsOf(serverId, username)).has(permission);
  }

  /** @param {string} serverId @param {string | null | undefined} username */
  async function rankOf(serverId, username) { return (await standingOf(serverId, username)).rank; }

  /**
   * May `actor` do the thing `permission` names to `target`? The target need not be a member (a
   * ban can fall on someone who is not). Answers with both built-in roles, for the route's wording.
   * @param {string} serverId @param {string} actor @param {string} target @param {string} permission
   */
  async function mayActOn(serverId, actor, target, permission) {
    if (!PERMISSION_SET.has(permission)) throw new Error(`unknown permission "${permission}"`);
    const mine = await standingOf(serverId, actor);
    const theirs = await standingOf(serverId, target);
    const srv = serverId === commonsId ? null : await db.get('SELECT owner FROM servers WHERE id = ?', serverId);
    const verdict = decideAction({
      actorCan: mine.permissions.has(permission),
      self: actor === target,
      // By name as well as by role: the owner column is what the rest of the server trusts.
      targetIsOwner: theirs.role === 'owner' || (!!srv && !!srv.owner && srv.owner === target),
      actorRank: mine.rank,
      targetRank: theirs.rank,
    });
    return { ...verdict, actorRole: mine.role, targetRole: theirs.role };
  }

  // --- Channels ---

  /**
   * Channel management. The commons is open: anyone may add a public channel there, as before.
   * @param {string} serverId @param {string | null | undefined} username
   */
  async function mayManageChannels(serverId, username) {
    if (serverId === commonsId) return true;
    return can(serverId, username, 'manage_channels');
  }

  /**
   * Can this user see and use the channel? `role` is their built-in standing, already read by the
   * caller (null = not a member).
   * @param {string} serverId @param {string} channelId @param {string | null | undefined} username
   * @param {string | null | undefined} privacy @param {string | null | undefined} role
   */
  async function canAccessChannel(serverId, channelId, username, privacy, role) {
    if (!role) return false;                 // not a member of the server
    if (privacy !== 'private') return true;  // public channel
    if (isStaffRole(role)) return true;      // owner/admins manage everything
    if (!username) return false;
    if (await db.get('SELECT 1 FROM channel_members WHERE server_id = ? AND channel_id = ? AND username = ?', serverId, channelId, username)) return true;
    const held = await heldRoles(serverId, username);
    if (held.length === 0) return false;
    if (held.some((r) => r.permissions.includes('manage_channels'))) return true;
    const listed = await db.all('SELECT role_id FROM channel_roles WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    return listed.some((row) => held.some((r) => r.id === row.role_id));
  }

  /**
   * The channels of `channels` this user can see: all of them for staff and for manage_channels,
   * otherwise the public ones plus the private ones that list them or one of their roles.
   * @template {{ id: string, privacy?: string | null }} C
   * @param {string} serverId @param {C[]} channels @param {string | null | undefined} username @param {string | null | undefined} role
   * @returns {Promise<C[]>}
   */
  async function visibleChannelsFor(serverId, channels, username, role) {
    if (isStaffRole(role)) return channels;
    const granted = new Set((await db.all('SELECT channel_id FROM channel_members WHERE server_id = ? AND username = ?', serverId, username)).map((r) => r.channel_id));
    const held = role && username ? await heldRoles(serverId, username) : [];
    if (held.some((r) => r.permissions.includes('manage_channels'))) return channels;
    if (held.length > 0) {
      const mine = new Set(held.map((r) => r.id));
      for (const row of await db.all('SELECT channel_id, role_id FROM channel_roles WHERE server_id = ?', serverId)) {
        if (mine.has(row.role_id)) granted.add(row.channel_id);
      }
    }
    return channels.filter((c) => c.privacy !== 'private' || granted.has(c.id));
  }

  /**
   * The ids of the PRIVATE channels this person can open right now. Taken before and after a
   * change to find out whether it took a channel away from them (services/accessChanges.js).
   * @param {string} serverId @param {string} username
   * @returns {Promise<Set<string>>}
   */
  async function privateChannelsOf(serverId, username) {
    const role = await roleOf(serverId, username);
    if (!role) return new Set();
    const all = await db.all("SELECT id, 'private' AS privacy FROM channels WHERE server_id = ? AND COALESCE(privacy, 'public') = 'private'", serverId);
    return new Set((await visibleChannelsFor(serverId, all, username, role)).map((c) => c.id));
  }

  // --- Roles ---

  /**
   * A server's roles, highest first.
   * @param {string} serverId
   * @returns {Promise<Role[]>}
   */
  async function listRoles(serverId) {
    if (serverId === commonsId) return [];
    const rows = await db.all('SELECT id, name, color, position, permissions FROM server_roles WHERE server_id = ? ORDER BY position DESC, created_at ASC', serverId);
    return rows.map((r) => ({ id: r.id, name: r.name, color: r.color || null, position: r.position, permissions: parsePermissions(r.permissions) }));
  }

  /**
   * Who holds which roles in a server, as username -> role ids (members with none are absent).
   * @param {string} serverId
   * @returns {Promise<Map<string, string[]>>}
   */
  async function memberRolesIn(serverId) {
    /** @type {Map<string, string[]>} */
    const out = new Map();
    if (serverId === commonsId) return out;
    const rows = await db.all(
      `SELECT mr.username, mr.role_id FROM server_member_roles mr
         JOIN server_roles r ON r.id = mr.role_id AND r.server_id = mr.server_id
         JOIN server_members m ON m.server_id = mr.server_id AND m.username = mr.username
        WHERE mr.server_id = ? ORDER BY r.position DESC`,
      serverId
    );
    for (const row of rows) {
      const list = out.get(row.username);
      if (list) list.push(row.role_id); else out.set(row.username, [row.role_id]);
    }
    return out;
  }

  /**
   * May someone of this standing act on that role at all (edit, delete, reorder, hand out)?
   * manage_roles, and the role strictly below their own highest.
   * @param {Standing} standing @param {{ position: number }} role
   */
  const mayManageRole = (standing, role) => standing.permissions.has('manage_roles') && role.position < standing.ceiling;

  /**
   * The permissions in `wanted` this standing may not grant, because it does not hold them.
   * @param {Standing} standing @param {string[]} wanted
   */
  const cannotGrant = (standing, wanted) => wanted.filter((name) => !standing.permissions.has(name));

  /**
   * Everything roles and categories keep for a server, for when the server itself is deleted.
   * @param {string} serverId
   */
  async function forgetServer(serverId) {
    await db.run('DELETE FROM server_member_roles WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channel_roles WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_roles WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channel_categories WHERE server_id = ?', serverId);
  }

  /**
   * A member is no longer one (kicked, banned, left): the roles they held here go with them, so
   * that coming back does not bring any back.
   * @param {string} serverId @param {string} username
   */
  async function forgetMember(serverId, username) {
    await db.run('DELETE FROM server_member_roles WHERE server_id = ? AND username = ?', serverId, username);
  }

  return {
    roleOf, isMember, standingOf, permissionsOf, can, rankOf, mayActOn,
    mayManageChannels, canAccessChannel, visibleChannelsFor, privateChannelsOf,
    listRoles, memberRolesIn, mayManageRole, cannotGrant,
    forgetServer, forgetMember,
  };
}

module.exports = {
  createPermissions, decideAction, builtinRank, isStaffRole, parsePermissions,
  PERMISSIONS, MAX_ROLES, RANK_OUTSIDER, RANK_MEMBER, RANK_ADMIN, RANK_OWNER,
};
