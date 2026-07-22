// Server + channel management: the rail list, unread totals, create/rename/delete for servers
// and channels, private-channel member lists, and membership (roster/invite/kick/role/leave).
// Role checks and the state broadcasts are shared with the socket layer, so they are injected.
/** @param {Record<string, any>} deps */
function registerServerRoutes({ app, db, io, authMiddleware, DEMO_ID, newId, roleOf, isMember, isStaffRole, canManageChannels, visibleChannelsFor, broadcastServerState, validate, inviteInput }) {
  // The rail shows only the servers the user owns or has been invited to. New users start with an
  // empty rail (no server is auto-joined at registration) and land on the home view.
  app.get('/servers', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const mine = await db.all(
      'SELECT s.id, s.name, s.owner, m.role FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.username = ? ORDER BY s.rowid ASC',
      me
    );
    const out = mine.map((s) => ({ id: s.id, name: s.name, owner: s.owner || null, role: s.role }));
    return res.json({ servers: out });
  });

  // Unread message counts per channel, for every server the user belongs to. Only channels the
  // user can see are included (private channels never leak counts to plain members).
  app.get('/unreads', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const counts = await db.all(
      `SELECT m.server_id, m.channel_id, COUNT(*) AS n
       FROM messages m
       LEFT JOIN channel_reads r ON r.username = ? AND r.server_id = m.server_id AND r.channel_id = m.channel_id
       WHERE m.ts > COALESCE(r.last_read_ts, 0) AND m.author != ?
       GROUP BY m.server_id, m.channel_id`,
      me, me
    );
    if (!counts.length) return res.json({ unreads: {} });
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
    return res.json({ unreads });
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

  // Add a channel (owner/admin only for private servers; anyone for the demo commons).
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
    await db.run('INSERT INTO channels (id, server_id, name, type, privacy) VALUES (?, ?, ?, ?, ?)', chId, serverId, name, type, privacy);
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
    }
    await broadcastServerState(serverId);
    return res.json({ channel: { id: chId, name, type, privacy } });
  });

  // Read / manage a private channel's access list (owner/admins only). Public channels have none.
  app.get('/servers/:serverId/channels/:channelId/members', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can view channel access' });
    const rows = await db.all('SELECT username FROM channel_members WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    return res.json({ members: rows.map((r) => r.username) });
  });
  app.post('/servers/:serverId/channels/:channelId/members', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can manage channel access' });
    const u = String((req.body || {}).username || '').trim();
    if (!u) return res.status(400).json({ error: 'Username required' });
    if (!(await isMember(serverId, u))) return res.status(400).json({ error: `${u} isn't a member of this server` });
    await db.run('INSERT OR IGNORE INTO channel_members (server_id, channel_id, username) VALUES (?, ?, ?)', serverId, channelId, u);
    await broadcastServerState(serverId);
    io.to(`user:${u}`).emit('servers:updated'); // nudge the newly-granted user to refresh
    return res.json({ success: true });
  });
  app.delete('/servers/:serverId/channels/:channelId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, channelId, username } = req.params;
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can manage channel access' });
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND channel_id = ? AND username = ?', serverId, channelId, username);
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });

  // Rebroadcast a server's state (role-filtered per socket).
  async function pushServerState(serverId) { await broadcastServerState(serverId); }

  // Rename a server (owner/admin; the public commons can't be renamed).
  app.patch('/servers/:serverId', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "The public server can't be renamed" });
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can rename it' });
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Server name required' });
    await db.run('UPDATE servers SET name = ? WHERE id = ?', name, serverId);
    io.emit('servers:updated');
    await pushServerState(serverId);
    return res.json({ server: { id: serverId, name } });
  });

  // Delete a server (owner only; the default commons is protected).
  app.delete('/servers/:serverId', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'The default server cannot be deleted' });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Only the owner can delete this server' });
    const members = await db.all('SELECT username FROM server_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM messages WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channels WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channel_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_emojis WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM servers WHERE id = ?', serverId);
    for (const m of members) io.to(`user:${m.username}`).emit('servers:updated'); // drop it from every member's rail
    return res.json({ success: true });
  });

  // Rename a channel (owner/admin).
  app.patch('/servers/:serverId/channels/:channelId', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can rename channels' });
    const name = String((req.body || {}).name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Channel name required' });
    await db.run('UPDATE channels SET name = ? WHERE id = ?', name, channelId);
    await pushServerState(serverId);
    return res.json({ channel: { id: channelId, name } });
  });

  // Delete a channel (owner/admin). A server always keeps at least one text channel.
  app.delete('/servers/:serverId/channels/:channelId', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    const ch = await db.get('SELECT id, type FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can delete channels' });
    if (ch.type === 'text') {
      const textCount = await db.get("SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND type = 'text'", serverId);
      if ((textCount?.n || 0) <= 1) return res.status(400).json({ error: 'A server needs at least one text channel' });
    }
    await db.run('DELETE FROM messages WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    await db.run('DELETE FROM channels WHERE id = ?', channelId);
    await pushServerState(serverId);
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

  // Invite a user by username (owner/admin) → they become a member; their rail refreshes.
  app.post('/servers/:serverId/invite', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'Everyone is already in the public server' });
    const srv = await db.get('SELECT id, name FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can invite' });
    const invite = validate(inviteInput, req.body);
    if (!invite.ok) return res.status(400).json({ error: invite.error });
    const target = invite.data.username;
    const user = await db.get('SELECT username FROM users WHERE username = ?', target);
    if (!user) return res.status(404).json({ error: `No user named "${target}"` });
    if (await isMember(serverId, target)) return res.status(400).json({ error: `${target} is already a member` });
    await db.run('INSERT INTO server_members (server_id, username, role) VALUES (?, ?, ?)', serverId, target, 'member');
    io.to(`user:${target}`).emit('servers:updated');
    io.to(`user:${target}`).emit('server:invited', { serverId, name: srv.name, by: req.user.username });
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });

  // Kick a member (owner/admin). Can't kick the owner; admins can't kick other admins.
  app.delete('/servers/:serverId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, username: target } = req.params;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "You can't kick from the public server" });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    const myRole = await roleOf(serverId, req.user.username);
    if (!isStaffRole(myRole)) return res.status(403).json({ error: 'Only server admins can remove members' });
    if (target === srv.owner) return res.status(400).json({ error: "The owner can't be removed" });
    const targetRole = await roleOf(serverId, target);
    if (!targetRole) return res.status(404).json({ error: 'Not a member' });
    if (myRole === 'admin' && targetRole === 'admin') return res.status(403).json({ error: "Admins can't remove other admins" });
    await db.run('DELETE FROM server_members WHERE server_id = ? AND username = ?', serverId, target);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND username = ?', serverId, target);
    io.to(`user:${target}`).emit('servers:updated');
    io.to(`user:${target}`).emit('server:removed', { serverId });
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });

  // Change a member's role: owner promotes/demotes between admin and member.
  app.patch('/servers/:serverId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, username: target } = req.params;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'No roles in the public server' });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Only the owner can change roles' });
    if (target === srv.owner) return res.status(400).json({ error: "The owner's role can't change" });
    const role = (req.body || {}).role === 'admin' ? 'admin' : 'member';
    if (!(await isMember(serverId, target))) return res.status(404).json({ error: 'Not a member' });
    await db.run('UPDATE server_members SET role = ? WHERE server_id = ? AND username = ?', role, serverId, target);
    io.to(`user:${target}`).emit('servers:updated');
    await broadcastServerState(serverId);
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
    io.to(`user:${me}`).emit('servers:updated');
    io.to(`user:${me}`).emit('server:removed', { serverId });
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });
}

module.exports = { registerServerRoutes };
