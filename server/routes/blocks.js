// Blocking another account: the caller's own list, block, unblock. What a block DOES is
// services/blocks.js and the places that consult it (index.js canDirectMessage, the 'message' and
// 'typing' handlers, routes/social.js, routes/groups.js, routes/search.js); this file only keeps
// the list.
//
// Nothing here is ever sent to the person who was blocked. The only events they can receive are
// the ones an ordinary unfriend or a cancelled friend request already sends (their friends list or
// pending count changed), and only when that is what actually happened to them.
const { rateLimit } = require('../rateLimit');

// Counted per account: the routes know who is asking. Blocking is something a person does a few
// times, not in a loop; the ceiling is there so one account cannot use the friendship and request
// clean-up a block performs as a way to hammer the database.
const keyOf = (/** @type {any} */ req) => req.user && req.user.username;
const BLOCK_WRITE_LIMIT = { id: 'blocks-write', windowMs: 5 * 60_000, max: 60, message: 'Too many block changes just now. Wait a few minutes.', keyOf };
const BLOCK_READ_LIMIT = { id: 'blocks-read', windowMs: 60_000, max: 120, keyOf };

/** @param {Record<string, any>} deps */
function registerBlockRoutes({ app, db, io, authMiddleware, getUserByUsername, blocks, emitFriendsListUpdate, emitPendingUpdate, emitDmUnreadUpdate }) {
  // Express 4 does not catch a rejected async handler, and an unhandled rejection ends the process.
  const safely = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (e) {
      console.error('[blocks] error:', e);
      if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
      return undefined;
    }
  };

  // Load the caller and the person named in the URL, or answer the request and return null.
  async function pair(req, res) {
    const me = await getUserByUsername(req.user.username);
    if (!me) { res.status(404).json({ error: 'User not found' }); return null; }
    const other = await getUserByUsername(String(req.params.username || '').trim());
    if (!other) { res.status(404).json({ error: 'User not found' }); return null; }
    return { me, other };
  }

  // The caller's other windows and devices keep their own copy of the list.
  const tellOwnDevices = (username) => io.to(`user:${username}`).emit('blocks:updated', {});

  app.get('/blocks', authMiddleware, rateLimit(BLOCK_READ_LIMIT), safely(async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    return res.json({ blocks: await blocks.list(me.id) });
  }));

  // Block. Idempotent: blocking someone already blocked answers the same success and changes nothing.
  app.post('/blocks/:username', authMiddleware, rateLimit(BLOCK_WRITE_LIMIT), safely(async (req, res) => {
    const who = await pair(req, res);
    if (!who) return undefined;
    const { me, other } = who;
    if (other.id === me.id) return res.status(400).json({ error: "You can't block yourself" });
    // A request the blocker had sent is about to disappear from the other person's incoming list.
    // Read before the block deletes it, because that is the one case where they are told to
    // refresh their count, exactly as when a request is cancelled.
    const hadRequestOut = !!(await db.get(
      "SELECT 1 AS one FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'",
      me.id, other.id
    ));
    const { wereFriends } = await blocks.block(me.id, other.id);
    await emitFriendsListUpdate(me.username);
    await emitPendingUpdate(me.username);
    await emitDmUnreadUpdate(me.username);
    tellOwnDevices(me.username);
    // To the other person: only what an unfriend or a cancelled request would have sent them.
    if (wereFriends) await emitFriendsListUpdate(other.username);
    if (hadRequestOut) await emitPendingUpdate(other.username);
    return res.json({ success: true, blocked: true, username: other.username });
  }));

  // Unblock. Also idempotent. Nothing comes back with it: not the friendship, not a withheld request.
  app.delete('/blocks/:username', authMiddleware, rateLimit(BLOCK_WRITE_LIMIT), safely(async (req, res) => {
    const who = await pair(req, res);
    if (!who) return undefined;
    const { me, other } = who;
    await blocks.unblock(me.id, other.id);
    tellOwnDevices(me.username);
    return res.json({ success: true, blocked: false, username: other.username });
  }));
}

module.exports = { registerBlockRoutes, BLOCK_WRITE_MAX: BLOCK_WRITE_LIMIT.max };
