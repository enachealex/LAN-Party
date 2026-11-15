// Server + channel management: the rail list, unread totals, create/rename/delete for servers
// and channels, private-channel access lists, and membership (roster/invite/kick/role/leave).
// Who may do what is services/permissions.js: every check here asks it, by permission name. The
// state broadcasts are shared with the socket layer, so they are injected.
const { mentionedUsernames } = require('../services/push');
const { parsePageQuery, fetchPage, channelHistory } = require('../services/history');
const { rateLimit } = require('../rateLimit');
const { AUDIT } = require('../services/moderation');

// Resetting app rooms ends every app running in the server and orphans what apps stored for its
// channels, so it is not something to do in a loop. Counted per account (the route knows who is
// asking), and generous enough for someone who is actually cleaning up after a problem.
const APP_ROOMS_RESET_LIMIT = {
  id: 'app-rooms-reset', windowMs: 10 * 60_000, max: 10,
  message: 'App rooms were reset several times just now. Wait a few minutes before doing it again.',
  keyOf: (/** @type {any} */ req) => req.user && req.user.username,
};

/** @param {Record<string, any>} deps */
function registerServerRoutes({ app, db, io, authMiddleware, DEMO_ID, newId, permissions, accessChanges, mapMessageRow, broadcastServerState, validate, inviteInput, receiveTileIcon, removeTileIconFile, appRooms, endAppActivitiesInServer, enforceVoiceAccess, enforceTextAccess, moderation, blocks, notificationSettings, requireVerified }) {
  const { roleOf, isMember, can, canAccessChannel, visibleChannelsFor } = permissions;
  // The commons is open (anyone may add a public channel there); elsewhere it is manage_channels.
  const canManageChannels = permissions.mayManageChannels;
  // The audit log (services/moderation.js): who did what in a server. Written after the action
  // itself, never before; it does nothing for the commons and never fails the request.
  const audit = moderation.audit;

  // "Not written by someone this user has blocked", for a query over `messages m`. One parameter:
  // the reader's username.
  const NOT_BLOCKED_AUTHOR = `m.author NOT IN (
         SELECT bu.username FROM user_blocks b
           JOIN users me ON me.id = b.blocker_id
           JOIN users bu ON bu.id = b.blocked_id
          WHERE me.username = ?)`;

  // The rail shows only the servers the user owns or has been invited to. New users start with an
  // empty rail (no server is auto-joined at registration) and land on the home view.
  app.get('/servers', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const mine = await db.all(
      'SELECT s.id, s.name, s.owner, s.icon_url, m.role FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.username = ? ORDER BY s.rowid ASC',
      me
    );
    // permissions: what the caller may do in each server, so the rail's menus can offer the right
    // entries for a server that is not the one on screen. Advice for the client; nothing trusts it.
    const out = [];
    for (const s of mine) {
      out.push({ id: s.id, name: s.name, owner: s.owner || null, role: s.role, iconUrl: s.icon_url || null, permissions: [...await permissions.permissionsOf(s.id, me)] });
    }
    return res.json({ servers: out });
  });

  // Unread message counts per channel, for every server the user belongs to. Only channels the
  // user can see are included (private channels never leak counts to plain members).
  //
  // `notifications` is everything the caller has set a notification level for
  // (services/notificationSettings.js). It rides along because it is what turns these counts into
  // badges: a muted channel's count is still here (its row shows it, dimmed) and it is the client
  // that leaves it out of the server tile's badge. Sent in the same answer so that the counts and
  // the levels they are read with can never be from two different moments.
  app.get('/unreads', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const notifications = await notificationSettings.settingsOfUsername(me);
    // Messages from someone the caller has blocked are not counted, here or among the mentions
    // below: a blocked person must not be able to light up a badge (services/blocks.js).
    const counts = await db.all(
      `SELECT m.server_id, m.channel_id, COUNT(*) AS n
       FROM messages m
       LEFT JOIN channel_reads r ON r.username = ? AND r.server_id = m.server_id AND r.channel_id = m.channel_id
       WHERE m.ts > COALESCE(r.last_read_ts, 0) AND m.author != ? AND ${NOT_BLOCKED_AUTHOR}
       GROUP BY m.server_id, m.channel_id`,
      me, me, me
    );
    if (!counts.length) return res.json({ unreads: {}, mentions: {}, notifications });
    // Roles for my servers, from membership rows (no implicit public server anymore).
    const memberships = await db.all('SELECT server_id, role FROM server_members WHERE username = ?', me);
    const myRole = new Map(memberships.map((m) => [m.server_id, m.role]));
    const serverIds = [...new Set(counts.map((c) => c.server_id))].filter((id) => myRole.has(id));
    const unreads = {};
    for (const sid of serverIds) {
      const chans = await db.all("SELECT id, COALESCE(privacy,'public') AS privacy FROM channels WHERE server_id = ?", sid);
      const visible = new Set((await visibleChannelsFor(sid, chans, me, myRole.get(sid))).map((c) => c.id));
      for (const c of counts) {
        if (c.server_id !== sid || !visible.has(c.channel_id)) continue;
        (unreads[sid] ||= {})[c.channel_id] = c.n;
      }
    }
    // Of those unread messages, how many mention me — so the "@" badge survives a reload instead of
    // existing only for mentions that arrived while this tab happened to be open. The LIKE is a cheap
    // pre-filter; mentionedUsernames is the one definition of a mention (the push and the live badge
    // use it too), so "@sam" inside "@samantha" or an email address does not count.
    const candidates = await db.all(
      `SELECT m.server_id, m.channel_id, m.text
       FROM messages m
       LEFT JOIN channel_reads r ON r.username = ? AND r.server_id = m.server_id AND r.channel_id = m.channel_id
       WHERE m.ts > COALESCE(r.last_read_ts, 0) AND m.author != ? AND m.text LIKE '%@' || ? || '%' AND ${NOT_BLOCKED_AUTHOR}`,
      me, me, me, me
    );
    const mentions = {};
    for (const row of candidates) {
      if (!unreads[row.server_id] || unreads[row.server_id][row.channel_id] == null) continue; // not a channel I can see
      if (!mentionedUsernames(row.text).includes(me)) continue;
      (mentions[row.server_id] ||= {})[row.channel_id] = (mentions[row.server_id][row.channel_id] || 0) + 1;
    }
    return res.json({ unreads, mentions, notifications });
  });

  // Create a server: the creator becomes its owner + first member.
  app.post('/servers', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Server name required' });
    const id = newId('srv');
    await db.run('INSERT INTO servers (id, name, owner) VALUES (?, ?, ?)', id, name, me);
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', newId('ch'), id, 'general', 'text');
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', newId('ch'), id, 'Voice 1', 'voice');
    await db.run('INSERT INTO server_members (server_id, username, role) VALUES (?, ?, ?)', id, me, 'owner');
    io.to(`user:${me}`).emit('servers:updated'); // only the owner has it so far
    return res.json({ server: { id, name, owner: me, role: 'owner' } });
  });

  // Add a channel (manage_channels; anyone for the demo commons).
  app.post('/servers/:serverId/channels', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can create channels' });
    const name = String((req.body || {}).name || '').trim().slice(0, 30);
    const type = (req.body || {}).type === 'voice' ? 'voice' : 'text';
    // The public commons can't have private channels (nobody would ever see them — no admins).
    const privacy = (serverId !== DEMO_ID && (req.body || {}).privacy === 'private') ? 'private' : 'public';
    if (!name) return res.status(400).json({ error: 'Channel name required' });
    const chId = newId('ch');
    // Straight into a category when one is named (never in the commons, which has none). A
    // category of another server, or one that is gone, is ignored rather than refused: the
    // channel is still made, just not filed.
    const wantedCategory = typeof (req.body || {}).categoryId === 'string' && serverId !== DEMO_ID ? (req.body || {}).categoryId : null;
    const category = wantedCategory ? await db.get('SELECT id FROM channel_categories WHERE id = ? AND server_id = ?', wantedCategory, serverId) : null;
    await db.run('INSERT INTO channels (id, server_id, name, type, privacy, category_id) VALUES (?, ?, ?, ?, ?, ?)', chId, serverId, name, type, privacy, category ? category.id : null);
    // For a private channel, grant the requested members access (must be members of this server).
    // Staff (owner/admins) always have access, so they don't need a row.
    if (privacy === 'private') {
      const requested = Array.isArray((req.body || {}).members) ? (req.body || {}).members : [];
      const seen = new Set();
      for (const uRaw of requested.slice(0, 100)) {
        const u = String(uRaw || '').trim();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        if (await isMember(serverId, u)) await db.run('INSERT OR IGNORE INTO channel_members (server_id, channel_id, username) VALUES (?, ?, ?)', serverId, chId, u);
      }
      // ...and the requested roles (must be roles of this server): everyone who holds one gets in.
      const wantedRoles = Array.isArray((req.body || {}).roles) ? (req.body || {}).roles : [];
      const known = new Set((await permissions.listRoles(serverId)).map((r) => r.id));
      for (const roleId of new Set(wantedRoles.slice(0, 50))) {
        if (typeof roleId === 'string' && known.has(roleId)) await db.run('INSERT OR IGNORE INTO channel_roles (server_id, channel_id, role_id) VALUES (?, ?, ?)', serverId, chId, roleId);
      }
    }
    await broadcastServerState(serverId);
    await audit(serverId, req.user.username, AUDIT.channelCreated, null, { channelId: chId, name, type, privacy });
    return res.json({ channel: { id: chId, name, type, privacy, categoryId: category ? category.id : null } });
  });

  // A page of a channel's history: what the client asks for when the reader scrolls back, or jumps
  // to a search result. Held to the rule joinChannel applies (the channel belongs to the server and
  // this user may open it), since it returns exactly what joining would. It deliberately does not
  // mark the channel read: fetching older messages says nothing about having seen the newest ones.
  app.get('/servers/:serverId/channels/:channelId/messages', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    const ch = await db.get("SELECT id, COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    const role = await roleOf(serverId, req.user.username);
    if (!(await canAccessChannel(serverId, channelId, req.user.username, ch.privacy, role))) {
      return res.status(403).json({ error: 'You do not have access to this channel' });
    }
    const page = parsePageQuery(req.query);
    if ('error' in page) return res.status(400).json({ error: page.error });
    const { rows, hasMore, hasMoreAfter } = await fetchPage(db, channelHistory(serverId, channelId), page);
    // Messages from people the reader has blocked stay in the page, marked, so the client can
    // collapse them: taking them out would leave everyone else's replies answering nothing.
    const blocked = await blocks.blockedBy(req.user.username);
    return res.json({ messages: rows.map((m) => mapMessageRow(m, req.user.username, blocked)), hasMore, hasMoreAfter });
  });

  // Which channel an audit entry is about: its id, and its name as it was at the time (the log
  // has to stay readable after the channel is renamed or deleted).
  async function channelDetail(serverId, channelId) {
    const ch = await db.get('SELECT name FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    return { channelId, channel: ch ? ch.name : null };
  }

  // Read / manage a private channel's access list (manage_channels). Public channels have none.
  // The list names members (channel_members) and roles (channel_roles); the owner, admins and
  // anyone with manage_channels can open every channel without being on it.
  app.get('/servers/:serverId/channels/:channelId/members', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    if (!(await can(serverId, req.user.username, 'manage_channels'))) return res.status(403).json({ error: 'Only server admins can view channel access' });
    const rows = await db.all('SELECT username FROM channel_members WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    const roles = await db.all(
      `SELECT cr.role_id FROM channel_roles cr JOIN server_roles r ON r.id = cr.role_id AND r.server_id = cr.server_id
        WHERE cr.server_id = ? AND cr.channel_id = ?`,
      serverId, channelId
    );
    return res.json({ members: rows.map((r) => r.username), roles: roles.map((r) => r.role_id) });
  });
  app.post('/servers/:serverId/channels/:channelId/members', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    if (!(await can(serverId, req.user.username, 'manage_channels'))) return res.status(403).json({ error: 'Only server admins can manage channel access' });
    const u = String((req.body || {}).username || '').trim();
    if (!u) return res.status(400).json({ error: 'Username required' });
    if (!(await isMember(serverId, u))) return res.status(400).json({ error: `${u} isn't a member of this server` });
    const granted = await db.run('INSERT OR IGNORE INTO channel_members (server_id, channel_id, username) VALUES (?, ?, ?)', serverId, channelId, u);
    await broadcastServerState(serverId);
    io.to(`user:${u}`).emit('servers:updated'); // nudge the newly-granted user to refresh
    if (granted.changes > 0) await audit(serverId, req.user.username, AUDIT.accessGranted, u, await channelDetail(serverId, channelId));
    return res.json({ success: true });
  });
  app.delete('/servers/:serverId/channels/:channelId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, channelId, username } = req.params;
    if (!(await can(serverId, req.user.username, 'manage_channels'))) return res.status(403).json({ error: 'Only server admins can manage channel access' });
    const before = await accessChanges.snapshot(serverId, [username]);
    const removed = await db.run('DELETE FROM channel_members WHERE server_id = ? AND channel_id = ? AND username = ?', serverId, channelId, username);
    // They can no longer open this channel, so the room keys they collected in it are revoked
    // (services/appRooms.js), and if they are sitting in its voice room right now, or have it open
    // as text, they are taken out of it. Only when something was really taken away, which is what
    // settle() works out: a name that was not on the list changes nothing, and neither does a row
    // for someone who can open the channel anyway (an owner or admin, a manager of channels, a
    // holder of a role that is on the list).
    await accessChanges.settle(serverId, before);
    await broadcastServerState(serverId);
    if (removed.changes > 0) await audit(serverId, req.user.username, AUDIT.accessRemoved, username, await channelDetail(serverId, channelId));
    return res.json({ success: true });
  });

  // A role on a private channel's list: everyone who holds it can open the channel, now and for
  // as long as they hold it. Both the channel and the role have to belong to the server in the URL.
  async function channelAndRole(req, res) {
    const { serverId, channelId } = req.params;
    if (serverId === DEMO_ID) { res.status(400).json({ error: 'The public server has no private channels' }); return null; }
    if (!(await can(serverId, req.user.username, 'manage_channels'))) { res.status(403).json({ error: 'Only server admins can manage channel access' }); return null; }
    const ch = await db.get('SELECT id, name FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    if (!ch) { res.status(404).json({ error: 'Channel not found' }); return null; }
    const roleId = String(req.params.roleId || (req.body || {}).roleId || '');
    const role = await db.get('SELECT id, name FROM server_roles WHERE id = ? AND server_id = ?', roleId, serverId);
    if (!role) { res.status(404).json({ error: 'Role not found' }); return null; }
    return { serverId, ch, role };
  }
  app.post('/servers/:serverId/channels/:channelId/roles', authMiddleware, async (req, res) => {
    const ctx = await channelAndRole(req, res);
    if (!ctx) return undefined;
    const { serverId, ch, role } = ctx;
    const granted = await db.run('INSERT OR IGNORE INTO channel_roles (server_id, channel_id, role_id) VALUES (?, ?, ?)', serverId, ch.id, role.id);
    await broadcastServerState(serverId);
    if (granted.changes > 0) await audit(serverId, req.user.username, AUDIT.accessRoleGranted, null, { channelId: ch.id, channel: ch.name, roleId: role.id, role: role.name });
    return res.json({ success: true });
  });
  app.delete('/servers/:serverId/channels/:channelId/roles/:roleId', authMiddleware, async (req, res) => {
    const ctx = await channelAndRole(req, res);
    if (!ctx) return undefined;
    const { serverId, ch, role } = ctx;
    // Everyone who holds the role may be about to lose the channel; who really does (not someone
    // also listed by name, or holding another listed role) is settle()'s to work out.
    const holders = (await db.all('SELECT username FROM server_member_roles WHERE server_id = ? AND role_id = ?', serverId, role.id)).map((r) => r.username);
    const before = await accessChanges.snapshot(serverId, holders);
    const removed = await db.run('DELETE FROM channel_roles WHERE server_id = ? AND channel_id = ? AND role_id = ?', serverId, ch.id, role.id);
    await accessChanges.settle(serverId, before);
    await broadcastServerState(serverId);
    if (removed.changes > 0) await audit(serverId, req.user.username, AUDIT.accessRoleRemoved, null, { channelId: ch.id, channel: ch.name, roleId: role.id, role: role.name });
    return res.json({ success: true });
  });

  // Rebroadcast a server's state (role-filtered per socket).
  async function pushServerState(serverId) { await broadcastServerState(serverId); }

  // The links someone minted are revoked the moment they can no longer invite here (kicked,
  // demoted, or gone of their own accord); see services/accessChanges.js for why.
  const { revokeInvitesBy } = accessChanges;

  // Rename a server (manage_server; the public commons can't be renamed).
  app.patch('/servers/:serverId', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "The public server can't be renamed" });
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!(await can(serverId, req.user.username, 'manage_server'))) return res.status(403).json({ error: 'Only server admins can rename it' });
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Server name required' });
    await db.run('UPDATE servers SET name = ? WHERE id = ?', name, serverId);
    io.emit('servers:updated');
    await pushServerState(serverId);
    if (name !== srv.name) await audit(serverId, req.user.username, AUDIT.serverRenamed, null, { from: srv.name, to: name });
    return res.json({ server: { id: serverId, name } });
  });

  // Set a server's tile icon (manage_server). Shared, not per-viewer: everyone in the rail sees it, so
  // it lives on the server row and every member is told to refresh.
  app.post('/servers/:serverId/icon', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "The public server's icon can't be changed" });
    const srv = await db.get('SELECT id, icon_url FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    // Permission BEFORE the upload, so a non-admin's bytes are never written to disk.
    if (!(await can(serverId, req.user.username, 'manage_server'))) return res.status(403).json({ error: 'Only server admins can change the icon' });
    const saved = await receiveTileIcon(req, res);
    if (!saved) return undefined; // receiveTileIcon already answered
    await db.run('UPDATE servers SET icon_url = ? WHERE id = ?', saved.url, serverId);
    if (srv.icon_url && srv.icon_url !== saved.url) removeTileIconFile(srv.icon_url);
    io.emit('servers:updated'); // every member's rail re-reads the list
    await pushServerState(serverId);
    await audit(serverId, req.user.username, AUDIT.serverIcon, null, { change: 'set' });
    return res.json({ success: true, url: saved.url });
  });

  // Clear a server's tile icon, falling back to the coloured initials (manage_server).
  app.delete('/servers/:serverId/icon', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const srv = await db.get('SELECT id, icon_url FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!(await can(serverId, req.user.username, 'manage_server'))) return res.status(403).json({ error: 'Only server admins can change the icon' });
    await db.run('UPDATE servers SET icon_url = NULL WHERE id = ?', serverId);
    if (srv.icon_url) removeTileIconFile(srv.icon_url);
    io.emit('servers:updated');
    await pushServerState(serverId);
    if (srv.icon_url) await audit(serverId, req.user.username, AUDIT.serverIcon, null, { change: 'cleared' });
    return res.json({ success: true });
  });

  // Delete a server (owner only; the default commons is protected).
  app.delete('/servers/:serverId', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'The default server cannot be deleted' });
    const srv = await db.get('SELECT id, owner, icon_url FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Only the owner can delete this server' });
    const members = await db.all('SELECT username FROM server_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM messages WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channels WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channel_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_emojis WHERE server_id = ?', serverId);
    // A link to a server that no longer exists must stop resolving, not sit there as a dead row.
    await db.run('DELETE FROM server_invites WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_removed WHERE server_id = ?', serverId);
    await moderation.forgetServer(serverId); // its bans, timeouts and audit log go with it
    await permissions.forgetServer(serverId); // and its roles, who held them, and its categories
    await notificationSettings.forgetServer(serverId); // and what anyone set its notifications to
    await db.run('DELETE FROM server_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM servers WHERE id = ?', serverId);
    // Nobody is a member any more, and there is no epoch left to bump (services/appRooms.js): the
    // apps still running in its voice rooms are ended, and no room key is made for it again.
    endAppActivitiesInServer(serverId, 'rooms-reset');
    if (srv.icon_url) removeTileIconFile(srv.icon_url); // otherwise the icon outlives its server
    for (const m of members) io.to(`user:${m.username}`).emit('servers:updated'); // drop it from every member's rail
    return res.json({ success: true });
  });

  // Rename a channel (manage_channels).
  app.patch('/servers/:serverId/channels/:channelId', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    const ch = await db.get('SELECT id, name FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can rename channels' });
    const name = String((req.body || {}).name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Channel name required' });
    await db.run('UPDATE channels SET name = ? WHERE id = ?', name, channelId);
    await pushServerState(serverId);
    if (name !== ch.name) await audit(serverId, req.user.username, AUDIT.channelRenamed, null, { channelId, from: ch.name, to: name });
    return res.json({ channel: { id: channelId, name } });
  });

  // Delete a channel (manage_channels). A server always keeps at least one text channel.
  app.delete('/servers/:serverId/channels/:channelId', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    const ch = await db.get('SELECT id, name, type FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can delete channels' });
    if (ch.type === 'text') {
      const textCount = await db.get("SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND type = 'text'", serverId);
      if ((textCount?.n || 0) <= 1) return res.status(400).json({ error: 'A server needs at least one text channel' });
    }
    await db.run('DELETE FROM messages WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    await db.run('DELETE FROM channel_roles WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    await notificationSettings.forgetChannel(channelId);
    await db.run('DELETE FROM channels WHERE id = ?', channelId);
    await pushServerState(serverId);
    await audit(serverId, req.user.username, AUDIT.channelDeleted, null, { channelId, name: ch.name, type: ch.type });
    return res.json({ success: true });
  });

  // --- Membership management: invite, kick, roles, leave ---
  // Current members of a server (any member may read) — used by the invite dialog to mark which
  // friends are already in.
  app.get('/servers/:serverId/members', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const srv = await db.get('SELECT id FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!(await isMember(serverId, req.user.username))) return res.status(403).json({ error: 'Not a member' });
    const members = await db.all('SELECT username, role FROM server_members WHERE server_id = ?', serverId);
    return res.json({ members });
  });

  // Invite a user by username (the invite permission) → they become a member; their rail refreshes.
  // requireVerified: pulling someone into a server is not for an account that has not confirmed
  // its email (services/emailVerification.js).
  app.post('/servers/:serverId/invite', authMiddleware, requireVerified, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'Everyone is already in the public server' });
    const srv = await db.get('SELECT id, name FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!(await can(serverId, req.user.username, 'invite'))) return res.status(403).json({ error: 'Only server admins can invite' });
    const invite = validate(inviteInput, req.body);
    if (!invite.ok) return res.status(400).json({ error: invite.error });
    const target = invite.data.username;
    const user = await db.get('SELECT username FROM users WHERE username = ?', target);
    if (!user) return res.status(404).json({ error: `No user named "${target}"` });
    if (await isMember(serverId, target)) return res.status(400).json({ error: `${target} is already a member` });
    // A ban is not lifted by inviting: that is the difference between it and a kick, which the
    // lines below do undo. Staff are told why, since they can read the ban list anyway.
    if (await moderation.banOf(serverId, target)) return res.status(403).json({ error: `${target} is banned from this server. Unban them first.` });
    await db.run('INSERT INTO server_members (server_id, username, role) VALUES (?, ?, ?)', serverId, target, 'member');
    // Staff asking for someone by name is the way back in after a kick, so it lifts the block that
    // keeps a removed person from rejoining through an invite link.
    await db.run('DELETE FROM server_removed WHERE server_id = ? AND username = ?', serverId, target);
    io.to(`user:${target}`).emit('servers:updated');
    io.to(`user:${target}`).emit('server:invited', { serverId, name: srv.name, by: req.user.username });
    await broadcastServerState(serverId);
    await audit(serverId, req.user.username, AUDIT.invited, target);
    return res.json({ success: true });
  });

  // Kick a member (the kick permission). Only someone ranked strictly below you: never the owner,
  // an admin never another admin, a role holder never an admin or their own rank
  // (permissions.mayActOn). The answers are worded as they always were.
  app.delete('/servers/:serverId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, username: target } = req.params;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "You can't kick from the public server" });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    const allowed = await permissions.mayActOn(serverId, req.user.username, target, 'kick');
    if (!allowed.ok && allowed.reason === 'no-permission') return res.status(403).json({ error: 'Only server admins can remove members' });
    if (target === srv.owner) return res.status(400).json({ error: "The owner can't be removed" });
    if (!allowed.targetRole) return res.status(404).json({ error: 'Not a member' });
    if (!allowed.ok) {
      const sideways = allowed.actorRole === 'admin' && allowed.targetRole === 'admin';
      return res.status(403).json({ error: sideways ? "Admins can't remove other admins" : 'You can only remove members ranked below you' });
    }
    await removeMemberFromServer(serverId, target, req.user.username);
    await audit(serverId, req.user.username, AUDIT.kick, target);
    return res.json({ success: true });
  });

  // Take a member out of a server: everything a kick does, in the order it has to happen. A ban
  // (routes/moderation.js) runs this too, so the two can never drift apart; `banned` only changes
  // what the removed person's own client is told. A kick is "removed, and staff may invite them
  // back"; what makes a ban hold beyond that is its own row (services/moderation.js).
  async function removeMemberFromServer(serverId, target, by, { banned = false } = {}) {
    await db.run('DELETE FROM server_members WHERE server_id = ? AND username = ?', serverId, target);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND username = ?', serverId, target);
    await permissions.forgetMember(serverId, target); // the roles they held here do not wait for them
    await notificationSettings.forgetMember(serverId, target); // nor do their notification levels
    // A kick has to hold against invite links too. Remembering who was removed is what stops them
    // rejoining through ANY live link (one they were sent, one a friend forwards); revoking the ones
    // they minted stops them handing the server out to others.
    await db.run(
      'INSERT OR REPLACE INTO server_removed (server_id, username, removed_by, removed_at) VALUES (?, ?, ?, ?)',
      serverId, target, by, Date.now()
    );
    await revokeInvitesBy(serverId, target);
    // And against the apps they joined here: they still hold those channels' room keys, which is
    // all an app's own server asks for. New keys for the whole server (services/appRooms.js).
    // After the rows above are gone, so that they cannot be handed one of the new keys.
    await appRooms.rotate(serverId);
    // Out of the server means out of its calls, now — not whenever they next hang up. And out of
    // its text channels: a socket that still had one open would go on receiving every message.
    await enforceVoiceAccess(target, serverId);
    await enforceTextAccess(target, serverId);
    io.to(`user:${target}`).emit('servers:updated');
    io.to(`user:${target}`).emit('server:removed', banned ? { serverId, banned: true } : { serverId });
    await broadcastServerState(serverId);
  }

  // Change a member's role: owner promotes/demotes between admin and member.
  app.patch('/servers/:serverId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, username: target } = req.params;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'No roles in the public server' });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Only the owner can change roles' });
    if (target === srv.owner) return res.status(400).json({ error: "The owner's role can't change" });
    const role = (req.body || {}).role === 'admin' ? 'admin' : 'member';
    const before = await roleOf(serverId, target);
    if (!before) return res.status(404).json({ error: 'Not a member' });
    const reach = await accessChanges.snapshot(serverId, [target]);
    await db.run('UPDATE server_members SET role = ? WHERE server_id = ? AND username = ?', role, serverId, target);
    // An admin can open every private channel and mint invite links; a member only what they are
    // listed on, or what a custom role of theirs gives them. So a demotion can take channels away
    // just as a removal from their lists would, and the room keys go with them
    // (services/appRooms.js), and the links they minted are revoked if they can no longer invite.
    // Not when it takes nothing away: a server with no private channel the person is missing from
    // keeps its apps running through a role change (services/accessChanges.js).
    await accessChanges.settle(serverId, reach);
    io.to(`user:${target}`).emit('servers:updated');
    await broadcastServerState(serverId);
    if (before !== role) await audit(serverId, req.user.username, AUDIT.role, target, { from: before, to: role });
    return res.json({ success: true, role });
  });

  // Leave a server (any non-owner member). The owner must delete the server instead.
  app.post('/servers/:serverId/leave', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const me = req.user.username;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "You can't leave the public server" });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner === me) return res.status(400).json({ error: 'Owners must delete the server instead of leaving' });
    if (!(await isMember(serverId, me))) return res.status(400).json({ error: 'Not a member' });
    await db.run('DELETE FROM server_members WHERE server_id = ? AND username = ?', serverId, me);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND username = ?', serverId, me);
    await permissions.forgetMember(serverId, me);
    await notificationSettings.forgetMember(serverId, me);
    // An admin who walks out takes their links with them. Nothing is written to server_removed:
    // leaving is not being removed, so they may come back through a link someone else made.
    await revokeInvitesBy(serverId, me);
    // Leaving is not being removed, but it ends their claim on the server's app rooms all the
    // same: they walk out holding room keys, so the server gets new ones (services/appRooms.js).
    await appRooms.rotate(serverId);
    await enforceVoiceAccess(me, serverId);
    await enforceTextAccess(me, serverId);
    io.to(`user:${me}`).emit('servers:updated');
    io.to(`user:${me}`).emit('server:removed', { serverId });
    await broadcastServerState(serverId);
    await audit(serverId, me, AUDIT.left);
    return res.json({ success: true });
  });

  // Reset app rooms (manage_server): give every voice channel of this server a new room key for
  // every app, by hand. For when a key may have got out some other way than someone leaving, which
  // rotates on its own. Apps running in the server are ended (they are on the old keys), and what
  // an app's own server kept for a channel is no longer where that channel leads.
  // Not for the commons: it has no staff, and its rooms are everyone's (services/appRooms.js).
  app.post('/servers/:serverId/app-rooms/reset', authMiddleware, rateLimit(APP_ROOMS_RESET_LIMIT), async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "App rooms can't be reset in the public server" });
    const srv = await db.get('SELECT id FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!(await can(serverId, req.user.username, 'manage_server'))) return res.status(403).json({ error: 'Only server admins can reset app rooms' });
    const epoch = await appRooms.rotate(serverId);
    await audit(serverId, req.user.username, AUDIT.appRoomsReset);
    return res.json({ success: true, epoch });
  });

  return { removeMemberFromServer };
}

module.exports = { registerServerRoutes };
