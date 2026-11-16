// @ts-check
// Server moderation: bans, timeouts and the audit log. The storage and the rules; the routes are
// routes/moderation.js, and the socket layer (index.js) asks timeoutOf() before it lets a member
// write, react, pin, drive an activity, join voice, or start, join or draw on a channel's shared
// image canvas (collab:*). Camera and screen state for Discover need the socket to be in the voice
// room it names, which a timeout already takes away.
//
// WHAT A TIMEOUT DOES NOT COVER, on purpose: things that belong to no server. An external stream
// announcement (stream:announce) names no server or channel; the shared GIF and sound libraries
// (routes/library.js) are instance-wide, uploads included; direct messages, group chats and calls
// are between people. A timeout means "no taking part in THIS server", and there is no server in
// any of those for it to apply to. Keeping someone out of them is what a block is for.
//
// KICK, BAN, TIMEOUT: three different things.
//   kick     Out of the server now. Remembered in server_removed so that no invite LINK lets them
//            back in; staff inviting them by username does, and clears it.
//   ban      A kick that holds: while the server_bans row exists neither a link nor an invite by
//            username admits them. Staff have to unban first. It can be placed on someone who is
//            not a member, to keep them from ever joining.
//   timeout  Still a member, still reading, but may not take part until a moment in time. Nothing
//            runs when it ends: every check is `until > now`, so it is over the instant it is over.
//
// WHO MAY DO IT: whoever holds the `ban` or `timeout` permission, to someone ranked strictly below
// them. So the owner to anyone but themselves, an admin to anyone who is not staff, a member whose
// custom role carries the permission to members ranked below that role. Never sideways (admin on
// admin), never upwards (admin on owner), never to yourself. The rule itself is
// services/permissions.js (decideAction); this file words its refusals (moderationRefusal).
//
// NEVER THE COMMONS. The public server has no staff and nobody can be removed from it, so every
// function here answers "nothing" for it, whatever the tables hold, and the routes refuse it by name.
//
// THE AUDIT LOG records who did what to whom, and when: never what anyone said. `target` is a
// username or null; everything else goes in `detail`. Kept to AUDIT_MAX_ROWS per server.

const { decideAction, builtinRank, isStaffRole } = require('./permissions');

const REASON_MAX = 300;
const TIMEOUT_MIN_MINUTES = 1;
const TIMEOUT_MAX_MINUTES = 28 * 24 * 60;
const AUDIT_MAX_ROWS = 5000;
const AUDIT_PAGE_DEFAULT = 50;
const AUDIT_PAGE_MAX = 100;

/**
 * The actions the audit log knows. A route passes one of these, so a typo is a failed lookup while
 * the route is being written rather than an entry no client can describe.
 */
const AUDIT = Object.freeze({
  kick: 'member.kick',
  ban: 'member.ban',
  unban: 'member.unban',
  timeout: 'member.timeout',
  timeoutLifted: 'member.timeout_lifted',
  role: 'member.role',
  invited: 'member.invite',
  joined: 'member.join',
  left: 'member.leave',
  channelCreated: 'channel.create',
  channelRenamed: 'channel.rename',
  channelDeleted: 'channel.delete',
  accessGranted: 'channel.access_grant',
  accessRemoved: 'channel.access_remove',
  serverRenamed: 'server.rename',
  serverIcon: 'server.icon',
  inviteCreated: 'invite.create',
  inviteRevoked: 'invite.revoke',
  appRoomsReset: 'app_rooms.reset',
  // Custom roles (routes/roles.js). A role is named in `detail` ({ roleId, role }), never in
  // `target`, which is only ever a username.
  roleCreated: 'role.create',
  roleUpdated: 'role.update',
  roleDeleted: 'role.delete',
  roleMoved: 'role.move',
  roleAssigned: 'member.role_add',
  roleUnassigned: 'member.role_remove',
  accessRoleGranted: 'channel.access_role_grant',
  accessRoleRemoved: 'channel.access_role_remove',
  // Channel categories and channel order (routes/categories.js).
  categoryCreated: 'category.create',
  categoryRenamed: 'category.rename',
  categoryDeleted: 'category.delete',
  categoryMoved: 'category.move',
  channelMoved: 'channel.move',
  channelFiled: 'channel.category',
});
/** @type {Set<string>} */
const AUDIT_ACTIONS = new Set(Object.values(AUDIT));

/**
 * A reason as it is stored: a string, trimmed, at most REASON_MAX characters, or null for none.
 * Anything that is not a string or is too long is an error rather than something to cut short:
 * the person reading it later should see what was written, or be told it did not fit.
 * @param {unknown} value
 * @returns {{ reason: string | null } | { error: string }}
 */
function parseReason(value) {
  if (value === undefined || value === null) return { reason: null };
  if (typeof value !== 'string') return { error: 'reason must be text' };
  const reason = value.trim();
  if (reason.length > REASON_MAX) return { error: `A reason can be at most ${REASON_MAX} characters` };
  return { reason: reason || null };
}

/**
 * A timeout length in minutes. A whole number, as a number: "60" is refused rather than read as
 * something the admin may not have meant.
 * @param {unknown} value
 * @returns {{ minutes: number } | { error: string }}
 */
function parseMinutes(value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < TIMEOUT_MIN_MINUTES || value > TIMEOUT_MAX_MINUTES) {
    return { error: `minutes must be a whole number between ${TIMEOUT_MIN_MINUTES} and ${TIMEOUT_MAX_MINUTES}` };
  }
  return { minutes: value };
}

/**
 * How a refusal to ban or time someone out is answered: the status and the words for each line
 * of the rule in services/permissions.js (decideAction) that can say no.
 * @param {'no-permission' | 'self' | 'owner' | 'rank'} reason
 * @param {string | null | undefined} actorRole the built-in standing of whoever asked
 * @returns {{ ok: false, status: number, error: string }}
 */
function moderationRefusal(reason, actorRole) {
  if (reason === 'no-permission') return { ok: false, status: 403, error: 'Only server admins can do that' };
  if (reason === 'self') return { ok: false, status: 400, error: "You can't do that to yourself" };
  if (reason === 'owner') return { ok: false, status: 403, error: "The owner can't be moderated" };
  if (actorRole === 'admin') return { ok: false, status: 403, error: 'Admins can only do that to members, not to other admins' };
  return { ok: false, status: 403, error: 'You can only do that to members ranked below you' };
}

/**
 * May `actor` ban or time out `target`, going by the built-in standings alone? `targetRole` is
 * null for someone who is not a member (a ban can still be placed on them). The routes ask
 * permissions.mayActOn, which also knows custom roles; this is the same rule (decideAction) for
 * a server that has none.
 * @param {{ actor: string, actorRole: string | null, target: string, targetRole: string | null, owner: string | null }} who
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
function mayModerate({ actor, actorRole, target, targetRole, owner }) {
  const verdict = decideAction({
    actorCan: isStaffRole(actorRole),
    self: target === actor,
    // By name as well as by role: the owner column is what the rest of the server trusts.
    targetIsOwner: target === owner || targetRole === 'owner',
    actorRank: builtinRank(actorRole),
    targetRank: builtinRank(targetRole),
  });
  return verdict.ok ? verdict : moderationRefusal(verdict.reason, actorRole);
}

/**
 * @typedef {import('../db/migrate').Db} Db
 * @param {{ db: Db, commonsId: string, now?: () => number }} deps `now` is the clock every expiry
 *   check reads; tests pass their own.
 */
function createModeration({ db, commonsId, now = Date.now }) {
  // --- Bans ---

  /**
   * The ban on this person in this server, or null.
   * @param {string} serverId @param {string | null | undefined} username
   */
  async function banOf(serverId, username) {
    if (!username || serverId === commonsId) return null;
    return (await db.get(
      'SELECT username, banned_by AS bannedBy, reason, banned_at AS bannedAt FROM server_bans WHERE server_id = ? AND username = ?',
      serverId, username
    )) || null;
  }

  /** @param {string} serverId */
  async function listBans(serverId) {
    if (serverId === commonsId) return [];
    return db.all(
      'SELECT username, banned_by AS bannedBy, reason, banned_at AS bannedAt FROM server_bans WHERE server_id = ? ORDER BY banned_at DESC, username ASC',
      serverId
    );
  }

  /**
   * Record a ban. Banning again replaces the reason and keeps the row a single one.
   * @param {string} serverId @param {string} username @param {string} by @param {string | null} reason
   */
  async function ban(serverId, username, by, reason) {
    const bannedAt = now();
    await db.run(
      'INSERT OR REPLACE INTO server_bans (server_id, username, banned_by, reason, banned_at) VALUES (?, ?, ?, ?, ?)',
      serverId, username, by, reason, bannedAt
    );
    return { username, bannedBy: by, reason, bannedAt };
  }

  /**
   * @param {string} serverId @param {string} username
   * @returns {Promise<boolean>} whether there was a ban to lift
   */
  async function unban(serverId, username) {
    const removed = await db.run('DELETE FROM server_bans WHERE server_id = ? AND username = ?', serverId, username);
    return removed.changes > 0;
  }

  // --- Timeouts ---

  /**
   * The timeout this person is under in this server right now, or null: none, or one that has run
   * out. This is the check every gate uses.
   * @param {string} serverId @param {string | null | undefined} username
   * @returns {Promise<{ until: number, reason: string | null, by: string | null } | null>}
   */
  async function timeoutOf(serverId, username) {
    if (!username || typeof serverId !== 'string' || serverId === commonsId) return null;
    const row = await db.get(
      'SELECT until, reason, timed_out_by FROM server_timeouts WHERE server_id = ? AND username = ? AND until > ?',
      serverId, username, now()
    );
    return row ? { until: row.until, reason: row.reason || null, by: row.timed_out_by || null } : null;
  }

  /**
   * Everyone timed out in a server right now, as username -> until. For the member list.
   * @param {string} serverId
   * @returns {Promise<Map<string, number>>}
   */
  async function timeoutsIn(serverId) {
    if (serverId === commonsId) return new Map();
    const rows = await db.all('SELECT username, until FROM server_timeouts WHERE server_id = ? AND until > ?', serverId, now());
    return new Map(rows.map((r) => [r.username, r.until]));
  }

  /**
   * Time someone out for `minutes` from now. A second timeout replaces the first (shorter or
   * longer): the latest decision is the one that stands. Rows that have run out are cleared here,
   * the only place the table grows, so it never holds more than the timeouts still in force.
   * @param {string} serverId @param {string} username @param {string} by @param {number} minutes @param {string | null} reason
   */
  async function setTimeoutFor(serverId, username, by, minutes, reason) {
    const at = now();
    const until = at + minutes * 60_000;
    await db.run('DELETE FROM server_timeouts WHERE until <= ?', at);
    await db.run(
      'INSERT OR REPLACE INTO server_timeouts (server_id, username, until, timed_out_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      serverId, username, until, by, reason, at
    );
    return { until, reason, by };
  }

  /**
   * Lift a timeout early.
   * @param {string} serverId @param {string} username
   * @returns {Promise<boolean>} whether one was still in force
   */
  async function clearTimeoutFor(serverId, username) {
    const active = await timeoutOf(serverId, username);
    await db.run('DELETE FROM server_timeouts WHERE server_id = ? AND username = ?', serverId, username);
    return !!active;
  }

  // --- Audit log ---

  /**
   * Write one entry. Never throws: the action it records has already happened, and a log that
   * could fail it (or leave a request unanswered) would be worse than a missing line. Nothing is
   * written for the commons.
   * @param {string} serverId
   * @param {string | null | undefined} actor who did it
   * @param {string} action one of AUDIT
   * @param {string | null} [target] the member it was done to, if it was done to one
   * @param {Record<string, unknown> | null} [detail] everything else; never message text
   */
  async function audit(serverId, actor, action, target = null, detail = null) {
    if (serverId === commonsId) return;
    try {
      if (!AUDIT_ACTIONS.has(action)) throw new Error(`unknown audit action "${action}"`);
      await db.run(
        'INSERT INTO server_audit (server_id, ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)',
        serverId, now(), actor || null, action, target || null, detail ? JSON.stringify(detail) : null
      );
      // Everything older than the newest AUDIT_MAX_ROWS of this server. The subquery finds the id
      // of the first row past that many; with fewer rows it finds nothing and nothing is deleted.
      await db.run(
        `DELETE FROM server_audit WHERE server_id = ? AND id <= (
           SELECT id FROM server_audit WHERE server_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
        serverId, serverId, AUDIT_MAX_ROWS
      );
    } catch (err) {
      console.error('[audit] could not record', action, 'in', serverId, err && /** @type {any} */ (err).message);
    }
  }

  /**
   * A page of a server's log, newest first. `before` is the id of the oldest entry already held.
   * @param {string} serverId @param {{ before?: number | null, limit?: number }} [page]
   * @returns {Promise<{ entries: { id: number, ts: number, actor: string | null, action: string, target: string | null, detail: Record<string, unknown> | null }[], hasMore: boolean }>}
   */
  async function auditPage(serverId, { before = null, limit = AUDIT_PAGE_DEFAULT } = {}) {
    if (serverId === commonsId) return { entries: [], hasMore: false };
    const take = Math.max(1, Math.min(limit, AUDIT_PAGE_MAX));
    // One more than the page holds: the extra row is how "there is more" is known without counting.
    const rows = before
      ? await db.all('SELECT id, ts, actor, action, target, detail FROM server_audit WHERE server_id = ? AND id < ? ORDER BY id DESC LIMIT ?', serverId, before, take + 1)
      : await db.all('SELECT id, ts, actor, action, target, detail FROM server_audit WHERE server_id = ? ORDER BY id DESC LIMIT ?', serverId, take + 1);
    const hasMore = rows.length > take;
    const entries = (hasMore ? rows.slice(0, take) : rows).map((r) => {
      let detail = null;
      try { detail = r.detail ? JSON.parse(r.detail) : null; } catch (_) { detail = null; }
      return { id: r.id, ts: r.ts, actor: r.actor || null, action: r.action, target: r.target || null, detail };
    });
    return { entries, hasMore };
  }

  /**
   * Everything this module keeps for a server, for when the server itself is deleted.
   * @param {string} serverId
   */
  async function forgetServer(serverId) {
    await db.run('DELETE FROM server_bans WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_timeouts WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_audit WHERE server_id = ?', serverId);
  }

  return {
    banOf, listBans, ban, unban,
    timeoutOf, timeoutsIn, setTimeoutFor, clearTimeoutFor,
    audit, auditPage, forgetServer,
  };
}

module.exports = {
  createModeration, mayModerate, moderationRefusal, parseReason, parseMinutes, AUDIT,
  REASON_MAX, TIMEOUT_MIN_MINUTES, TIMEOUT_MAX_MINUTES, AUDIT_MAX_ROWS, AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX,
};
