// Shareable server invite links. POST /servers/:serverId/invite (routes/servers.js) only works when
// an admin already knows someone's exact username; a link can be pasted anywhere and used by people
// who do not have an account yet.
//
// Rules:
// - The code is the credential. It comes from crypto.randomBytes (96 bits), so it cannot be guessed
//   or enumerated, and nothing about the server can be read back out of it.
// - Only owner/admins mint, list and revoke. The public 'demo' server has no links: everyone is
//   already in it.
// - GET /invites/:code is deliberately unauthenticated, because a logged-out visitor has to see what
//   they are about to join before making an account. It therefore says as little as possible (name,
//   icon, member count) and gives ONE answer for every code that cannot be used. Revoked, expired,
//   used up and never-existed are indistinguishable, so the endpoint cannot be used to learn that a
//   code was once real.
// - A link only ever grants 'member'. Roles are still changed by the owner, by hand.
// - A link does not undo a kick. Someone staff removed (server_removed, written by the kick route in
//   routes/servers.js) is refused by every link to that server until staff add them back by
//   username, and gets the same answer as for a dead code. The links a person minted are revoked
//   when they stop being staff there (kicked, demoted, left); that happens in routes/servers.js too.
const crypto = require('crypto');
const { rateLimit } = require('../rateLimit');

// 12 random bytes -> 16 base64url characters. Well past the point where guessing is hopeless, and
// still short enough to paste into a chat without it wrapping.
const CODE_BYTES = 12;
// Anything that is not shaped like a code is refused before it reaches the database.
const CODE_RE = /^[A-Za-z0-9_-]{10,64}$/;
// A ceiling on live links per server, so the table cannot be grown without bound by one admin (or
// one admin's stolen token) clicking Create in a loop. Revoking one frees a slot.
const MAX_ACTIVE_INVITES = 50;
const INVALID_MESSAGE = 'This invite link is invalid or has expired.';

// Limits for the two routes a stranger can reach. They are per caller address, and a whole LAN party
// shares one address behind the venue's router, so they are sized for a room full of people opening
// the same link in the same few minutes. Guessing is not what these guard against (2^96 codes takes
// care of that); they stop one client hammering the database.
const LOOKUP_LIMIT = { id: 'invite-lookup', windowMs: 5 * 60_000, max: 120 };
const ACCEPT_LIMIT = { id: 'invite-accept', windowMs: 5 * 60_000, max: 60 };

// "Can still be used", as one SQL fragment so every query agrees on what that means. Takes one
// parameter: the current time.
const ACTIVE = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)';

/** @param {Record<string, any>} deps */
function registerInviteRoutes({ app, db, io, authMiddleware, DEMO_ID, roleOf, isMember, isStaffRole, broadcastServerState, validate, inviteLinkInput }) {
  const newCode = () => crypto.randomBytes(CODE_BYTES).toString('base64url');

  // The one response for every unusable code. Same status and same body whatever the reason.
  const refuse = (res) => res.status(404).json({ valid: false, error: INVALID_MESSAGE });

  // `path` is what the client appends to its own origin. The server does not build the absolute URL
  // because it cannot know which hostname the admin is looking at (LAN address, tunnel, desktop app).
  const shape = (row) => ({
    code: row.code,
    path: `/app/?invite=${row.code}`,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at ?? null,
    maxUses: row.max_uses ?? null,
    uses: row.uses || 0,
  });

  // Shared gate for the three management routes. Answers the request itself when it fails.
  async function staffServer(req, res, action) {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) { res.status(400).json({ error: 'Everyone is already in the public server' }); return null; }
    const srv = await db.get('SELECT id, name FROM servers WHERE id = ?', serverId);
    if (!srv) { res.status(404).json({ error: 'Server not found' }); return null; }
    if (!isStaffRole(await roleOf(serverId, req.user.username))) { res.status(403).json({ error: `Only server admins can ${action}` }); return null; }
    return srv;
  }

  // Accepts run one at a time. The conditional UPDATE below is what makes a 1-use link safe between
  // two DIFFERENT people; this queue covers the same person accepting twice at once (a double click,
  // two tabs). Without it both requests pass the "already a member?" check before either has
  // inserted, and the link is charged two uses for one new member.
  let acceptQueue = Promise.resolve();
  function serially(fn) {
    const run = acceptQueue.then(fn, fn);
    acceptQueue = run.catch(() => {}); // one failed accept must not wedge the queue for everyone after it
    return run;
  }

  // Mint a link (owner/admin).
  app.post('/servers/:serverId/invites', rateLimit({ id: 'invite-create', windowMs: 10 * 60_000, max: 120 }), authMiddleware, async (req, res) => {
    const srv = await staffServer(req, res, 'create invite links');
    if (!srv) return undefined;
    const input = validate(inviteLinkInput, req.body || {});
    if (!input.ok) return res.status(400).json({ error: input.error });
    const now = Date.now();
    const live = await db.get(`SELECT COUNT(*) AS n FROM server_invites WHERE server_id = ? AND ${ACTIVE}`, srv.id, now);
    if ((live?.n || 0) >= MAX_ACTIVE_INVITES) return res.status(400).json({ error: 'This server has too many active invite links. Revoke one first.' });
    const row = {
      code: newCode(),
      created_by: req.user.username,
      created_at: now,
      expires_at: input.data.expiresInHours ? now + input.data.expiresInHours * 3_600_000 : null,
      max_uses: input.data.maxUses || null,
      uses: 0,
    };
    await db.run(
      'INSERT INTO server_invites (code, server_id, created_by, created_at, expires_at, max_uses, uses) VALUES (?, ?, ?, ?, ?, ?, 0)',
      row.code, srv.id, row.created_by, row.created_at, row.expires_at, row.max_uses
    );
    return res.json({ invite: shape(row) });
  });

  // Links that can still be used, newest first (owner/admin). Dead ones are left out: there is
  // nothing an admin can do with them.
  app.get('/servers/:serverId/invites', authMiddleware, async (req, res) => {
    const srv = await staffServer(req, res, 'view invite links');
    if (!srv) return undefined;
    const rows = await db.all(
      `SELECT code, created_by, created_at, expires_at, max_uses, uses FROM server_invites
        WHERE server_id = ? AND ${ACTIVE} ORDER BY created_at DESC, code ASC`,
      srv.id, Date.now()
    );
    return res.json({ invites: rows.map(shape) });
  });

  // Revoke a link (owner/admin). Scoped to the server in the URL, so an admin of one server cannot
  // kill another server's link by knowing its code.
  app.delete('/servers/:serverId/invites/:code', authMiddleware, async (req, res) => {
    const srv = await staffServer(req, res, 'revoke invite links');
    if (!srv) return undefined;
    const code = String(req.params.code || '');
    const row = await db.get('SELECT code FROM server_invites WHERE code = ? AND server_id = ?', code, srv.id);
    if (!row) return res.status(404).json({ error: 'Invite link not found' });
    // Revoking twice keeps the first timestamp, and still answers success.
    await db.run('UPDATE server_invites SET revoked_at = ? WHERE code = ? AND server_id = ? AND revoked_at IS NULL', Date.now(), code, srv.id);
    return res.json({ success: true });
  });

  // What a link leads to. No auth: see the header comment for why, and for what it must not leak.
  app.get('/invites/:code', rateLimit(LOOKUP_LIMIT), async (req, res) => {
    // A preview that outlives a revoke would be a lie, so nothing between here and the browser may keep it.
    res.setHeader('Cache-Control', 'no-store');
    const code = String(req.params.code || '');
    if (!CODE_RE.test(code)) return refuse(res);
    const srv = await db.get(
      `SELECT s.id, s.name, s.icon_url FROM servers s
        WHERE s.id = (SELECT server_id FROM server_invites WHERE code = ? AND ${ACTIVE})`,
      code, Date.now()
    );
    if (!srv) return refuse(res);
    const count = await db.get('SELECT COUNT(*) AS n FROM server_members WHERE server_id = ?', srv.id);
    // The server id is left out on purpose. Nothing here needs it, and it is only handed over by
    // /accept, to someone who is by then a member.
    return res.json({ valid: true, server: { name: srv.name, iconUrl: srv.icon_url || null, memberCount: count?.n || 0 } });
  });

  // Use a link: the caller becomes a 'member' of the server it points at.
  app.post('/invites/:code/accept', rateLimit(ACCEPT_LIMIT), authMiddleware, async (req, res) => {
    const me = req.user.username;
    const code = String(req.params.code || '');
    if (!CODE_RE.test(code)) return refuse(res);
    // A token outlives its account for a while after deactivation. Never add a member row for a
    // username that no longer exists (and that someone else could register tomorrow).
    if (!(await db.get('SELECT 1 FROM users WHERE username = ?', me))) return res.status(401).json({ error: 'Account not found' });

    const outcome = await serially(async () => {
      // Membership is checked against the link's server whatever state the link is in. Someone who
      // already joined must be told so when they open the same link again, even if their own join
      // was what used it up. It tells them nothing new: they are a member of that server.
      const srv = await db.get(
        'SELECT s.id, s.name, s.icon_url FROM servers s WHERE s.id = (SELECT server_id FROM server_invites WHERE code = ?)',
        code
      );
      if (!srv) return null;
      if (await isMember(srv.id, me)) return { srv, alreadyMember: true };
      // Removed by staff: no link lets them back in, and the link is not charged for the attempt.
      // Before the claim below, so a refused person cannot burn the uses of a limited link either.
      if (await db.get('SELECT 1 FROM server_removed WHERE server_id = ? AND username = ?', srv.id, me)) return null;
      // The check and the increment are ONE statement, so two people racing for the last use cannot
      // both get it: SQLite applies the first, and the second no longer matches `uses < max_uses`.
      const claim = await db.run(`UPDATE server_invites SET uses = uses + 1 WHERE code = ? AND ${ACTIVE}`, code, Date.now());
      if (!claim.changes) return null;
      const added = await db.run('INSERT OR IGNORE INTO server_members (server_id, username, role) VALUES (?, ?, ?)', srv.id, me, 'member');
      if (!added.changes) {
        // An admin added them by username in the instant between the check and the insert. They are
        // in either way, so hand the use back rather than charge the link for nothing.
        await db.run('UPDATE server_invites SET uses = uses - 1 WHERE code = ? AND uses > 0', code);
        return { srv, alreadyMember: true };
      }
      return { srv, alreadyMember: false };
    });

    if (!outcome) return refuse(res);
    if (!outcome.alreadyMember) {
      // Same pair of events the by-username invite sends: the newcomer's rail picks the server up,
      // and everyone already in it sees the roster grow.
      io.to(`user:${me}`).emit('servers:updated');
      await broadcastServerState(outcome.srv.id);
    }
    const { srv } = outcome;
    return res.json({ success: true, alreadyMember: outcome.alreadyMember, server: { id: srv.id, name: srv.name, iconUrl: srv.icon_url || null } });
  });
}

module.exports = { registerInviteRoutes, MAX_ACTIVE_INVITES };
