// Custom roles: create, edit, reorder, delete, and hand out. The rules are services/permissions.js
// (which says what a role is, how rank works and what nobody may do); this file applies them to
// each request and words the refusals.
//
// In short, for every route that changes something:
//   - the caller holds manage_roles in THIS server (the owner and admins always do);
//   - the role is strictly below the caller's own highest role (any role, for the owner and admins);
//   - nobody adds a permission to a role, or hands out a role carrying a permission, that they do
//     not hold themselves;
//   - roles are given to and taken from members ranked strictly below the caller. The one
//     exception is the owner on themselves: nobody outranks the owner, so nobody else could.
// A custom role never changes server_members.role, so none of this can make or unmake an owner
// or an admin: that stays PATCH /servers/:id/members/:username, owner only.
//
// Reading the roles is for every member of the server: names, colours, order and who holds what
// are shown in the member list and on profile cards. What each role permits is only sent to
// people who manage roles.
//
// LOSING A ROLE CAN TAKE THINGS AWAY. Removing a role from someone, deleting it, or taking a
// permission off it can close a private channel to people (or end their right to invite). Every
// route that can do that snapshots the people it may affect first and settles afterwards
// (services/accessChanges.js): new app room keys, out of the voice and text rooms, links revoked.
//
// Never the commons: it has no staff and no roles, and is refused by name before anything else.
const { rateLimit } = require('../rateLimit');
const { AUDIT } = require('../services/moderation');
const { PERMISSIONS, MAX_ROLES } = require('../services/permissions');

const ROLE_NAME_MAX = 32;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// Counted per account. Roles are set up in a burst (a handful of roles, each with a few edits and
// members), so this is roomy; it is a ceiling for a script, or a stolen token, churning through
// them, since a change that takes access away also replaces the server's app room keys.
const keyOf = (/** @type {any} */ req) => req.user && req.user.username;
const ROLES_WRITE_LIMIT = { id: 'roles-write', windowMs: 5 * 60_000, max: 120, message: 'Too many role changes just now. Wait a few minutes.', keyOf };
const ROLES_READ_LIMIT = { id: 'roles-read', windowMs: 60_000, max: 240, keyOf };

/**
 * A role name as it is stored: text, trimmed, 1..ROLE_NAME_MAX characters.
 * @param {unknown} value
 * @returns {{ name: string } | { error: string }}
 */
function parseRoleName(value) {
  if (typeof value !== 'string') return { error: 'A role needs a name' };
  const name = value.trim();
  if (name.length < 1 || name.length > ROLE_NAME_MAX) return { error: `A role name must be 1 to ${ROLE_NAME_MAX} characters` };
  return { name };
}

/**
 * A role colour: "#rrggbb", or null / "" for none.
 * @param {unknown} value
 * @returns {{ color: string | null } | { error: string }}
 */
function parseRoleColor(value) {
  if (value === null || value === undefined || value === '') return { color: null };
  if (typeof value !== 'string' || !COLOR_RE.test(value)) return { error: 'A role colour must be a hex colour like #3ba55c' };
  return { color: value.toLowerCase() };
}

/**
 * A list of permissions: an array of names from PERMISSIONS, each once. An unknown name is an
 * error rather than something to drop: whoever sent it meant something by it.
 * @param {unknown} value
 * @returns {{ permissions: string[] } | { error: string }}
 */
function parseRolePermissions(value) {
  if (!Array.isArray(value)) return { error: 'permissions must be a list' };
  const unknown = value.find((name) => typeof name !== 'string' || !PERMISSIONS.includes(name));
  if (unknown !== undefined) return { error: `Unknown permission: ${String(unknown).slice(0, 40)}` };
  return { permissions: PERMISSIONS.filter((name) => value.includes(name)) };
}

/** @param {Record<string, any>} deps */
function registerRoleRoutes({ app, db, io, authMiddleware, DEMO_ID, newId, permissions, accessChanges, moderation, broadcastServerState }) {
  const audit = moderation.audit;

  // Express 4 does not catch a rejected async handler, and an unhandled rejection ends the process.
  const safely = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (e) {
      console.error('[roles] error:', e);
      if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
      return undefined;
    }
  };

  // The gate every route passes first: a real server, not the commons, and the caller is a member
  // of THIS server. Answers the request itself when it fails.
  async function memberOfServer(req, res) {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) { res.status(400).json({ error: 'The public server has no roles' }); return null; }
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) { res.status(404).json({ error: 'Server not found' }); return null; }
    const standing = await permissions.standingOf(serverId, req.user.username);
    if (!standing.role) { res.status(403).json({ error: 'Not a member' }); return null; }
    return { srv, serverId, standing };
  }

  // The same, and the caller manages roles here.
  async function roleManager(req, res) {
    const ctx = await memberOfServer(req, res);
    if (!ctx) return null;
    if (!ctx.standing.permissions.has('manage_roles')) { res.status(403).json({ error: 'You need the Manage roles permission to do that' }); return null; }
    return ctx;
  }

  // ...and the role in the URL is one of this server's, and below the caller's own highest.
  async function manageableRole(req, res) {
    const ctx = await roleManager(req, res);
    if (!ctx) return null;
    const role = (await permissions.listRoles(ctx.serverId)).find((r) => r.id === req.params.roleId);
    if (!role) { res.status(404).json({ error: 'Role not found' }); return null; }
    if (!permissions.mayManageRole(ctx.standing, role)) { res.status(403).json({ error: 'You can only change roles below your own highest role' }); return null; }
    return { ...ctx, role };
  }

  const holdersOf = async (serverId, roleId) =>
    (await db.all('SELECT username FROM server_member_roles WHERE server_id = ? AND role_id = ?', serverId, roleId)).map((r) => r.username);

  // Positions are kept 1..n with no gaps and no ties: rank is a strict order, and two roles at
  // the same position would each be "not below" the other.
  async function renumber(serverId) {
    const rows = await db.all('SELECT id FROM server_roles WHERE server_id = ? ORDER BY position ASC, created_at ASC', serverId);
    for (let i = 0; i < rows.length; i++) await db.run('UPDATE server_roles SET position = ? WHERE id = ?', i + 1, rows[i].id);
  }

  // Everyone's state (roles, colours, who holds what), and the rails of the people whose own
  // permissions may have changed: the rail's menus are drawn from GET /servers.
  async function announce(serverId, affected = []) {
    await broadcastServerState(serverId);
    for (const username of new Set(affected)) io.to(`user:${username}`).emit('servers:updated');
  }

  const shape = (role, withPermissions) => ({
    id: role.id, name: role.name, color: role.color, position: role.position,
    ...(withPermissions ? { permissions: role.permissions } : {}),
  });

  // --- Read ---

  // The server's roles, highest first, with who holds each; and every member with their built-in
  // standing and their roles. For any member: it is what the member list already shows them.
  app.get('/servers/:serverId/roles', authMiddleware, rateLimit(ROLES_READ_LIMIT), safely(async (req, res) => {
    const ctx = await memberOfServer(req, res);
    if (!ctx) return undefined;
    const { serverId, standing } = ctx;
    const roles = await permissions.listRoles(serverId);
    const held = await permissions.memberRolesIn(serverId);
    const members = (await db.all('SELECT username, role FROM server_members WHERE server_id = ? ORDER BY username', serverId))
      .map((m) => ({ username: m.username, role: m.role, roles: held.get(m.username) || [] }));
    const seesPermissions = standing.permissions.has('manage_roles');
    return res.json({
      roles: roles.map((r) => ({ ...shape(r, seesPermissions), members: members.filter((m) => m.roles.includes(r.id)).map((m) => m.username) })),
      members,
      permissions: PERMISSIONS,
      myRole: standing.role,
      myPermissions: [...standing.permissions],
      maxRoles: MAX_ROLES,
    });
  }));

  // --- Create, edit, reorder, delete ---

  app.post('/servers/:serverId/roles', authMiddleware, rateLimit(ROLES_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await roleManager(req, res);
    if (!ctx) return undefined;
    const { serverId, standing } = ctx;
    const body = req.body || {};
    const named = parseRoleName(body.name);
    if ('error' in named) return res.status(400).json({ error: named.error });
    const coloured = parseRoleColor(body.color);
    if ('error' in coloured) return res.status(400).json({ error: coloured.error });
    const wanted = parseRolePermissions(body.permissions === undefined ? [] : body.permissions);
    if ('error' in wanted) return res.status(400).json({ error: wanted.error });
    const refused = permissions.cannotGrant(standing, wanted.permissions);
    if (refused.length) return res.status(403).json({ error: `You can't grant a permission you don't hold (${refused.join(', ')})` });
    const count = await db.get('SELECT COUNT(*) AS n FROM server_roles WHERE server_id = ?', serverId);
    if ((count?.n || 0) >= MAX_ROLES) return res.status(400).json({ error: `A server can have at most ${MAX_ROLES} roles` });
    // A new role starts at the bottom: below every existing role, so below the caller's own
    // whoever they are, and outranking nobody until someone moves it up on purpose.
    const id = newId('role');
    await db.run('UPDATE server_roles SET position = position + 1 WHERE server_id = ?', serverId);
    await db.run(
      'INSERT INTO server_roles (id, server_id, name, color, position, permissions, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      id, serverId, named.name, coloured.color, JSON.stringify(wanted.permissions), Date.now()
    );
    await renumber(serverId);
    await announce(serverId);
    await audit(serverId, req.user.username, AUDIT.roleCreated, null, { roleId: id, role: named.name, permissions: wanted.permissions });
    return res.json({ role: { id, name: named.name, color: coloured.color, position: 1, permissions: wanted.permissions } });
  }));

  // Edit a role's name, colour and permissions; each is optional, and what is left out stays.
  app.patch('/servers/:serverId/roles/:roleId', authMiddleware, rateLimit(ROLES_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await manageableRole(req, res);
    if (!ctx) return undefined;
    const { serverId, standing, role } = ctx;
    const body = req.body || {};
    if (body.name === undefined && body.color === undefined && body.permissions === undefined) return res.status(400).json({ error: 'Nothing to change' });
    let name = role.name;
    if (body.name !== undefined) {
      const named = parseRoleName(body.name);
      if ('error' in named) return res.status(400).json({ error: named.error });
      name = named.name;
    }
    let color = role.color;
    if (body.color !== undefined) {
      const coloured = parseRoleColor(body.color);
      if ('error' in coloured) return res.status(400).json({ error: coloured.error });
      color = coloured.color;
    }
    let next = role.permissions;
    if (body.permissions !== undefined) {
      const wanted = parseRolePermissions(body.permissions);
      if ('error' in wanted) return res.status(400).json({ error: wanted.error });
      next = wanted.permissions;
    }
    // Only what is being ADDED has to be the caller's to give: a role that already carries a
    // permission they lack can still be renamed or recoloured by them, and can lose it.
    const added = next.filter((p) => !role.permissions.includes(p));
    const removed = role.permissions.filter((p) => !next.includes(p));
    const refused = permissions.cannotGrant(standing, added);
    if (refused.length) return res.status(403).json({ error: `You can't grant a permission you don't hold (${refused.join(', ')})` });

    // Taking a permission off a role takes it off everyone who holds the role.
    const holders = removed.length ? await holdersOf(serverId, role.id) : [];
    const before = await accessChanges.snapshot(serverId, holders);
    await db.run('UPDATE server_roles SET name = ?, color = ?, permissions = ? WHERE id = ? AND server_id = ?', name, color, JSON.stringify(next), role.id, serverId);
    await accessChanges.settle(serverId, before);
    await announce(serverId, added.length || removed.length ? await holdersOf(serverId, role.id) : []);

    const changes = {
      ...(name !== role.name ? { name: { from: role.name, to: name } } : {}),
      ...(color !== role.color ? { color: { from: role.color, to: color } } : {}),
      ...(added.length ? { added } : {}),
      ...(removed.length ? { removed } : {}),
    };
    if (Object.keys(changes).length) await audit(serverId, req.user.username, AUDIT.roleUpdated, null, { roleId: role.id, role: name, ...changes });
    return res.json({ role: { id: role.id, name, color, position: role.position, permissions: next } });
  }));

  // Move a role one place up or down the order. Both roles that change places have to be below
  // the caller's own highest: moving a role up past one you could not touch would be acting on it.
  app.post('/servers/:serverId/roles/:roleId/move', authMiddleware, rateLimit(ROLES_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await manageableRole(req, res);
    if (!ctx) return undefined;
    const { serverId, standing, role } = ctx;
    const direction = (req.body || {}).direction;
    if (direction !== 'up' && direction !== 'down') return res.status(400).json({ error: 'direction must be "up" or "down"' });
    const ordered = await permissions.listRoles(serverId); // highest first
    const index = ordered.findIndex((r) => r.id === role.id);
    const other = ordered[direction === 'up' ? index - 1 : index + 1];
    if (!other) return res.json({ success: true, moved: false });
    if (!permissions.mayManageRole(standing, other)) return res.status(403).json({ error: 'You can only reorder roles below your own highest role' });
    await db.run('UPDATE server_roles SET position = ? WHERE id = ?', other.position, role.id);
    await db.run('UPDATE server_roles SET position = ? WHERE id = ?', role.position, other.id);
    await renumber(serverId);
    await announce(serverId);
    await audit(serverId, req.user.username, AUDIT.roleMoved, null, { roleId: role.id, role: role.name, direction });
    return res.json({ success: true, moved: true });
  }));

  app.delete('/servers/:serverId/roles/:roleId', authMiddleware, rateLimit(ROLES_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await manageableRole(req, res);
    if (!ctx) return undefined;
    const { serverId, role } = ctx;
    // Everyone who held it loses what it gave them: its permissions, and the private channels
    // that listed it.
    const holders = await holdersOf(serverId, role.id);
    const before = await accessChanges.snapshot(serverId, holders);
    await db.run('DELETE FROM server_member_roles WHERE server_id = ? AND role_id = ?', serverId, role.id);
    await db.run('DELETE FROM channel_roles WHERE server_id = ? AND role_id = ?', serverId, role.id);
    await db.run('DELETE FROM server_roles WHERE id = ? AND server_id = ?', role.id, serverId);
    await renumber(serverId);
    await accessChanges.settle(serverId, before);
    await announce(serverId, holders);
    await audit(serverId, req.user.username, AUDIT.roleDeleted, null, { roleId: role.id, role: role.name, holders: holders.length });
    return res.json({ success: true });
  }));

  // --- Give a role to a member, or take it back ---

  // The checks the two routes share: a role the caller may hand out, and a member they may act on.
  async function roleAndMember(req, res) {
    const ctx = await manageableRole(req, res);
    if (!ctx) return null;
    const { serverId, standing } = ctx;
    const actor = req.user.username;
    const target = String(req.params.username || '').trim();
    if (!(await permissions.isMember(serverId, target))) { res.status(404).json({ error: 'Not a member' }); return null; }
    // The owner on themselves is the one case of acting on your own rank: nobody is above the
    // owner, so nobody else could give them a role (a colour is the only thing it changes for them).
    const ownerOnSelf = standing.role === 'owner' && target === actor;
    if (!ownerOnSelf) {
      const allowed = await permissions.mayActOn(serverId, actor, target, 'manage_roles');
      if (!allowed.ok) {
        if (allowed.reason === 'self') { res.status(400).json({ error: "You can't change your own roles" }); return null; }
        const error = allowed.reason === 'owner' ? "The owner's roles can't be changed by anyone else"
          : allowed.reason === 'rank' ? 'You can only change the roles of members ranked below you'
          : 'You need the Manage roles permission to do that';
        res.status(403).json({ error });
        return null;
      }
    }
    return { ...ctx, target };
  }

  app.put('/servers/:serverId/members/:username/roles/:roleId', authMiddleware, rateLimit(ROLES_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await roleAndMember(req, res);
    if (!ctx) return undefined;
    const { serverId, standing, role, target } = ctx;
    // Handing out a role hands out everything it permits, so it is held to the same rule as
    // putting a permission on a role.
    const refused = permissions.cannotGrant(standing, role.permissions);
    if (refused.length) return res.status(403).json({ error: `You can't give out a role with a permission you don't hold (${refused.join(', ')})` });
    const given = await db.run('INSERT OR IGNORE INTO server_member_roles (server_id, username, role_id) VALUES (?, ?, ?)', serverId, target, role.id);
    await announce(serverId, [target]);
    if (given.changes > 0) await audit(serverId, req.user.username, AUDIT.roleAssigned, target, { roleId: role.id, role: role.name });
    return res.json({ success: true });
  }));

  app.delete('/servers/:serverId/members/:username/roles/:roleId', authMiddleware, rateLimit(ROLES_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await roleAndMember(req, res);
    if (!ctx) return undefined;
    const { serverId, role, target } = ctx;
    const before = await accessChanges.snapshot(serverId, [target]);
    const taken = await db.run('DELETE FROM server_member_roles WHERE server_id = ? AND username = ? AND role_id = ?', serverId, target, role.id);
    await accessChanges.settle(serverId, before);
    await announce(serverId, [target]);
    if (taken.changes > 0) await audit(serverId, req.user.username, AUDIT.roleUnassigned, target, { roleId: role.id, role: role.name });
    return res.json({ success: true });
  }));
}

module.exports = { registerRoleRoutes, ROLE_NAME_MAX, parseRoleName, parseRoleColor, parseRolePermissions };
