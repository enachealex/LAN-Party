// Server moderation routes: bans, timeouts, and reading the audit log. The rules and the storage
// are services/moderation.js (which also says how a ban differs from a kick); taking a member out
// of a server is the kick route's own clean-up, shared from routes/servers.js so that a ban can
// never forget a step a kick performs.
//
// Every route here is for owner/admins of a real server. The public commons is refused by name
// before anything else is looked at: it has no staff, and nobody is ever put out of it.
const { rateLimit } = require('../rateLimit');
const { mayModerate, parseReason, parseMinutes, AUDIT, AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX } = require('../services/moderation');

// Counted per account. Generous for someone actually dealing with a problem; a ceiling for a
// script (or a stolen admin token) banning its way through a member list, since every ban of a
// member also replaces the server's app room keys and ends its running apps.
const keyOf = (/** @type {any} */ req) => req.user && req.user.username;
const MODERATION_WRITE_LIMIT = { id: 'moderation-write', windowMs: 5 * 60_000, max: 60, message: 'Too many moderation actions just now. Wait a few minutes.', keyOf };
const MODERATION_READ_LIMIT = { id: 'moderation-read', windowMs: 60_000, max: 120, keyOf };

/** @param {Record<string, any>} deps */
function registerModerationRoutes({ app, db, io, authMiddleware, DEMO_ID, roleOf, moderation, removeMemberFromServer, broadcastServerState, enforceVoiceAccess }) {
  // Express 4 does not catch a rejected async handler, and an unhandled rejection ends the process.
  const safely = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (e) {
      console.error('[moderation] error:', e);
      if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
      return undefined;
    }
  };

  // The gate every route passes first: a real server, not the commons, and the caller is staff of
  // THIS server (the role is read for the server in the URL, so being an admin somewhere else is
  // worth nothing here). Answers the request itself when it fails.
  async function staffServer(req, res) {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) { res.status(400).json({ error: 'The public server has no moderation' }); return null; }
    const srv = await db.get('SELECT id, name, owner FROM servers WHERE id = ?', serverId);
    if (!srv) { res.status(404).json({ error: 'Server not found' }); return null; }
    const myRole = await roleOf(serverId, req.user.username);
    if (myRole !== 'owner' && myRole !== 'admin') { res.status(403).json({ error: 'Only server admins can do that' }); return null; }
    return { srv, myRole };
  }

  // The staff gate, then the rank rules for acting on the member named in the URL.
  async function moderationTarget(req, res) {
    const gate = await staffServer(req, res);
    if (!gate) return null;
    const target = String(req.params.username || '').trim();
    if (!target) { res.status(400).json({ error: 'Username required' }); return null; }
    const targetRole = await roleOf(gate.srv.id, target);
    const allowed = mayModerate({ actor: req.user.username, actorRole: gate.myRole, target, targetRole, owner: gate.srv.owner || null });
    if (!allowed.ok) { res.status(allowed.status).json({ error: allowed.error }); return null; }
    return { ...gate, target, targetRole };
  }

  // --- Bans ---

  app.get('/servers/:serverId/bans', authMiddleware, rateLimit(MODERATION_READ_LIMIT), safely(async (req, res) => {
    const gate = await staffServer(req, res);
    if (!gate) return undefined;
    return res.json({ bans: await moderation.listBans(gate.srv.id) });
  }));

  // Ban: out of the server like a kick, and kept out until unbanned. The person need not be a
  // member (then it only keeps them from joining), but must be a real account: a ban on a name
  // nobody holds would fall on whoever registers it later.
  app.post('/servers/:serverId/bans/:username', authMiddleware, rateLimit(MODERATION_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await moderationTarget(req, res);
    if (!ctx) return undefined;
    const { srv, target, targetRole } = ctx;
    const parsed = parseReason((req.body || {}).reason);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (!(await db.get('SELECT 1 AS one FROM users WHERE username = ?', target))) return res.status(404).json({ error: `No user named "${target}"` });
    // The ban first, then the removal: there is no moment at which they are out but not yet barred.
    const ban = await moderation.ban(srv.id, target, req.user.username, parsed.reason);
    const wasMember = !!targetRole;
    if (wasMember) await removeMemberFromServer(srv.id, target, req.user.username, { banned: true });
    await moderation.audit(srv.id, req.user.username, AUDIT.ban, target, { reason: parsed.reason, wasMember });
    return res.json({ success: true, ban, removed: wasMember });
  }));

  // Unban. They are not put back: whoever was removed by the ban is where a kick would have left
  // them, and comes back when staff invite them by username.
  app.delete('/servers/:serverId/bans/:username', authMiddleware, rateLimit(MODERATION_WRITE_LIMIT), safely(async (req, res) => {
    const gate = await staffServer(req, res);
    if (!gate) return undefined;
    const target = String(req.params.username || '').trim();
    if (!(await moderation.unban(gate.srv.id, target))) return res.status(404).json({ error: `${target} is not banned` });
    await moderation.audit(gate.srv.id, req.user.username, AUDIT.unban, target);
    return res.json({ success: true });
  }));

  // --- Timeouts ---

  // What the timed-out person's own windows are told. `now` is this server's clock at the moment
  // of sending, so a client whose clock is off can still count down the right length of time.
  const tellTarget = (serverId, target, timeout) => {
    if (timeout) io.to(`user:${target}`).emit('server:timeout', { serverId, until: timeout.until, reason: timeout.reason, by: timeout.by, now: Date.now() });
    else io.to(`user:${target}`).emit('server:timeout-lifted', { serverId });
  };

  app.post('/servers/:serverId/timeouts/:username', authMiddleware, rateLimit(MODERATION_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await moderationTarget(req, res);
    if (!ctx) return undefined;
    const { srv, target, targetRole } = ctx;
    const length = parseMinutes((req.body || {}).minutes);
    if ('error' in length) return res.status(400).json({ error: length.error });
    const parsed = parseReason((req.body || {}).reason);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });
    if (!targetRole) return res.status(404).json({ error: 'Not a member' });
    const timeout = await moderation.setTimeoutFor(srv.id, target, req.user.username, length.minutes, parsed.reason);
    // In a call of this server right now: out of it. mayBeInVoice says no from this moment on.
    await enforceVoiceAccess(target, srv.id);
    tellTarget(srv.id, target, timeout);
    await broadcastServerState(srv.id); // everyone's member list gains the marker
    await moderation.audit(srv.id, req.user.username, AUDIT.timeout, target, { minutes: length.minutes, until: timeout.until, reason: parsed.reason });
    return res.json({ success: true, timeout: { username: target, until: timeout.until, reason: timeout.reason, by: timeout.by } });
  }));

  // Lift a timeout before it runs out. Held to the same rank rules as placing one.
  app.delete('/servers/:serverId/timeouts/:username', authMiddleware, rateLimit(MODERATION_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await moderationTarget(req, res);
    if (!ctx) return undefined;
    const { srv, target } = ctx;
    if (!(await moderation.clearTimeoutFor(srv.id, target))) return res.status(404).json({ error: `${target} is not timed out` });
    tellTarget(srv.id, target, null);
    await broadcastServerState(srv.id);
    await moderation.audit(srv.id, req.user.username, AUDIT.timeoutLifted, target);
    return res.json({ success: true });
  }));

  // --- Audit log ---

  // Newest first, a page at a time: ?before=<id of the oldest entry already held>&limit=<n>.
  // Digits only, like message history: a cursor that is not a number is an error, not "no cursor",
  // or a client with a broken one would be handed the newest page and append it to the wrong place.
  const positiveInt = (value) => (typeof value === 'string' && /^\d{1,15}$/.test(value) && Number(value) >= 1 ? Number(value) : null);
  app.get('/servers/:serverId/audit', authMiddleware, rateLimit(MODERATION_READ_LIMIT), safely(async (req, res) => {
    const gate = await staffServer(req, res);
    if (!gate) return undefined;
    let limit = AUDIT_PAGE_DEFAULT;
    if (req.query.limit !== undefined) {
      const n = positiveInt(req.query.limit);
      if (n == null) return res.status(400).json({ error: 'limit must be a positive whole number' });
      limit = Math.min(n, AUDIT_PAGE_MAX);
    }
    let before = null;
    if (req.query.before !== undefined) {
      before = positiveInt(req.query.before);
      if (before == null) return res.status(400).json({ error: 'before must be an entry id' });
    }
    return res.json(await moderation.auditPage(gate.srv.id, { before, limit }));
  }));
}

module.exports = { registerModerationRoutes, MODERATION_WRITE_MAX: MODERATION_WRITE_LIMIT.max };
