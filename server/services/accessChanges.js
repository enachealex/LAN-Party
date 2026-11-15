// @ts-check
// What has to happen when a change takes something away from a member who stays a member.
//
// Being a member is not all-or-nothing any more: a role can be what opens a private channel to
// someone, or what lets them mint invite links, and roles are removed, deleted, edited and taken
// off channels. Each of those can take a channel (or the invite power) away from people the route
// never names. So a route that might do that takes a snapshot of the people it could affect,
// makes its change, and calls settle(), which compares before with after and does for everyone
// who really lost something exactly what removal from a private channel's list has always done:
//
//   - the server's app room keys are replaced (services/appRooms.js), once, because the person
//     still holds the keys of the channel they can no longer open;
//   - their sockets are taken out of the voice rooms and text rooms they may no longer be in;
//   - the invite links they minted are revoked if they can no longer invite, as on a demotion.
//
// Only on a loss. A change that gives access, or changes nothing, rotates nothing: a rotation ends
// every app running in the server, which is not something to do for no reason.

/**
 * @typedef {Map<string, { channels: Set<string>, invite: boolean }>} Snapshot
 * @param {{
 *   db: import('../db/migrate').Db,
 *   permissions: ReturnType<typeof import('./permissions').createPermissions>,
 *   appRooms: { rotate: (serverId: string) => Promise<number | null> },
 *   enforceVoiceAccess: (username: string, serverId: string) => Promise<void>,
 *   enforceTextAccess: (username: string, serverId: string) => Promise<void>,
 * }} deps
 */
function createAccessChanges({ db, permissions, appRooms, enforceVoiceAccess, enforceTextAccess }) {
  /**
   * Minting invite links is a power, and a link keeps admitting people for as long as it is live.
   * So the links someone minted are revoked the moment they can no longer invite in that server
   * (kicked, demoted, a role gone, or gone of their own accord): otherwise the power outlives the
   * permission, and a removed admin could let themselves, or anyone else, back in with a link made
   * beforehand. Revoked rather than deleted, like a manual revoke, so the record of who minted
   * what survives.
   * @param {string} serverId @param {string} username
   */
  async function revokeInvitesBy(serverId, username) {
    await db.run(
      'UPDATE server_invites SET revoked_at = ? WHERE server_id = ? AND created_by = ? AND revoked_at IS NULL',
      Date.now(), serverId, username
    );
  }

  /**
   * What each of these people can reach right now: the private channels they can open, and
   * whether they may invite.
   * @param {string} serverId @param {Iterable<string>} usernames
   * @returns {Promise<Snapshot>}
   */
  async function snapshot(serverId, usernames) {
    /** @type {Snapshot} */
    const out = new Map();
    for (const username of new Set(usernames)) {
      out.set(username, {
        channels: await permissions.privateChannelsOf(serverId, username),
        invite: await permissions.can(serverId, username, 'invite'),
      });
    }
    return out;
  }

  /**
   * Compare a snapshot with the present and deal with every loss. Call it AFTER the rows that gave
   * the access are gone (see appRooms.rotate for why the order matters).
   * @param {string} serverId @param {Snapshot} before
   * @returns {Promise<{ lostChannels: string[], rotated: boolean }>} who lost a channel, and whether the room keys were replaced
   */
  async function settle(serverId, before) {
    const lostChannels = [];
    for (const [username, was] of before) {
      const now = await permissions.privateChannelsOf(serverId, username);
      if ([...was.channels].some((id) => !now.has(id))) lostChannels.push(username);
      if (was.invite && !(await permissions.can(serverId, username, 'invite'))) await revokeInvitesBy(serverId, username);
    }
    if (lostChannels.length > 0) await appRooms.rotate(serverId);
    for (const username of lostChannels) {
      await enforceVoiceAccess(username, serverId);
      await enforceTextAccess(username, serverId);
    }
    return { lostChannels, rotated: lostChannels.length > 0 };
  }

  return { snapshot, settle, revokeInvitesBy };
}

module.exports = { createAccessChanges };
