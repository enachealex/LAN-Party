// Social graph + direct messaging: presence, friend check/list, friend requests (send / accept /
// decline / cancel / incoming / outgoing), and 1:1 DMs (conversations, thread,
// read, send, delete). Leans on shared helpers (friend-graph, DM-unread, presence broadcasts) that
// also serve the socket layer, so they are injected rather than moved.
/** @param {Record<string, any>} deps */
function registerSocialRoutes({ app, db, io, authMiddleware, getUserByUsername, areFriends, canDirectMessage, hasPendingRequestBetween, emitPendingUpdate, emitFriendsListUpdate, getDmUnreadSummary, emitDmUnreadUpdate, setUserPresenceByUsername, broadcastPresenceToFriends, normalizePresence, displayProfileFromSettings, avatarColorForUsername, mapMessageRow, normalizeAttachment, sanitizeQuotes }) {
  app.post('/user/presence', authMiddleware, async (req, res) => {
    const status = normalizePresence(req.body?.status);
    const username = req.user.username;
    const user = await getUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await setUserPresenceByUsername(username, status);
    await broadcastPresenceToFriends(username, status);
    return res.json({ success: true, status });
  });

  app.get('/friends/check-user', authMiddleware, async (req, res) => {
    const target = (req.query.username || '').trim();
    if (!target) return res.status(400).json({ error: 'Missing username' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    if (target.toLowerCase() === me.username.toLowerCase()) {
      return res.json({ exists: false, self: true });
    }
    const user = await getUserByUsername(target);
    return res.json({ exists: !!user, self: false });
  });

  app.get('/friends', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const rows = await db.all(
      `SELECT u.id, u.username, u.settings, COALESCE(u.presence_status, 'offline') AS presence_status
       FROM friendships f
       JOIN users u ON u.id = f.friend_user_id
       WHERE f.user_id = ?
       ORDER BY u.username ASC`,
      me.id
    );
    const friends = rows.map((r) => ({
      id: String(r.id),
      name: r.username,
      status: normalizePresence(r.presence_status),
      avatar: avatarColorForUsername(r.username),
      profile: displayProfileFromSettings(r.settings),
    }));
    return res.json({ friends });
  });

  app.get('/friends/requests/incoming', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const rows = await db.all(
      `SELECT fr.id, u.username AS fromUsername, fr.created_at AS createdAt
       FROM friend_requests fr
       JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      me.id
    );
    return res.json({
      requests: rows.map((r) => ({
        id: r.id,
        fromUsername: r.fromUsername,
        createdAt: r.createdAt,
        avatar: avatarColorForUsername(r.fromUsername),
      })),
    });
  });

  app.get('/friends/requests/outgoing', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const rows = await db.all(
      `SELECT fr.id, u.username AS toUsername, fr.created_at AS createdAt
       FROM friend_requests fr
       JOIN users u ON u.id = fr.to_user_id
       WHERE fr.from_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      me.id
    );
    return res.json({
      requests: rows.map((r) => ({
        id: r.id,
        toUsername: r.toUsername,
        createdAt: r.createdAt,
        avatar: avatarColorForUsername(r.toUsername),
      })),
    });
  });

  app.post('/friends/requests/:id/cancel', authMiddleware, async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const fr = await db.get('SELECT * FROM friend_requests WHERE id = ?', requestId);
    if (!fr || fr.from_user_id !== me.id) return res.status(404).json({ error: 'Request not found' });
    if (fr.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    await db.run('UPDATE friend_requests SET status = ? WHERE id = ?', 'cancelled', requestId);
    const target = await db.get('SELECT username FROM users WHERE id = ?', fr.to_user_id);
    if (target) await emitPendingUpdate(target.username);
    return res.json({ success: true });
  });

  app.post('/friends/request', authMiddleware, async (req, res) => {
    const targetUsername = (req.body?.username || '').trim();
    if (!targetUsername) return res.status(400).json({ error: 'Missing username' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const target = await getUserByUsername(targetUsername);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === me.id) return res.status(400).json({ error: 'You cannot add yourself' });
    if (await areFriends(me.id, target.id)) {
      return res.status(409).json({ error: 'Already friends' });
    }
    if (await hasPendingRequestBetween(me.id, target.id)) {
      return res.status(409).json({ error: 'Friend request already pending' });
    }
    const createdAt = Date.now();
    await db.run(
      'INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, ?)',
      me.id,
      target.id,
      'pending',
      createdAt
    );
    await emitPendingUpdate(target.username);
    return res.json({ success: true });
  });

  app.post('/friends/requests/:id/accept', authMiddleware, async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const fr = await db.get(
      `SELECT fr.*, u_from.username AS fromUsername, u_to.username AS toUsername
       FROM friend_requests fr
       JOIN users u_from ON u_from.id = fr.from_user_id
       JOIN users u_to ON u_to.id = fr.to_user_id
       WHERE fr.id = ?`,
      requestId
    );
    if (!fr || fr.to_user_id !== me.id) return res.status(404).json({ error: 'Request not found' });
    if (fr.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    const now = Date.now();
    await db.run('UPDATE friend_requests SET status = ? WHERE id = ?', 'accepted', requestId);
    await db.run(
      'INSERT OR IGNORE INTO friendships (user_id, friend_user_id, created_at) VALUES (?, ?, ?)',
      me.id,
      fr.from_user_id,
      now
    );
    await db.run(
      'INSERT OR IGNORE INTO friendships (user_id, friend_user_id, created_at) VALUES (?, ?, ?)',
      fr.from_user_id,
      me.id,
      now
    );
    await emitPendingUpdate(me.username);
    await emitFriendsListUpdate(me.username);
    await emitFriendsListUpdate(fr.fromUsername);
    // Tell the ORIGINAL SENDER specifically that their request was accepted. friend:list-updated
    // can't serve this: it goes to BOTH parties (so the accepter would also get a "you have a new
    // friend" celebration on top of their own click) and it carries no payload, so there'd be no
    // name for the toast. Keeping it separate also keeps it correct now that removing a friend
    // (DELETE /friends/:username) emits friend:list-updated too.
    io.to(`user:${fr.fromUsername}`).emit('friend:request-accepted', { by: me.username });
    return res.json({ success: true });
  });

  app.post('/friends/requests/:id/decline', authMiddleware, async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const fr = await db.get('SELECT * FROM friend_requests WHERE id = ?', requestId);
    if (!fr || fr.to_user_id !== me.id) return res.status(404).json({ error: 'Request not found' });
    if (fr.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    await db.run('UPDATE friend_requests SET status = ? WHERE id = ?', 'declined', requestId);
    await emitPendingUpdate(me.username);
    return res.json({ success: true });
  });

  // Remove a friend. The friendship goes both ways, and so do the old requests between you: an
  // accepted request stays in friend_requests, which is UNIQUE per direction, so leaving it would
  // make a fresh request from the same person fail later. Message history is kept — become friends
  // again and it's all still there.
  app.delete('/friends/:username', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const other = await getUserByUsername(String(req.params.username || '').trim());
    if (!other) return res.status(404).json({ error: 'User not found' });
    if (!(await areFriends(me.id, other.id))) return res.status(404).json({ error: 'You are not friends' });
    await db.run(
      'DELETE FROM friendships WHERE (user_id = ? AND friend_user_id = ?) OR (user_id = ? AND friend_user_id = ?)',
      me.id, other.id, other.id, me.id
    );
    await db.run(
      'DELETE FROM friend_requests WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)',
      me.id, other.id, other.id, me.id
    );
    await emitFriendsListUpdate(me.username);
    await emitFriendsListUpdate(other.username);
    return res.json({ success: true });
  });

  app.get('/messages/conversations', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const friends = await db.all(
      `SELECT u.id, u.username, u.settings, COALESCE(u.presence_status, 'offline') AS presence_status
       FROM friendships f
       JOIN users u ON u.id = f.friend_user_id
       WHERE f.user_id = ?
       ORDER BY u.username ASC`,
      me.id
    );
    const summary = await getDmUnreadSummary(me.id);
    const unreadMap = new Map(summary.byPeer.map((r) => [String(r.peerId), r.unreadCount]));
    const conversations = [];
    for (const f of friends) {
      const last = await db.get(
        `SELECT dm.body, dm.attachment_json AS attachmentJson, dm.created_at AS createdAt, s.username AS senderUsername
         FROM direct_messages dm
         JOIN users s ON s.id = dm.sender_id
         WHERE (dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?)
         ORDER BY dm.created_at DESC LIMIT 1`,
        me.id,
        f.id,
        f.id,
        me.id
      );
      conversations.push({
        id: String(f.id),
        name: f.username,
        peerUsername: f.username,
        unreadCount: unreadMap.get(String(f.id)) || 0,
        avatar: avatarColorForUsername(f.username),
        profile: displayProfileFromSettings(f.settings),
        status: normalizePresence(f.presence_status),
        lastMessage: last
          ? { text: last.body || (last.attachmentJson ? 'Sent an attachment' : ''), author: last.senderUsername, createdAt: last.createdAt }
          : null,
      });
    }
    return res.json({ conversations, totalUnread: summary.totalUnread });
  });

  app.get('/messages/with/:username', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const peer = await getUserByUsername(req.params.username);
    if (!peer) return res.status(404).json({ error: 'User not found' });
    // Friends, or people you share a server with — the member list offers a private message.
    if (!(await canDirectMessage(me.id, me.username, peer.id, peer.username))) {
      return res.status(403).json({ error: 'You can only message friends or people you share a server with' });
    }
    const markRead = req.query.markRead === '1' || req.query.markRead === 'true';
    if (markRead) {
      const now = Date.now();
      await db.run(
        'UPDATE direct_messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL',
        now,
        me.id,
        peer.id
      );
      await emitDmUnreadUpdate(me.username);
    }
    const rows = await db.all(
      `SELECT dm.id, dm.body AS text, dm.created_at AS ts, dm.attachment_json, dm.reactions_json, dm.quotes_json, dm.edited_at, s.username AS author
       FROM direct_messages dm
       JOIN users s ON s.id = dm.sender_id
       WHERE (dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?)
       ORDER BY dm.created_at ASC`,
      me.id,
      peer.id,
      peer.id,
      me.id
    );
    const summary = await getDmUnreadSummary(me.id);
    return res.json({
      messages: rows.map((r) => mapMessageRow(r, me.username)),
      totalUnread: summary.totalUnread,
    });
  });

  app.post('/messages/read', authMiddleware, async (req, res) => {
    const withUsername = (req.body?.withUsername || req.body?.username || '').trim();
    if (!withUsername) return res.status(400).json({ error: 'Missing username' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const peer = await getUserByUsername(withUsername);
    if (!peer) return res.status(404).json({ error: 'User not found' });
    const now = Date.now();
    await db.run(
      'UPDATE direct_messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL',
      now,
      me.id,
      peer.id
    );
    await emitDmUnreadUpdate(me.username);
    const summary = await getDmUnreadSummary(me.id);
    return res.json({ success: true, totalUnread: summary.totalUnread });
  });

  app.post('/messages/send', authMiddleware, async (req, res) => {
    const toUsername = (req.body?.toUsername || req.body?.username || '').trim();
    const body = (req.body?.text || req.body?.body || '').trim();
    const attachment = normalizeAttachment(req.body?.attachment);
    if (!toUsername || (!body && !attachment)) return res.status(400).json({ error: 'Missing username or message' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const peer = await getUserByUsername(toUsername);
    if (!peer) return res.status(404).json({ error: 'User not found' });
    // Friends, or people you share a server with — the member list offers a private message.
    if (!(await canDirectMessage(me.id, me.username, peer.id, peer.username))) {
      return res.status(403).json({ error: 'You can only message friends or people you share a server with' });
    }
    const createdAt = Date.now();
    const cleanQuotes = sanitizeQuotes(req.body?.quotes);
    const insertResult = await db.run(
      'INSERT INTO direct_messages (sender_id, recipient_id, body, created_at, read_at, attachment_json, quotes_json) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      me.id,
      peer.id,
      body,
      createdAt,
      attachment ? JSON.stringify(attachment) : null,
      cleanQuotes ? JSON.stringify(cleanQuotes) : null
    );
    const row = await db.get(
      `SELECT dm.id, dm.body AS text, dm.created_at AS ts, dm.attachment_json, dm.reactions_json, dm.quotes_json, dm.edited_at, s.username AS author
       FROM direct_messages dm
       JOIN users s ON s.id = dm.sender_id
       WHERE dm.id = ?`,
      insertResult.lastID
    );
    const msg = mapMessageRow(row);
    io.to(`user:${peer.username}`).emit('dm:message', {
      fromUsername: me.username,
      fromUserId: String(me.id),
      message: msg,
    });
    await emitDmUnreadUpdate(peer.username);
    await emitDmUnreadUpdate(me.username);
    return res.json({ success: true, message: msg });
  });

  // Edit a direct message — the sender only, and only a text message. Both participants are told, so
  // the conversation updates live on either side (and in the sender's other open windows).
  app.patch('/messages/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid message id' });
    const body = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!body) return res.status(400).json({ error: 'A message needs some text' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const dm = await db.get('SELECT sender_id, recipient_id, attachment_json FROM direct_messages WHERE id = ?', id);
    if (!dm) return res.status(404).json({ error: 'Message not found' });
    if (dm.sender_id !== me.id) return res.status(403).json({ error: 'You can only edit your own messages' });
    if (dm.attachment_json) return res.status(400).json({ error: "Messages with an attachment can't be edited" });
    const editedAt = Date.now();
    await db.run('UPDATE direct_messages SET body = ?, edited_at = ? WHERE id = ?', body, editedAt, id);
    const recipient = await db.get('SELECT username FROM users WHERE id = ?', dm.recipient_id);
    const payload = { id, text: body, editedAt };
    io.to(`user:${me.username}`).emit('dm:message-edited', payload);
    if (recipient) io.to(`user:${recipient.username}`).emit('dm:message-edited', payload);
    return res.json({ success: true, ...payload });
  });

  // Delete a direct message — only the sender may delete it. Notify both participants.
  app.delete('/messages/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid message id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const dm = await db.get('SELECT sender_id, recipient_id FROM direct_messages WHERE id = ?', id);
    if (!dm) return res.status(404).json({ error: 'Message not found' });
    if (dm.sender_id !== me.id) return res.status(403).json({ error: 'You can only delete your own messages' });
    await db.run('DELETE FROM direct_messages WHERE id = ?', id);
    const recipient = await db.get('SELECT username FROM users WHERE id = ?', dm.recipient_id);
    io.to(`user:${me.username}`).emit('dm:message-deleted', { id });
    if (recipient) io.to(`user:${recipient.username}`).emit('dm:message-deleted', { id });
    await emitDmUnreadUpdate(me.username);
    if (recipient) await emitDmUnreadUpdate(recipient.username);
    return res.json({ success: true });
  });
}

module.exports = { registerSocialRoutes };
