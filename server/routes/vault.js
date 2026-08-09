// Single sign-on handoff to Vault Player (github.com/enachealex/Vault-Player).
//
// Vault Player has its own accounts; this lets a LAN Party user land in it already signed in without
// ever typing a Vault password.
//
// SECURITY MODEL — why this isn't just "pass the session token":
//   * The LAN Party JWT grants full control of the account (post as them, change the profile, delete
//     it). It must never leave the client, so Vault Player never sees it.
//   * Instead LAN Party mints a SEPARATE, short-lived assertion that only says "this is user X",
//     bound to aud='vault-player' and signed with VAULT_SSO_SECRET — a different secret from
//     JWT_SECRET. If the Vault side ever leaks its copy, an attacker still cannot forge a LAN Party
//     session, and vice versa.
//   * A 5-minute lifetime keeps the replay window small while surviving a cold app launch; `jti`
//     lets Vault dedupe a login it has already consumed.
//
// Disabled unless VAULT_SSO_SECRET is configured, so an unconfigured deployment can't hand out
// assertions signed with a guessable key.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { rateLimit } = require('../rateLimit');

const AUDIENCE = 'vault-player';
const ISSUER = 'lanparty';
// 5 minutes: a cold Vault Player launch (process start, window, relay handshake) can easily outlive
// 60s, which stranded the user at a login screen. Still short enough that a leaked assertion is
// near-useless, and `jti` blocks replay within the window.
const TTL_SECONDS = 300;

/** @param {Record<string, any>} deps */
function registerVaultRoutes({ app, db, authMiddleware, displayProfileFromSettings, avatarColorForUsername, normalizePresence }) {
  // The shared getUserByUsername() helper selects only id/username/presence_status, so it cannot feed
  // this integration — reading me.settings/me.email off it yields undefined and the caller's own
  // avatar and email silently come back null. Query the columns this route actually needs.
  const loadUser = (username) => db.get(
    `SELECT id, username, email, settings, COALESCE(presence_status, 'offline') AS presence_status
     FROM users WHERE username = ?`,
    username
  );
  const SECRET = process.env.VAULT_SSO_SECRET || '';
  const enabled = !!SECRET;
  if (!enabled) {
    console.log('[vault] SSO disabled (set VAULT_SSO_SECRET to enable)');
  }

  const requireEnabled = (res) => {
    if (enabled) return true;
    res.status(503).json({ error: 'Vault SSO is not configured on this server' });
    return false;
  };

  // Mint an assertion for the CALLING user. The client hands this to Vault Player (query string for
  // the web player, or appended to the vaultmovies:// deep link for the desktop app).
  app.post('/integrations/vault/sso-token', rateLimit({ id: 'vault-sso', windowMs: 5 * 60_000, max: 60 }), authMiddleware, async (req, res) => {
    if (!requireEnabled(res)) return;
    const me = await loadUser(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const token = jwt.sign(
      {
        iss: ISSUER,
        aud: AUDIENCE,
        sub: me.username,          // stable identity key Vault should store
        name: me.username,         // display name (LAN Party username doubles as the display name)
        email: me.email || undefined,
        jti: crypto.randomUUID(),
      },
      SECRET,
      { algorithm: 'HS256', expiresIn: TTL_SECONDS }
    );
    return res.json({ token, tokenType: 'Bearer', expiresIn: TTL_SECONDS, audience: AUDIENCE, issuer: ISSUER });
  });

  // Verify an assertion presented as a bearer token. Used by the userinfo endpoint below; Vault's own
  // /auth/sso does the equivalent check on its side with the shared secret.
  const verifyAssertion = (req) => {
    const header = req.headers.authorization || '';
    const raw = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!raw) return { error: 'Missing bearer assertion' };
    try {
      // Pinning algorithms prevents an "alg" downgrade; audience/issuer stop a token minted for
      // something else being replayed here.
      const claims = jwt.verify(raw, SECRET, { algorithms: ['HS256'], audience: AUDIENCE, issuer: ISSUER });
      return { claims };
    } catch (err) {
      return { error: err && err.name === 'TokenExpiredError' ? 'Assertion expired' : 'Invalid assertion' };
    }
  };

  // Profile + friends for the asserted user. Vault Player calls this server-to-server with the
  // assertion, so it can mirror the LAN Party social graph (its FriendsService) instead of asking the
  // user to rebuild a friends list. Read-only: it exposes only display-safe fields, never secrets,
  // password hashes or another user's email.
  app.get('/integrations/vault/userinfo', rateLimit({ id: 'vault-userinfo', windowMs: 5 * 60_000, max: 120 }), async (req, res) => {
    if (!requireEnabled(res)) return;
    const { claims, error } = verifyAssertion(req);
    if (error) return res.status(401).json({ error });

    const me = await loadUser(claims.sub);
    if (!me) return res.status(404).json({ error: 'User not found' });

    const rows = await db.all(
      `SELECT u.id, u.username, u.settings, COALESCE(u.presence_status, 'offline') AS presence_status
       FROM friendships f
       JOIN users u ON u.id = f.friend_user_id
       WHERE f.user_id = ?
       ORDER BY u.username ASC`,
      me.id
    );

    const shape = (username, settings, presence) => {
      const profile = displayProfileFromSettings(settings);
      return {
        username,
        displayName: username,
        avatarUrl: profile.avatarUrl || null,   // relative /uploads/... path; resolve against origin
        avatarColor: avatarColorForUsername(username), // fallback tile colour when there's no image
        status: normalizePresence(presence),    // available | idle | dnd | offline
      };
    };

    return res.json({
      issuer: ISSUER,
      user: {
        ...shape(me.username, me.settings, me.presence_status),
        email: me.email || null,                // only ever the asserted user's own address
      },
      friends: rows.map((r) => shape(r.username, r.settings, r.presence_status)),
    });
  });
}

module.exports = { registerVaultRoutes, VAULT_AUDIENCE: AUDIENCE, VAULT_ISSUER: ISSUER, VAULT_TTL_SECONDS: TTL_SECONDS };
