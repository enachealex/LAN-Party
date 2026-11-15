// @ts-check
// Email verification: a new account proves it can read the address it signed up with before it
// may do the things a throwaway account could use to bother people.
//
// WHO IS VERIFIED
//   users.email_verified. Every account that existed when the column was added was set to 1 by
//   the migration: nobody who could use the app before loses anything. A new account starts at 0
//   and becomes 1 by opening the emailed link — or starts at 1 when the instance has no mailer.
//
// THE ONE DECISION POINT: required()
//   Verification is only asked for while the server can actually send email. With no mailer
//   (local development, tests, a self-hoster who never set SMTP up) nobody could ever receive the
//   link, so nobody is asked: every account is treated as verified, and accounts registered in
//   that state are stored as verified so that configuring SMTP later does not lock them out
//   retroactively. Everything else here asks required() and nothing else looks at the mailer.
//
// WHAT AN UNVERIFIED ACCOUNT CANNOT DO
//   The callers decide; this file only answers "may they". HTTP routes use the `requireVerified`
//   middleware (after authMiddleware) and socket handlers ask refusalFor(username). Both give the
//   same sentence and the same machine-readable code, because it is the account's own state and
//   there is nothing to hide from its owner.

const crypto = require('crypto');

const TOKEN_PURPOSE = 'verify-email';
const TOKEN_TTL_MS = 24 * 60 * 60_000;
const REFUSAL_CODE = 'email-unverified';
const REFUSAL_MESSAGE = 'Verify your email first. Open the link we emailed you, or resend it from Settings > Security.';

/**
 * @param {{
 *   db: { run: (sql: string, ...params: any[]) => Promise<any>, get: (sql: string, ...params: any[]) => Promise<any> },
 *   mailer: { isConfigured: () => boolean, sendVerifyEmail: (username: string, to: string, token: string) => Promise<boolean> },
 *   now?: () => number,
 * }} deps
 */
function createEmailVerification({ db, mailer, now = Date.now }) {
  /** Whether this instance asks accounts to verify their address at all: only when it can email them. */
  const required = () => mailer.isConfigured() === true;

  /** What a new account's email_verified column starts as. */
  const initialFlag = () => (required() ? 0 : 1);

  /**
   * Whether this account counts as verified right now (see required()).
   * @param {{ email_verified?: number | null } | null | undefined} row a users row with email_verified
   */
  const rowIsVerified = (row) => !required() || !!(row && row.email_verified);

  /** @param {string | null | undefined} username @returns {Promise<boolean>} false for nobody */
  async function isVerified(username) {
    if (typeof username !== 'string' || !username) return false;
    const row = await db.get('SELECT email_verified FROM users WHERE username = ?', username);
    return !!row && rowIsVerified(row);
  }

  /**
   * Why this account may not do a restricted thing, or null when it may.
   * @param {string | null | undefined} username
   * @returns {Promise<{ error: string, code: string } | null>}
   */
  async function refusalFor(username) {
    return (await isVerified(username)) ? null : { error: REFUSAL_MESSAGE, code: REFUSAL_CODE };
  }

  /** Express middleware, placed after authMiddleware on a route an unverified account may not use. */
  function requireVerified(/** @type {any} */ req, /** @type {any} */ res, /** @type {Function} */ next) {
    refusalFor(req.user && req.user.username).then((refusal) => {
      if (refusal) return res.status(403).json(refusal);
      return next();
    }).catch((err) => {
      console.error('email verification check failed', err && err.message);
      return res.status(500).json({ error: 'Server error' });
    });
  }

  /**
   * Email a fresh link to this account, replacing any earlier one (only the newest link works).
   * @param {{ id: number, username: string, email: string }} user
   * @returns {Promise<boolean>} whether a message was handed to the mailer and accepted
   */
  async function sendLink(user) {
    if (!required() || !user.email) return false;
    const token = crypto.randomBytes(24).toString('base64url');
    await db.run('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?', user.id, TOKEN_PURPOSE);
    await db.run('INSERT INTO auth_tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)', token, user.id, TOKEN_PURPOSE, now() + TOKEN_TTL_MS);
    return mailer.sendVerifyEmail(user.username, user.email, token);
  }

  /**
   * Spend an emailed token. Marks the account verified; it does not sign anyone in.
   * @param {unknown} token
   * @returns {Promise<{ ok: true, username: string } | { ok: false }>}
   */
  async function confirm(token) {
    if (typeof token !== 'string' || !token || token.length > 200) return { ok: false };
    const row = await db.get('SELECT user_id, purpose, expires_at FROM auth_tokens WHERE token = ?', token);
    if (!row || row.purpose !== TOKEN_PURPOSE) return { ok: false };
    // Single use: only the request that deletes the row goes on. An expired one is deleted too.
    const spent = await db.run('DELETE FROM auth_tokens WHERE token = ? AND purpose = ?', token, TOKEN_PURPOSE);
    if (spent.changes !== 1 || row.expires_at < now()) return { ok: false };
    const user = await db.get('SELECT username FROM users WHERE id = ?', row.user_id);
    if (!user) return { ok: false };
    await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', row.user_id);
    return { ok: true, username: user.username };
  }

  return { required, initialFlag, rowIsVerified, isVerified, refusalFor, requireVerified, sendLink, confirm };
}

module.exports = { createEmailVerification, TOKEN_PURPOSE, TOKEN_TTL_MS, REFUSAL_CODE, REFUSAL_MESSAGE };
