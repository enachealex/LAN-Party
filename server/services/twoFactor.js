// @ts-check
// Two-factor login: everything that touches a TOTP secret, a recovery code or a sign-in ticket.
// The arithmetic is services/totp.js; the routes are routes/security.js and POST /auth/login.
//
// WHAT IS KEPT, AND HOW
//   The TOTP secret has to be readable by the server (it computes the same code the phone does),
//   so it cannot be hashed. It is encrypted instead: AES-256-GCM under a key derived from the
//   server secret with its own label (deriveKey), with the account's id as associated data so a
//   row copied onto another account does not decrypt. The database file alone — a backup, a copy
//   of data.sqlite — does not give up anyone's secret.
//
//   Recovery codes are only ever compared, so only a hash is kept: HMAC-SHA256 under another
//   derived key. A fast hash on purpose. bcrypt's slowness exists to make guessing a human-chosen
//   password expensive; a recovery code is 80 random bits, which nobody guesses at any speed, and
//   the key means the database alone cannot even check a guess.
//
//   A ticket is what the password step hands back INSTEAD of a session when the account has
//   two-factor on. It is a JWT, but signed with a third derived key rather than JWT_SECRET, so the
//   session checks (authMiddleware, the socket handshake, anything else calling jwt.verify with
//   JWT_SECRET) reject it on its signature — it is not a matter of remembering to look at a claim.
//   It also carries no `username`, which is the one thing a session is. Each ticket has a row
//   (login_tickets) that is deleted when it is used or has taken too many wrong codes, which is
//   what makes it single-use across a restart.
//
// LIMITS
//   A code is refused unless its time-step is later than the last one accepted for the account, so
//   a code seen over a shoulder cannot be used again inside its 30 seconds (or the drift window).
//   MAX_FAILURES wrong answers in a row and the account's second step is paused for LOCK_MS,
//   whichever ticket (or settings form) they came through; the tickets outstanding die with it.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { deriveKey } = require('./hostedApps');
const totp = require('./totp');

const ISSUER = 'LAN Party';
const SETUP_TTL_MS = 15 * 60_000;
const TICKET_TTL_SECONDS = 5 * 60;
const TICKET_AUDIENCE = 'lanparty-2fa';
const MAX_FAILURES = 5;
const LOCK_MS = 5 * 60_000;
const RECOVERY_CODE_COUNT = 10;

/** What someone typed, as the hash sees it: letters and digits only, upper case. */
const normalizeRecoveryCode = (/** @type {unknown} */ text) => String(text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * @param {{
 *   db: { run: (sql: string, ...params: any[]) => Promise<any>, get: (sql: string, ...params: any[]) => Promise<any>, all: (sql: string, ...params: any[]) => Promise<any[]> },
 *   secret: string,
 *   now?: () => number,
 * }} deps `secret` is the server secret (JWT_SECRET); nothing here uses it directly.
 */
function createTwoFactor({ db, secret, now = Date.now }) {
  const secretKey = deriveKey(secret, 'lanparty:totp-secret:v1');
  const recoveryKey = deriveKey(secret, 'lanparty:2fa-recovery:v1');
  const ticketKey = deriveKey(secret, 'lanparty:2fa-ticket:v1');

  /** @param {Buffer} plain @param {number} userId */
  function seal(plain, userId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    cipher.setAAD(Buffer.from(`totp:${userId}`));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  /**
   * @param {string | null | undefined} sealed @param {number} userId
   * @returns {Buffer | null} null when it is not ours, was moved between accounts, or the server secret changed
   */
  function open(sealed, userId) {
    const parts = String(sealed || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(parts[1], 'base64url'));
      decipher.setAAD(Buffer.from(`totp:${userId}`));
      decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(parts[2], 'base64url')), decipher.final()]);
    } catch (_) {
      return null;
    }
  }

  /** @param {number} userId @param {string} code already normalised */
  const hashRecoveryCode = (userId, code) => crypto.createHmac('sha256', recoveryKey).update(`${userId}:${code}`).digest('hex');

  const rowOf = (/** @type {number} */ userId) => db.get('SELECT * FROM user_two_factor WHERE user_id = ?', userId);

  /** @param {number} userId @returns {Promise<boolean>} */
  async function isEnabled(userId) {
    const row = await db.get('SELECT enabled_at FROM user_two_factor WHERE user_id = ?', userId);
    return !!(row && row.enabled_at);
  }

  /** What Settings shows. Never the secret, never a code. @param {number} userId */
  async function statusOf(userId) {
    const row = await rowOf(userId);
    const enabled = !!(row && row.enabled_at);
    const left = enabled ? await db.get('SELECT COUNT(*) AS n FROM two_factor_recovery_codes WHERE user_id = ? AND used_at IS NULL', userId) : null;
    return {
      enabled,
      enabledAt: enabled ? row.enabled_at : null,
      recoveryCodesRemaining: left ? left.n : 0,
      setupPending: !enabled && !!(row && row.pending_enc && row.pending_expires_at > now()),
    };
  }

  /**
   * Start (or restart) setting up. The secret leaves the server here and nowhere else.
   * @param {{ id: number, username: string }} user
   * @returns {Promise<{ ok: true, secret: string, otpauthUri: string, expiresIn: number } | { ok: false, reason: 'enabled' }>}
   */
  async function beginSetup(user) {
    if (await isEnabled(user.id)) return { ok: false, reason: 'enabled' };
    const raw = totp.newSecret();
    const sealed = seal(raw, user.id);
    const expires = now() + SETUP_TTL_MS;
    await db.run(
      `INSERT INTO user_two_factor (user_id, pending_enc, pending_expires_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET pending_enc = excluded.pending_enc, pending_expires_at = excluded.pending_expires_at`,
      user.id, sealed, expires
    );
    const secretBase32 = totp.base32Encode(raw);
    return { ok: true, secret: secretBase32, otpauthUri: totp.otpauthUri({ secretBase32, account: user.username, issuer: ISSUER }), expiresIn: Math.floor(SETUP_TTL_MS / 1000) };
  }

  /** Seconds left on the account's pause, or 0. @param {any} row */
  const lockedFor = (row) => (row && row.locked_until > now() ? Math.ceil((row.locked_until - now()) / 1000) : 0);

  /**
   * One more wrong answer. At MAX_FAILURES the second step is paused and every ticket dies.
   * @param {number} userId
   * @returns {Promise<number>} seconds the account is now paused for (0 = not paused)
   */
  async function noteFailure(userId) {
    await db.run('UPDATE user_two_factor SET failures = failures + 1 WHERE user_id = ?', userId);
    const row = await db.get('SELECT failures FROM user_two_factor WHERE user_id = ?', userId);
    if (!row || row.failures < MAX_FAILURES) return 0;
    await db.run('UPDATE user_two_factor SET failures = 0, locked_until = ? WHERE user_id = ?', now() + LOCK_MS, userId);
    await db.run('DELETE FROM login_tickets WHERE user_id = ?', userId);
    return Math.ceil(LOCK_MS / 1000);
  }

  /**
   * Accept a TOTP code for this secret once: the right digits, in the drift window, and for a
   * time-step later than any already used. The UPDATE is the check, so two requests racing with
   * the same code cannot both win.
   * @param {number} userId @param {Buffer} key @param {unknown} code
   */
  async function acceptTotp(userId, key, code) {
    const step = totp.matchingStep(key, String(code || '').replace(/\s/g, ''), { nowMs: now() });
    if (step === null) return false;
    const res = await db.run('UPDATE user_two_factor SET last_step = ? WHERE user_id = ? AND last_step < ?', step, userId, step);
    return res.changes === 1;
  }

  /** @returns {string[]} fresh codes, as shown to the person: XXXX-XXXX-XXXX-XXXX */
  const newRecoveryCodes = () => Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const text = totp.base32Encode(crypto.randomBytes(10)); // 80 bits, 16 characters
    return (text.match(/.{4}/g) || [text]).join('-');
  });

  /** Replace the account's recovery codes. The old ones stop working. @param {number} userId */
  async function replaceRecoveryCodes(userId) {
    const codes = newRecoveryCodes();
    await db.run('DELETE FROM two_factor_recovery_codes WHERE user_id = ?', userId);
    for (const code of codes) {
      await db.run('INSERT INTO two_factor_recovery_codes (user_id, code_hash) VALUES (?, ?)', userId, hashRecoveryCode(userId, normalizeRecoveryCode(code)));
    }
    return codes;
  }

  /**
   * Finish setting up: a current code from the app proves the secret arrived. Turns two-factor on
   * and returns the recovery codes — the only time they exist in readable form.
   * @param {number} userId @param {unknown} code
   * @returns {Promise<{ ok: true, recoveryCodes: string[] } | { ok: false, reason: 'no-setup' | 'bad-code' | 'locked', retryAfter?: number }>}
   */
  async function confirmSetup(userId, code) {
    const row = await rowOf(userId);
    if (!row || row.enabled_at || !row.pending_enc || !(row.pending_expires_at > now())) return { ok: false, reason: 'no-setup' };
    const paused = lockedFor(row);
    if (paused) return { ok: false, reason: 'locked', retryAfter: paused };
    const key = open(row.pending_enc, userId);
    if (!key) return { ok: false, reason: 'no-setup' };
    if (!(await acceptTotp(userId, key, code))) {
      const nowPaused = await noteFailure(userId);
      return nowPaused ? { ok: false, reason: 'locked', retryAfter: nowPaused } : { ok: false, reason: 'bad-code' };
    }
    await db.run(
      'UPDATE user_two_factor SET secret_enc = pending_enc, pending_enc = NULL, pending_expires_at = NULL, enabled_at = ?, failures = 0 WHERE user_id = ?',
      now(), userId
    );
    return { ok: true, recoveryCodes: await replaceRecoveryCodes(userId) };
  }

  /**
   * The second factor for an account that has it on: a current code, or an unused recovery code
   * (which is used up). Counts wrong answers and enforces the pause.
   * @param {number} userId
   * @param {{ code?: unknown, recoveryCode?: unknown }} given
   * @param {{ allowRecovery?: boolean }} [opts]
   * @returns {Promise<{ ok: true, method: 'totp' | 'recovery' } | { ok: false, reason: 'not-enabled' | 'bad-code' | 'locked', retryAfter?: number }>}
   */
  async function verifySecondFactor(userId, given, { allowRecovery = true } = {}) {
    const row = await rowOf(userId);
    if (!row || !row.enabled_at) return { ok: false, reason: 'not-enabled' };
    const paused = lockedFor(row);
    if (paused) return { ok: false, reason: 'locked', retryAfter: paused };
    /** @type {'totp' | 'recovery' | null} */
    let method = null;
    const recovery = normalizeRecoveryCode(given && given.recoveryCode);
    if (given && given.code != null && String(given.code).trim()) {
      const key = open(row.secret_enc, userId);
      // An unreadable secret means the server secret changed under it (DEPLOY.md says what to do).
      if (!key) console.error('[2fa] the stored secret for user id', userId, 'could not be decrypted: was JWT_SECRET changed?');
      else if (await acceptTotp(userId, key, given.code)) method = 'totp';
    } else if (allowRecovery && recovery) {
      const res = await db.run(
        'UPDATE two_factor_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
        now(), userId, hashRecoveryCode(userId, recovery)
      );
      if (res.changes === 1) method = 'recovery';
    }
    if (!method) {
      const nowPaused = await noteFailure(userId);
      return nowPaused ? { ok: false, reason: 'locked', retryAfter: nowPaused } : { ok: false, reason: 'bad-code' };
    }
    await db.run('UPDATE user_two_factor SET failures = 0 WHERE user_id = ?', userId);
    return { ok: true, method };
  }

  /** Turn it off and forget everything: secret, recovery codes, outstanding tickets. @param {number} userId */
  async function remove(userId) {
    await db.run('DELETE FROM user_two_factor WHERE user_id = ?', userId);
    await db.run('DELETE FROM two_factor_recovery_codes WHERE user_id = ?', userId);
    await db.run('DELETE FROM login_tickets WHERE user_id = ?', userId);
  }

  /**
   * What the password step returns for an account with two-factor on.
   * @param {{ id: number }} user @param {boolean} remember carried through to the session's lifetime
   * @returns {Promise<{ ticket: string, expiresIn: number }>}
   */
  async function issueTicket(user, remember) {
    const jti = crypto.randomBytes(18).toString('base64url');
    const at = now();
    await db.run('DELETE FROM login_tickets WHERE expires_at < ?', at);
    await db.run('INSERT INTO login_tickets (jti, user_id, expires_at) VALUES (?, ?, ?)', jti, user.id, at + TICKET_TTL_SECONDS * 1000);
    const ticket = jwt.sign({ purpose: '2fa', uid: user.id, remember: !!remember, jti }, ticketKey, { algorithm: 'HS256', audience: TICKET_AUDIENCE, expiresIn: TICKET_TTL_SECONDS });
    return { ticket, expiresIn: TICKET_TTL_SECONDS };
  }

  /**
   * The claims of a ticket whose signature, audience and expiry hold. Says nothing about whether
   * it has been used: that is the row. Synchronous, so a rate limiter can key on the account.
   * @param {unknown} ticket
   * @returns {{ uid: number, jti: string, remember: boolean } | null}
   */
  function readTicket(ticket) {
    if (typeof ticket !== 'string' || !ticket || ticket.length > 1000) return null;
    try {
      const claims = /** @type {any} */ (jwt.verify(ticket, ticketKey, { algorithms: ['HS256'], audience: TICKET_AUDIENCE }));
      if (!claims || claims.purpose !== '2fa' || !Number.isInteger(claims.uid) || typeof claims.jti !== 'string') return null;
      return { uid: claims.uid, jti: claims.jti, remember: claims.remember === true };
    } catch (_) {
      return null;
    }
  }

  /**
   * The second step of signing in. 'invalid' covers every way it can fail short of the pause — a
   * forged, expired, used or worn-out ticket and a wrong code are one answer to the caller.
   * @param {unknown} ticket
   * @param {{ code?: unknown, recoveryCode?: unknown }} given
   * @returns {Promise<{ ok: true, userId: number, remember: boolean, method: 'totp' | 'recovery' } | { ok: false, reason: 'invalid' | 'locked', retryAfter?: number }>}
   */
  async function redeemTicket(ticket, given) {
    const claims = readTicket(ticket);
    if (!claims) return { ok: false, reason: 'invalid' };
    const row = await db.get('SELECT jti, user_id, expires_at, failures FROM login_tickets WHERE jti = ?', claims.jti);
    if (!row || row.user_id !== claims.uid || row.expires_at < now()) return { ok: false, reason: 'invalid' };
    const result = await verifySecondFactor(claims.uid, given);
    if (result.ok) {
      // Deleting the row is what spends the ticket; only the request that removed it signs in.
      const spent = await db.run('DELETE FROM login_tickets WHERE jti = ?', claims.jti);
      if (spent.changes !== 1) return { ok: false, reason: 'invalid' };
      return { ok: true, userId: claims.uid, remember: claims.remember, method: result.method };
    }
    if (result.reason === 'locked') return { ok: false, reason: 'locked', retryAfter: result.retryAfter };
    if (result.reason === 'bad-code') {
      await db.run('UPDATE login_tickets SET failures = failures + 1 WHERE jti = ?', claims.jti);
      await db.run('DELETE FROM login_tickets WHERE jti = ? AND failures >= ?', claims.jti, MAX_FAILURES);
    }
    return { ok: false, reason: 'invalid' };
  }

  return { isEnabled, statusOf, beginSetup, confirmSetup, verifySecondFactor, replaceRecoveryCodes, remove, issueTicket, readTicket, redeemTicket };
}

module.exports = { createTwoFactor, normalizeRecoveryCode, SETUP_TTL_MS, TICKET_TTL_SECONDS, MAX_FAILURES, LOCK_MS, RECOVERY_CODE_COUNT, ISSUER };
