// @ts-check
// App room epochs: what makes a room key (services/hostedApps.js) revocable.
//
// An app with its own backend files a voice channel's data under the room key it is given, and
// everyone who joined the app there holds that key. Being removed from the server takes away the
// channel, not the key: without more, a kicked member could go on reaching that channel's room on
// the app's backend directly. So each server has a counter, the epoch, that is part of every room
// key made for it. Bumping it replaces all of that server's room keys at once; the old ones are
// never handed out again, and what the app stored under them is simply not what anyone is sent to
// any more.
//
// WHEN IT IS BUMPED. Whenever someone stops being entitled to rooms in the server, and by hand:
//   - a member is removed (kick)                       DELETE /servers/:id/members/:username
//   - a member leaves                                  POST /servers/:id/leave
//   - an admin is demoted and a private channel goes with the role
//                                                      PATCH /servers/:id/members/:username
//   - a member is taken off a private channel's list   DELETE /servers/:id/channels/:ch/members/:username
//   - an account is deleted: every server it was in    deleteUserCompletely (routes/auth.js)
//   - staff reset the rooms                            POST /servers/:id/app-rooms/reset
// A new way of losing access (a route that makes a public channel private, say) has to call
// rotate() too. A server that is deleted has no epoch left to bump; its running apps are ended
// instead, and its ids are never used again.
//
// The public commons never rotates: everyone is a member of it and nobody is ever removed, so there
// is nobody to revoke a key from, and a reset there would only be a way for any stranger to end
// everyone's apps.
//
// WHAT IT DOES NOT DO. It protects a channel's room from people who have LEFT. A current member can
// still hand their key to anyone, and nothing here stops an app's backend from honouring an old key
// it was given earlier; see docs/APP-INTEGRATION.md.

/**
 * @param {{
 *   db: import('../db/migrate').Db,
 *   commonsId: string,
 *   endAppActivitiesInServer: (serverId: string, reason: string) => unknown,
 * }} deps `endAppActivitiesInServer` ends every app running in that server's voice rooms
 */
function createAppRooms({ db, commonsId, endAppActivitiesInServer }) {
  // Counts rotations per server in this process, at their start and again at their end. A start of
  // an app reads the epoch from the database and only then creates the activity; a rotation that
  // ran in between would have ended the server's activities BEFORE that one existed, leaving it
  // running on the old key. So a start notes the number first and refuses if it has moved.
  /** @type {Map<string, number>} */
  const generations = new Map();
  const generation = (/** @type {string} */ serverId) => generations.get(serverId) || 0;
  const moved = (/** @type {string} */ serverId) => { generations.set(serverId, generation(serverId) + 1); };

  /**
   * The server's current epoch, or null for a server that does not exist (which gets no room keys).
   * @param {string} serverId
   * @returns {Promise<number | null>}
   */
  async function epochOf(serverId) {
    const row = await db.get('SELECT app_room_epoch AS epoch FROM servers WHERE id = ?', serverId);
    if (!row) return null;
    const epoch = Number(row.epoch);
    return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
  }

  /**
   * Replace every room key of this server: bump its epoch and end the apps running in its voice
   * rooms. Ending them is part of it, not a courtesy: the people already in an app hold the old
   * key, and anyone who joined that run afterwards would be given the old key too.
   *
   * Call it AFTER the rows that gave someone access are gone. A start checks access first and the
   * generation last, so in that order nobody who has just lost access can be handed the new key.
   * @param {string} serverId
   * @returns {Promise<number | null>} the new epoch; null for the commons or an unknown server
   */
  async function rotate(serverId) {
    if (serverId === commonsId) return null;
    moved(serverId);
    try {
      await db.run('UPDATE servers SET app_room_epoch = COALESCE(app_room_epoch, 0) + 1 WHERE id = ?', serverId);
    } finally {
      // Even if the write failed: a start that was waiting on the old number must not go ahead
      // as though nothing had been asked for.
      moved(serverId);
      endAppActivitiesInServer(serverId, 'rooms-reset');
    }
    return epochOf(serverId);
  }

  return { epochOf, rotate, generation };
}

module.exports = { createAppRooms };
