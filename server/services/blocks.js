// @ts-check
// Blocking: one account shutting another out, across the whole instance.
//
// A block is one row, blocker -> blocked. It is not mutual and not shared with anyone: the blocked
// person is never told, and nothing they can ask the server may answer differently because of it
// than it would for someone they simply cannot reach. That rule shapes where each effect is applied:
//
//   - Contact is refused in BOTH directions while a block stands (between()): a direct message, a
//     1:1 call, a friend request, adding to a group chat. The refusal is the one a stranger gets.
//   - Everything else is one-way and silent: the blocker stops being NOTIFIED by the blocked person
//     (blockersOf() names who to leave out of a push, a badge, a typing hint) and messages from them
//     arrive MARKED rather than missing (blockedBy() names whose messages to mark for a reader),
//     because a channel with holes in it makes everyone else's replies unreadable.
//
// Keyed by user id, so nothing here needs to follow a rename. The route layer is routes/blocks.js.

/**
 * @typedef {import('../db/migrate').Db} Db
 * @param {{ db: Db }} deps
 */
function createBlocks({ db }) {
  /**
   * Has `blockerId` blocked `blockedId`? One direction only.
   * @param {number} blockerId @param {number} blockedId
   */
  async function hasBlocked(blockerId, blockedId) {
    return !!(await db.get('SELECT 1 AS one FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', blockerId, blockedId));
  }

  /**
   * Is there a block between these two, either way round? What decides whether they may contact
   * each other at all.
   * @param {number} idA @param {number} idB
   */
  async function between(idA, idB) {
    return !!(await db.get(
      'SELECT 1 AS one FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?) LIMIT 1',
      idA, idB, idB, idA
    ));
  }

  /**
   * The usernames this person has blocked: whose messages are marked for them, and left out of
   * what they are counted, searched and notified about. Empty for an unknown name or no name.
   * @param {string | null | undefined} username
   * @returns {Promise<Set<string>>}
   */
  async function blockedBy(username) {
    if (!username) return new Set();
    const rows = await db.all(
      `SELECT u.username FROM user_blocks b
         JOIN users me ON me.id = b.blocker_id
         JOIN users u ON u.id = b.blocked_id
        WHERE me.username = ?`,
      username
    );
    return new Set(rows.map((r) => r.username));
  }

  /**
   * The usernames who have blocked this person: who must not be notified by anything they do.
   * @param {string | null | undefined} username
   * @returns {Promise<Set<string>>}
   */
  async function blockersOf(username) {
    if (!username) return new Set();
    const rows = await db.all(
      `SELECT u.username FROM user_blocks b
         JOIN users them ON them.id = b.blocked_id
         JOIN users u ON u.id = b.blocker_id
        WHERE them.username = ?`,
      username
    );
    return new Set(rows.map((r) => r.username));
  }

  /**
   * The caller's block list, newest first. `userId` is what the client keys a conversation by, so
   * it can still open the one it has with someone on this list (the same id GET /friends gives).
   * @param {number} blockerId
   * @returns {Promise<{ username: string, userId: string, blockedAt: number }[]>}
   */
  async function list(blockerId) {
    const rows = await db.all(
      `SELECT u.username, u.id, b.created_at AS blockedAt FROM user_blocks b
         JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.created_at DESC, u.username ASC`,
      blockerId
    );
    return rows.map((r) => ({ username: r.username, userId: String(r.id), blockedAt: r.blockedAt }));
  }

  /**
   * Block someone, and undo what ties the two together: the friendship both ways, and every friend
   * request between them, whichever way and in whatever state (a row left behind would stop a new
   * request later, since there is one row per direction). Unread direct messages from the blocked
   * person are marked read, so the blocker is not left with a badge for a conversation that has
   * just been closed. One transaction: a block that left the friendship standing would not be one.
   * @param {number} blockerId @param {number} blockedId
   * @param {number} [now]
   * @returns {Promise<{ created: boolean, wereFriends: boolean }>} `created` is false when the block already stood
   */
  async function block(blockerId, blockedId, now = Date.now()) {
    await db.run('BEGIN');
    try {
      const added = await db.run('INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)', blockerId, blockedId, now);
      const unfriended = await db.run(
        'DELETE FROM friendships WHERE (user_id = ? AND friend_user_id = ?) OR (user_id = ? AND friend_user_id = ?)',
        blockerId, blockedId, blockedId, blockerId
      );
      await db.run(
        'DELETE FROM friend_requests WHERE (from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?)',
        blockerId, blockedId, blockedId, blockerId
      );
      await db.run('UPDATE direct_messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL', now, blockerId, blockedId);
      await db.run('COMMIT');
      return { created: added.changes > 0, wereFriends: unfriended.changes > 0 };
    } catch (e) {
      await db.run('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  /**
   * Lift a block. A friend request the blocked person sent meanwhile was withheld (routes/social.js)
   * and is dropped here rather than delivered late: to its sender that looks like any request that
   * was turned down, and the person who just unblocked is not met with a request they never saw
   * arrive. Nothing else is restored; the friendship stays gone until one of them asks again.
   * @param {number} blockerId @param {number} blockedId
   * @returns {Promise<boolean>} whether there was a block to lift
   */
  async function unblock(blockerId, blockedId) {
    const removed = await db.run('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', blockerId, blockedId);
    await db.run("DELETE FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = 'withheld'", blockedId, blockerId);
    return removed.changes > 0;
  }

  return { hasBlocked, between, blockedBy, blockersOf, list, block, unblock };
}

module.exports = { createBlocks };
