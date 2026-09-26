// Group chats: a conversation between three or more people, stored server-side like DMs. Until this
// existed a "group" lived only in the creator's tab, so nobody else ever saw it and it vanished on
// reload.
//
// Rules:
// - Membership is the only permission. Any member can read, post, rename and add people. Only the
//   owner can remove someone else. Anyone can leave.
// - You can only add people you could DM yourself (friends, or someone you share a server with), the
//   same gate as /messages/send, so a group can't be used to reach strangers.
// - Non-members get a 404, never a 403, so a group's existence isn't revealed by guessing ids.
// - Every change is pushed to each member's `user:<name>` room. Clients never have to poll.
const crypto = require('crypto');

const GROUP_MAX_MEMBERS = 25;
const GROUP_NAME_MAX = 60;

/** @param {Record<string, any>} deps */
function registerGroupRoutes({ app, db, io, authMiddleware, getUserByUsername, canDirectMessage, normalizePresence, displayProfileFromSettings, avatarColorForUsername, mapMessageRow, normalizeAttachment, sanitizeQuotes }) {
  const newGroupId = () => `grp-${crypto.randomBytes(8).toString('hex')}`;

  /** @returns {Promise<{ group_id: string, user_id: number, joined_at: number, last_read_at: number } | undefined>} */
  const membership = (groupId, userId) =>
    db.get('SELECT group_id, user_id, joined_at, last_read_at FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);

  // Members in join order. INNER JOIN, so a deleted account simply drops out of the list.
  const membersOf = (groupId) => db.all(
    `SELECT u.id, u.username, u.settings, COALESCE(u.presence_status, 'offline') AS presence_status, gm.joined_at
       FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY gm.joined_at ASC, u.username ASC`,
    groupId
  );

  const memberUsernames = async (groupId) => (await membersOf(groupId)).map((m) => m.username);

  async function unreadCount(groupId, userId, lastReadAt) {
    const row = await db.get(
      'SELECT COUNT(*) AS n FROM group_messages WHERE group_id = ? AND created_at > ? AND sender_id != ?',
      groupId, lastReadAt || 0, userId
    );
    return row ? row.n : 0;
  }

  // What the conversation list needs for one group, as seen by one user (the unread count is theirs).
  async function groupSummary(groupId, userId) {
    const group = await db.get('SELECT id, name, owner_id, created_at FROM group_chats WHERE id = ?', groupId);
    if (!group) return null;
    const members = await membersOf(groupId);
    const mem = await membership(groupId, userId);
    const last = await db.get(
      `SELECT gm.body, gm.attachment_json AS attachmentJson, gm.created_at AS createdAt, u.username AS author
         FROM group_messages gm JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id = ?
        ORDER BY gm.created_at DESC, gm.id DESC LIMIT 1`,
      groupId
    );
    const owner = members.find((m) => m.id === group.owner_id);
    return {
      id: group.id,
      name: group.name || '',
      ownerUsername: owner ? owner.username : null,
      createdAt: group.created_at,
      members: members.map((m) => ({
        id: String(m.id),
        name: m.username,
        peerUsername: m.username,
        avatar: avatarColorForUsername(m.username),
        profile: displayProfileFromSettings(m.settings),
        status: normalizePresence(m.presence_status),
      })),
      lastMessage: last
        ? { text: last.body || (last.attachmentJson ? 'Sent an attachment' : ''), author: last.author, createdAt: last.createdAt }
        : null,
      unreadCount: mem ? await unreadCount(groupId, userId, mem.last_read_at) : 0,
    };
  }

  // Push each member their own copy of the group (unread counts differ per person).
  async function broadcastGroup(groupId) {
    const members = await membersOf(groupId);
    for (const m of members) {
      const group = await groupSummary(groupId, m.id);
      if (group) io.to(`user:${m.username}`).emit('group:updated', { group });
    }
  }

  async function emitToMembers(groupId, event, payload) {
    for (const username of await memberUsernames(groupId)) io.to(`user:${username}`).emit(event, payload);
  }

  // Validate a list of usernames to add. Returns the user rows, or { error, status } for the first
  // problem found.
  async function resolveInvitees(me, usernames, existingIds = new Set()) {
    if (!Array.isArray(usernames)) return { error: 'members must be a list of usernames', status: 400 };
    const unique = [...new Set(usernames.map((u) => String(u || '').trim()).filter(Boolean))];
    const users = [];
    for (const name of unique) {
      const user = await getUserByUsername(name);
      if (!user) return { error: `No user called ${name}`, status: 404 };
      if (user.id === me.id || existingIds.has(user.id)) continue;
      if (!(await canDirectMessage(me.id, me.username, user.id, user.username))) {
        return { error: `You can only add friends or people you share a server with (${name})`, status: 403 };
      }
      users.push(user);
    }
    return { users };
  }

  const cleanName = (raw) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX);

  // Load the caller and their membership in :id, or send the error response and return null.
  async function requireMember(req, res) {
    const me = await getUserByUsername(req.user.username);
    if (!me) { res.status(404).json({ error: 'User not found' }); return null; }
    const groupId = String(req.params.id || '');
    const mem = await membership(groupId, me.id);
    if (!mem) { res.status(404).json({ error: 'Group not found' }); return null; }
    return { me, groupId, mem };
  }

  async function markRead(groupId, me) {
    await db.run('UPDATE group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ?', Date.now(), groupId, me.id);
    // The reader's other windows/devices drop their badge too.
    io.to(`user:${me.username}`).emit('group:read', { groupId });
  }

  // Take a member out. Hands ownership to the longest-standing member if the owner goes, and deletes
  // the group outright once nobody is left.
  async function removeMember(groupId, user) {
    await db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, user.id);
    io.to(`user:${user.username}`).emit('group:removed', { groupId });
    const remaining = await membersOf(groupId);
    if (remaining.length === 0) {
      await db.run('DELETE FROM group_messages WHERE group_id = ?', groupId);
      await db.run('DELETE FROM group_chats WHERE id = ?', groupId);
      return;
    }
    const group = await db.get('SELECT owner_id FROM group_chats WHERE id = ?', groupId);
    if (group && group.owner_id === user.id) {
      await db.run('UPDATE group_chats SET owner_id = ? WHERE id = ?', remaining[0].id, groupId);
    }
    await broadcastGroup(groupId);
  }

  const MESSAGE_SELECT = `SELECT gm.id, gm.body AS text, gm.created_at AS ts, gm.attachment_json, gm.reactions_json, gm.quotes_json, gm.edited_at, u.username AS author
       FROM group_messages gm JOIN users u ON u.id = gm.sender_id`;

  app.get('/groups', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const rows = await db.all('SELECT group_id FROM group_members WHERE user_id = ?', me.id);
    const groups = [];
    for (const r of rows) {
      const g = await groupSummary(r.group_id, me.id);
      if (g) groups.push(g);
    }
    const activity = (g) => (g.lastMessage ? g.lastMessage.createdAt : g.createdAt);
    groups.sort((a, b) => activity(b) - activity(a));
    return res.json({ groups });
  });

  app.post('/groups', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const resolved = await resolveInvitees(me, req.body?.members);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const others = resolved.users;
    // Two people is a DM, and the client opens one of those instead.
    if (others.length < 2) return res.status(400).json({ error: 'A group needs at least two other people' });
    if (others.length + 1 > GROUP_MAX_MEMBERS) return res.status(400).json({ error: `A group can have at most ${GROUP_MAX_MEMBERS} people` });
    const id = newGroupId();
    const now = Date.now();
    await db.run('BEGIN');
    try {
      await db.run('INSERT INTO group_chats (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', id, cleanName(req.body?.name), me.id, now);
      // The creator has "read" everything so far; so has everyone else (there's nothing yet).
      for (const [i, u] of [me, ...others].entries()) {
        await db.run('INSERT INTO group_members (group_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)', id, u.id, now + i, now);
      }
      await db.run('COMMIT');
    } catch (e) {
      await db.run('ROLLBACK').catch(() => {});
      throw e;
    }
    await broadcastGroup(id);
    return res.json({ group: await groupSummary(id, me.id) });
  });

  // Rename. Any member; an empty name falls back to the member list on the client.
  app.patch('/groups/:id', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    if (typeof req.body?.name !== 'string') return res.status(400).json({ error: 'name must be a string' });
    await db.run('UPDATE group_chats SET name = ? WHERE id = ?', cleanName(req.body.name), ctx.groupId);
    await broadcastGroup(ctx.groupId);
    return res.json({ group: await groupSummary(ctx.groupId, ctx.me.id) });
  });

  app.post('/groups/:id/members', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    const current = await membersOf(ctx.groupId);
    const resolved = await resolveInvitees(ctx.me, req.body?.usernames, new Set(current.map((m) => m.id)));
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    if (resolved.users.length === 0) return res.status(400).json({ error: 'Everyone you picked is already in this group' });
    if (current.length + resolved.users.length > GROUP_MAX_MEMBERS) {
      return res.status(400).json({ error: `A group can have at most ${GROUP_MAX_MEMBERS} people` });
    }
    const now = Date.now();
    // New members start "read" as of now: the history is visible, but it isn't all unread.
    for (const [i, u] of resolved.users.entries()) {
      await db.run('INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)', ctx.groupId, u.id, now + i, now);
    }
    await broadcastGroup(ctx.groupId);
    return res.json({ group: await groupSummary(ctx.groupId, ctx.me.id) });
  });

  // Leave (your own name) or remove someone else (owner only).
  app.delete('/groups/:id/members/:username', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    const target = await getUserByUsername(String(req.params.username || '').trim());
    if (!target || !(await membership(ctx.groupId, target.id))) return res.status(404).json({ error: 'Not a member of this group' });
    if (target.id !== ctx.me.id) {
      const group = await db.get('SELECT owner_id FROM group_chats WHERE id = ?', ctx.groupId);
      if (!group || group.owner_id !== ctx.me.id) return res.status(403).json({ error: 'Only the group owner can remove people' });
    }
    await removeMember(ctx.groupId, target);
    return res.json({ success: true });
  });

  app.get('/groups/:id/messages', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    if (req.query.markRead === '1' || req.query.markRead === 'true') await markRead(ctx.groupId, ctx.me);
    const rows = await db.all(`${MESSAGE_SELECT} WHERE gm.group_id = ? ORDER BY gm.created_at ASC, gm.id ASC`, ctx.groupId);
    return res.json({ messages: rows.map((r) => mapMessageRow(r, ctx.me.username)) });
  });

  app.post('/groups/:id/read', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    await markRead(ctx.groupId, ctx.me);
    return res.json({ success: true });
  });

  app.post('/groups/:id/messages', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    const body = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    const attachment = normalizeAttachment(req.body?.attachment);
    if (!body && !attachment) return res.status(400).json({ error: 'Missing message' });
    const quotes = sanitizeQuotes(req.body?.quotes);
    const result = await db.run(
      'INSERT INTO group_messages (group_id, sender_id, body, created_at, attachment_json, quotes_json) VALUES (?, ?, ?, ?, ?, ?)',
      ctx.groupId, ctx.me.id, body, Date.now(),
      attachment ? JSON.stringify(attachment) : null,
      quotes ? JSON.stringify(quotes) : null
    );
    const row = await db.get(`${MESSAGE_SELECT} WHERE gm.id = ?`, result.lastID);
    const message = mapMessageRow(row);
    // Everyone, the sender included: their other windows need it, and the sending tab de-dupes by id.
    await emitToMembers(ctx.groupId, 'group:message', { groupId: ctx.groupId, message });
    return res.json({ success: true, message });
  });

  // Edit — the sender only, and only a text message (same rules as DMs and channels).
  app.patch('/groups/:id/messages/:messageId', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    const id = parseInt(req.params.messageId, 10);
    const body = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!id) return res.status(400).json({ error: 'Invalid message id' });
    if (!body) return res.status(400).json({ error: 'A message needs some text' });
    const msg = await db.get('SELECT sender_id, attachment_json FROM group_messages WHERE id = ? AND group_id = ?', id, ctx.groupId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.sender_id !== ctx.me.id) return res.status(403).json({ error: 'You can only edit your own messages' });
    if (msg.attachment_json) return res.status(400).json({ error: "Messages with an attachment can't be edited" });
    const editedAt = Date.now();
    await db.run('UPDATE group_messages SET body = ?, edited_at = ? WHERE id = ?', body, editedAt, id);
    const payload = { groupId: ctx.groupId, id, text: body, editedAt };
    await emitToMembers(ctx.groupId, 'group:message-edited', payload);
    return res.json({ success: true, ...payload });
  });

  app.delete('/groups/:id/messages/:messageId', authMiddleware, async (req, res) => {
    const ctx = await requireMember(req, res);
    if (!ctx) return;
    const id = parseInt(req.params.messageId, 10);
    if (!id) return res.status(400).json({ error: 'Invalid message id' });
    const msg = await db.get('SELECT sender_id FROM group_messages WHERE id = ? AND group_id = ?', id, ctx.groupId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.sender_id !== ctx.me.id) return res.status(403).json({ error: 'You can only delete your own messages' });
    await db.run('DELETE FROM group_messages WHERE id = ?', id);
    await emitToMembers(ctx.groupId, 'group:message-deleted', { groupId: ctx.groupId, id });
    return res.json({ success: true });
  });

  // For the socket layer (reactions): is this user in the group that owns this message?
  async function groupOfMessageForMember(messageId, userId) {
    const row = await db.get(
      `SELECT gm.group_id FROM group_messages gm
         JOIN group_members mem ON mem.group_id = gm.group_id AND mem.user_id = ?
        WHERE gm.id = ?`,
      userId, messageId
    );
    return row ? row.group_id : null;
  }

  return { groupOfMessageForMember, emitToMembers };
}

module.exports = { registerGroupRoutes, GROUP_MAX_MEMBERS };
