// Notification levels, the route half of services/notificationSettings.js: read everything the
// caller has set, and set or clear one thing.
//
// Rules:
// - A setting is always the caller's own. Nothing here accepts a username to act for.
// - Setting a level needs the thing to be the caller's to hear from: a server they are in, a text
//   channel they can open, a person who exists, a group they are in. Every refusal for a channel or
//   a group is the same 404, so asking cannot reveal that a private channel or a group exists.
// - Clearing (level null) needs none of that: it only removes the caller's own row, which is how a
//   client drops a setting for something that has since gone.
// - Every change goes to all of the caller's sockets ('notifications:updated', the whole settings
//   object), so a second device follows without reloading.
const { rateLimit } = require('../rateLimit');
const { isLevel, DEFAULT_LEVEL } = require('../services/notificationSettings');

// Counted per account. One click is one request; this is for a client stuck in a loop.
const SET_LIMIT = { id: 'notification-settings', windowMs: 60_000, max: 120, keyOf: (/** @type {any} */ req) => req.user && req.user.username };

const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 100;

/** @param {Record<string, any>} deps */
function registerNotificationRoutes({ app, db, io, authMiddleware, permissions, notificationSettings, emitDmUnreadUpdate }) {
  const { roleOf, canAccessChannel } = permissions;

  app.get('/notifications/settings', authMiddleware, async (req, res) => {
    return res.json({ settings: await notificationSettings.settingsOfUsername(req.user.username) });
  });

  // Body: { scope: 'server', serverId, level } | { scope: 'channel', serverId, channelId, level }
  //     | { scope: 'dm', userId, level } | { scope: 'group', groupId, level }
  // level: 'all' | 'mentions' | 'none' for a server or channel; 'none' (muted) for a DM or group;
  // null to go back to the default.
  app.put('/notifications/settings', authMiddleware, rateLimit(SET_LIMIT), async (req, res) => {
    const body = req.body || {};
    const me = await db.get('SELECT id, username FROM users WHERE username = ?', req.user.username);
    // A token outlives its account (rename, deletion) until it expires.
    if (!me) return res.status(401).json({ error: 'Account not found' });
    const level = body.level === undefined ? null : body.level;
    if (level !== null && !isLevel(level)) return res.status(400).json({ error: 'level must be all, mentions, none or null' });

    /** @type {{ scope: string, target: string, serverId: string | null } | null} */
    let where = null;
    if (body.scope === 'server') {
      if (!isId(body.serverId)) return res.status(400).json({ error: 'serverId is required' });
      if (level !== null && !(await roleOf(body.serverId, me.username))) return res.status(403).json({ error: 'Not a member' });
      where = { scope: 'server', target: body.serverId, serverId: body.serverId };
    } else if (body.scope === 'channel') {
      if (!isId(body.serverId) || !isId(body.channelId)) return res.status(400).json({ error: 'serverId and channelId are required' });
      if (level !== null) {
        const ch = await db.get("SELECT type, COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", body.channelId, body.serverId);
        const role = ch ? await roleOf(body.serverId, me.username) : null;
        // Only text channels carry messages to be notified about.
        if (!ch || ch.type !== 'text' || !(await canAccessChannel(body.serverId, body.channelId, me.username, ch.privacy, role))) {
          return res.status(404).json({ error: 'Channel not found' });
        }
      }
      where = { scope: 'channel', target: body.channelId, serverId: body.serverId };
    } else if (body.scope === 'dm') {
      const peerId = typeof body.userId === 'string' && /^\d{1,15}$/.test(body.userId) ? Number(body.userId) : body.userId;
      if (!Number.isSafeInteger(peerId) || peerId <= 0) return res.status(400).json({ error: 'userId is required' });
      if (peerId === me.id) return res.status(400).json({ error: "You can't mute yourself" });
      if (level !== null) {
        if (level !== 'none') return res.status(400).json({ error: 'A conversation is muted (none) or not (null)' });
        if (!(await db.get('SELECT 1 AS one FROM users WHERE id = ?', peerId))) return res.status(404).json({ error: 'User not found' });
      }
      where = { scope: 'dm', target: String(peerId), serverId: null };
    } else if (body.scope === 'group') {
      if (!isId(body.groupId)) return res.status(400).json({ error: 'groupId is required' });
      if (level !== null) {
        if (level !== 'none') return res.status(400).json({ error: 'A conversation is muted (none) or not (null)' });
        if (!(await db.get('SELECT 1 AS one FROM group_members WHERE group_id = ? AND user_id = ?', body.groupId, me.id))) return res.status(404).json({ error: 'Group not found' });
      }
      where = { scope: 'group', target: body.groupId, serverId: null };
    } else {
      return res.status(400).json({ error: 'scope must be server, channel, dm or group' });
    }

    // A server at the default needs no row: "only @mentions" is what having none means. A channel
    // keeps one, because there it says "not what my server is set to".
    if (level === null || (where.scope === 'server' && level === DEFAULT_LEVEL)) {
      await notificationSettings.clear(me.id, where.scope, where.target);
    } else if (!(await notificationSettings.set(me.id, where.scope, where.target, level, where.serverId))) {
      return res.status(400).json({ error: 'Too many notification settings. Clear some first.' });
    }

    const settings = await notificationSettings.settingsOf(me.id);
    io.to(`user:${me.username}`).emit('notifications:updated', { settings });
    // The Messages badge leaves a muted conversation out (getDmUnreadSummary), so its total just
    // changed for every window this person has open.
    if (where.scope === 'dm') await emitDmUnreadUpdate(me.username);
    return res.json({ success: true, settings });
  });
}

module.exports = { registerNotificationRoutes };
