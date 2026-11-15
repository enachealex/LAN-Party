// @ts-check
// Notification levels: how loudly each place may reach one person.
//
//   server, channel   'all'       every message may alert (a push when the app is closed or
//                                 unfocused, an in-page notification and a sound otherwise)
//                     'mentions'  only a message that @mentions them. The default, and what
//                                 everyone had before levels existed.
//                     'none'      muted: no push, no in-page alert, no sound, not even for a
//                                 mention. Unread counts are still kept; they just stop adding to
//                                 the server tile's badge.
//                     A channel's own setting wins over its server's; a channel with none follows
//                     its server.
//   dm, group         muted or not. Muted never alerts and stays out of the Messages badge.
//
// A level only ever makes a place quieter or louder FOR THE PERSON WHO SET IT. It grants nothing:
// who may be pushed about a channel message is still decided by who can open the channel, by
// blocking and by the push rate limits (see pushChannelMessage in index.js), and a row left behind
// for a channel someone has since lost counts for nothing there.
//
// The server enforces the push half. The in-page half (sounds, the page's own notifications, which
// counts feed which badge) is the client's, working from the same settings: it gets them with the
// unread counts (GET /unreads) and is told when they change ('notifications:updated').
//
// Keyed by user id, so a rename carries nothing. The route layer is routes/notifications.js.

const LEVELS = /** @type {const} */ (['all', 'mentions', 'none']);
const SCOPES = /** @type {const} */ (['server', 'channel', 'dm', 'group']);
const DEFAULT_LEVEL = 'mentions';
// Far more than anyone sets by hand (it is one row per server, channel or conversation they have
// touched). The ceiling is there so a looping client cannot grow the table without limit.
const MAX_SETTINGS_PER_USER = 2000;

/**
 * @typedef {import('../db/migrate').Db} Db
 * @typedef {'all' | 'mentions' | 'none'} Level
 * @typedef {'server' | 'channel' | 'dm' | 'group'} Scope
 * @typedef {{
 *   servers: Record<string, Level>,
 *   channels: Record<string, Record<string, Level>>,
 *   dms: Record<string, true>,
 *   groups: Record<string, true>,
 * }} Settings what one person has set, as the client receives it: only what differs from the default
 */

/** @param {unknown} value @returns {value is Level} */
const isLevel = (value) => typeof value === 'string' && /** @type {readonly string[]} */ (LEVELS).includes(value);

/**
 * The level that applies to a channel for someone, from their settings.
 * @param {Settings} settings @param {string} serverId @param {string} channelId
 * @returns {Level}
 */
function effectiveChannelLevel(settings, serverId, channelId) {
  return settings.channels[serverId]?.[channelId] || settings.servers[serverId] || DEFAULT_LEVEL;
}

/** @param {{ db: Db }} deps */
function createNotificationSettings({ db }) {
  /**
   * Everything one person has set.
   * @param {number} userId
   * @returns {Promise<Settings>}
   */
  async function settingsOf(userId) {
    /** @type {Settings} */
    const out = { servers: {}, channels: {}, dms: {}, groups: {} };
    const rows = await db.all('SELECT scope, target, server_id, level FROM notification_settings WHERE user_id = ?', userId);
    for (const row of rows) {
      if (!isLevel(row.level)) continue;
      if (row.scope === 'server') out.servers[row.target] = row.level;
      else if (row.scope === 'channel' && row.server_id) (out.channels[row.server_id] ||= {})[row.target] = row.level;
      // A DM or a group is only ever muted or not; any other level stored there counts as not.
      else if (row.scope === 'dm' && row.level === 'none') out.dms[row.target] = true;
      else if (row.scope === 'group' && row.level === 'none') out.groups[row.target] = true;
    }
    return out;
  }

  /**
   * The same, for a username (what a route knows its caller by). Empty for an unknown name.
   * @param {string | null | undefined} username
   * @returns {Promise<Settings>}
   */
  async function settingsOfUsername(username) {
    const user = username ? await db.get('SELECT id FROM users WHERE username = ?', username) : null;
    return user ? settingsOf(user.id) : { servers: {}, channels: {}, dms: {}, groups: {} };
  }

  /**
   * Store one setting. Returns false when the person already has as many as anyone may.
   * @param {number} userId @param {Scope} scope @param {string} target @param {Level} level
   * @param {string | null} [serverId] the channel's server, for a channel
   * @returns {Promise<boolean>}
   */
  async function set(userId, scope, target, level, serverId = null) {
    const existing = await db.get('SELECT 1 AS one FROM notification_settings WHERE user_id = ? AND scope = ? AND target = ?', userId, scope, target);
    if (!existing) {
      const count = await db.get('SELECT COUNT(*) AS n FROM notification_settings WHERE user_id = ?', userId);
      if ((count?.n || 0) >= MAX_SETTINGS_PER_USER) return false;
    }
    await db.run(
      `INSERT INTO notification_settings (user_id, scope, target, server_id, level, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, scope, target) DO UPDATE SET level = excluded.level, server_id = excluded.server_id, updated_at = excluded.updated_at`,
      userId, scope, target, serverId, level, Date.now()
    );
    return true;
  }

  /**
   * Go back to the default for one thing.
   * @param {number} userId @param {Scope} scope @param {string} target
   */
  async function clear(userId, scope, target) {
    await db.run('DELETE FROM notification_settings WHERE user_id = ? AND scope = ? AND target = ?', userId, scope, target);
  }

  /**
   * The level of one channel for everyone who has set one that bears on it (on the channel itself,
   * or on its server). Anyone not in the map is at the default. Read once per channel message.
   * @param {string} serverId @param {string} channelId
   * @returns {Promise<Map<string, Level>>} username -> level
   */
  async function channelLevels(serverId, channelId) {
    const rows = await db.all(
      `SELECT u.username, ns.scope, ns.level FROM notification_settings ns
         JOIN users u ON u.id = ns.user_id
        WHERE (ns.scope = 'channel' AND ns.target = ? AND ns.server_id = ?) OR (ns.scope = 'server' AND ns.target = ?)`,
      channelId, serverId, serverId
    );
    /** @type {Map<string, Level>} */
    const levels = new Map();
    // The server's level first, then the channel's own over it.
    for (const row of rows) if (row.scope === 'server' && isLevel(row.level)) levels.set(row.username, row.level);
    for (const row of rows) if (row.scope === 'channel' && isLevel(row.level)) levels.set(row.username, row.level);
    return levels;
  }

  /**
   * Has `recipientId` muted their conversation with `senderId`?
   * @param {number} recipientId @param {number} senderId
   */
  async function dmMuted(recipientId, senderId) {
    return !!(await db.get(
      "SELECT 1 AS one FROM notification_settings WHERE user_id = ? AND scope = 'dm' AND target = ? AND level = 'none'",
      recipientId, String(senderId)
    ));
  }

  /**
   * The user ids of the people whose conversations this person has muted.
   * @param {number} userId
   * @returns {Promise<Set<number>>}
   */
  async function mutedDmPeers(userId) {
    const rows = await db.all("SELECT target FROM notification_settings WHERE user_id = ? AND scope = 'dm' AND level = 'none'", userId);
    return new Set(rows.map((r) => Number(r.target)).filter((id) => Number.isSafeInteger(id)));
  }

  /**
   * The usernames of everyone who has muted this group chat.
   * @param {string} groupId
   * @returns {Promise<Set<string>>}
   */
  async function groupMuters(groupId) {
    const rows = await db.all(
      `SELECT u.username FROM notification_settings ns JOIN users u ON u.id = ns.user_id
        WHERE ns.scope = 'group' AND ns.target = ? AND ns.level = 'none'`,
      groupId
    );
    return new Set(rows.map((r) => r.username));
  }

  // --- Clean-up: a setting does not outlive what it was about ---

  /** A server was deleted: every setting for it and for its channels. @param {string} serverId */
  async function forgetServer(serverId) {
    await db.run("DELETE FROM notification_settings WHERE (scope = 'server' AND target = ?) OR (scope = 'channel' AND server_id = ?)", serverId, serverId);
  }

  /** A channel was deleted. @param {string} channelId */
  async function forgetChannel(channelId) {
    await db.run("DELETE FROM notification_settings WHERE scope = 'channel' AND target = ?", channelId);
  }

  /**
   * Someone is no longer a member of a server (kicked, banned, left): what they had set there goes
   * with the membership, so that coming back starts from the defaults.
   * @param {string} serverId @param {string} username
   */
  async function forgetMember(serverId, username) {
    await db.run(
      `DELETE FROM notification_settings
        WHERE user_id = (SELECT id FROM users WHERE username = ?)
          AND ((scope = 'server' AND target = ?) OR (scope = 'channel' AND server_id = ?))`,
      username, serverId, serverId
    );
  }

  /** A group chat is gone. @param {string} groupId */
  async function forgetGroup(groupId) {
    await db.run("DELETE FROM notification_settings WHERE scope = 'group' AND target = ?", groupId);
  }

  /** Someone left a group chat, or was removed from it. @param {string} groupId @param {number} userId */
  async function forgetGroupMember(groupId, userId) {
    await db.run("DELETE FROM notification_settings WHERE scope = 'group' AND target = ? AND user_id = ?", groupId, userId);
  }

  return {
    settingsOf, settingsOfUsername, set, clear, channelLevels, dmMuted, mutedDmPeers, groupMuters,
    forgetServer, forgetChannel, forgetMember, forgetGroup, forgetGroupMember,
  };
}

module.exports = { createNotificationSettings, effectiveChannelLevel, isLevel, LEVELS, SCOPES, DEFAULT_LEVEL, MAX_SETTINGS_PER_USER };
