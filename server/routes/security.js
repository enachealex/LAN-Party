// Account security that is managed while signed in, plus the emailed verification link:
//   two-factor     GET  /auth/2fa                    is it on
//                  POST /auth/2fa/setup              start (password) -> the secret, once
//                  POST /auth/2fa/confirm            a current code -> on, and the recovery codes, once
//                  POST /auth/2fa/recovery-codes     a current code -> new recovery codes (old ones die)
//                  POST /auth/2fa/disable            password + a code or a recovery code -> off
//                  POST /admin/users/:username/2fa/clear   instance owners only: the way back in
//                                                    for someone who lost the authenticator AND the
//                                                    recovery codes. Written to the server log.
//   verification   POST /auth/verify-email           the token from the emailed link (no session
//                                                    needed, none given)
//                  POST /auth/verify-email/resend    signed in: send the link again
//
// The second step of signing in itself is POST /auth/login/2fa, next to /auth/login in auth.js.
// Storage, encryption and the limits on wrong codes are services/twoFactor.js; who counts as
// verified is services/emailVerification.js.
//
// A wrong PASSWORD on these routes answers 403, not 401: the client treats a 401 from an
// authenticated route as "this session is over", and a typo in a confirmation box is not that.

const bcrypt = require('bcryptjs');
const { rateLimit } = require('../rateLimit');

/**
 * @param {{
 *   app: any, db: any, io: any, authMiddleware: any,
 *   twoFactor: ReturnType<typeof import('../services/twoFactor').createTwoFactor>,
 *   emailVerification: ReturnType<typeof import('../services/emailVerification').createEmailVerification>,
 *   isInstanceOwner: (username: string) => Promise<boolean>,
 * }} deps
 */
function registerSecurityRoutes({ app, db, io, authMiddleware, twoFactor, emailVerification, isInstanceOwner }) {
  const me = (/** @type {any} */ req) => db.get('SELECT id, username, email, password_hash, email_verified FROM users WHERE username = ?', req.user.username);
  const byAccount = (/** @type {any} */ req) => req.user && req.user.username;

  // Everything that takes a code or a password is limited twice: by address (before the token is
  // even read) and by account. Wrong codes are also counted in the service, which pauses the
  // account's second factor after MAX_FAILURES of them.
  const byAddress = rateLimit({ id: '2fa-manage', windowMs: 15 * 60_000, max: 60 });
  const perAccount = rateLimit({ id: '2fa-manage-account', windowMs: 15 * 60_000, max: 30, keyOf: byAccount });

  /** The answer for a wrong or locked-out code, shared by every route below that takes one. */
  const refuseCode = (/** @type {any} */ res, /** @type {{ reason: string, retryAfter?: number }} */ result) => {
    if (result.reason === 'locked') {
      res.setHeader('Retry-After', String(result.retryAfter || 60));
      return res.status(429).json({ error: 'Too many wrong codes. Try again in a few minutes.', code: 'two-factor-locked', retryAfter: result.retryAfter });
    }
    return res.status(400).json({ error: 'That code is not right. Check the app and try the current one.', code: 'two-factor-failed' });
  };

  app.get('/auth/2fa', authMiddleware, async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(await twoFactor.statusOf(user.id));
  });

  // Start setting up. Asks for the password: a session left open on a shared computer must not be
  // enough to put a stranger's authenticator on the account and lock its owner out.
  // The secret is in this response and never in any other.
  app.post('/auth/2fa/setup', byAddress, authMiddleware, perAccount, async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const password = (req.body || {}).password;
    if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Enter your password' });
    if (!(await bcrypt.compare(password, user.password_hash || ''))) return res.status(403).json({ error: 'That password is not right.', code: 'wrong-password' });
    const started = await twoFactor.beginSetup(user);
    if (!started.ok) return res.status(409).json({ error: 'Two-factor sign-in is already on for this account.' });
    return res.json({ secret: started.secret, otpauthUri: started.otpauthUri, expiresIn: started.expiresIn });
  });

  // Finish: a current code proves the authenticator has the secret. The recovery codes are in this
  // response and never in any other.
  app.post('/auth/2fa/confirm', byAddress, authMiddleware, perAccount, async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const result = await twoFactor.confirmSetup(user.id, (req.body || {}).code);
    if (result.ok) return res.json({ success: true, recoveryCodes: result.recoveryCodes });
    if (result.reason === 'no-setup') return res.status(400).json({ error: 'That setup has expired. Start again.', code: 'two-factor-no-setup' });
    return refuseCode(res, result);
  });

  // New recovery codes. Needs a code from the app itself (a recovery code cannot mint more of them).
  app.post('/auth/2fa/recovery-codes', byAddress, authMiddleware, perAccount, async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!(await twoFactor.isEnabled(user.id))) return res.status(400).json({ error: 'Two-factor sign-in is not on.' });
    const code = (req.body || {}).code;
    if (!code) return res.status(400).json({ error: 'Enter the current code from your authenticator app' });
    const checked = await twoFactor.verifySecondFactor(user.id, { code }, { allowRecovery: false });
    if (!checked.ok) return refuseCode(res, checked);
    return res.json({ success: true, recoveryCodes: await twoFactor.replaceRecoveryCodes(user.id) });
  });

  // Turn it off: the password AND the second factor, so neither a stolen session nor a stolen
  // password alone can remove it.
  app.post('/auth/2fa/disable', byAddress, authMiddleware, perAccount, async (req, res) => {
    const user = await me(req);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { password, code, recoveryCode } = req.body || {};
    if (typeof password !== 'string' || !password || (!code && !recoveryCode)) return res.status(400).json({ error: 'Enter your password and a code' });
    if (!(await twoFactor.isEnabled(user.id))) return res.status(400).json({ error: 'Two-factor sign-in is not on.' });
    if (!(await bcrypt.compare(password, user.password_hash || ''))) return res.status(403).json({ error: 'That password is not right.', code: 'wrong-password' });
    const checked = await twoFactor.verifySecondFactor(user.id, { code, recoveryCode });
    if (!checked.ok) return refuseCode(res, checked);
    await twoFactor.remove(user.id);
    console.log(`[2fa] turned off by ${user.username}`);
    return res.json({ success: true });
  });

  // The way back in for someone who has lost both their authenticator and their recovery codes:
  // an instance owner (services/instanceOwners.js) clears it, after satisfying themselves out of
  // band that the request is real. Nobody else can, and a password reset cannot. The account keeps
  // its password; it signs in with that alone and can set two-factor up again.
  app.post('/admin/users/:username/2fa/clear', rateLimit({ id: '2fa-clear', windowMs: 15 * 60_000, max: 30 }), authMiddleware, async (req, res) => {
    // Asked with the name from the verified session, never from the request.
    if (!(await isInstanceOwner(req.user.username))) return res.status(403).json({ error: 'Only an instance owner can do that.' });
    const target = await db.get('SELECT id, username FROM users WHERE username = ?', String(req.params.username || ''));
    if (!target) return res.status(404).json({ error: 'User not found' });
    const wasOn = await twoFactor.isEnabled(target.id);
    await twoFactor.remove(target.id);
    // The audit trail: who did it, to whom, and whether there was anything to clear.
    console.log(`[2fa] AUDIT: instance owner "${req.user.username}" cleared two-factor for "${target.username}" (was ${wasOn ? 'on' : 'off'})`);
    return res.json({ success: true, wasEnabled: wasOn });
  });

  // ---- Email verification ----

  // The emailed link lands on the app, which posts the token here. It works signed in or not, on
  // any device, and answers the same either way: verified, and nothing else — no session, no name.
  app.post('/auth/verify-email', rateLimit({ id: 'verify-email', windowMs: 15 * 60_000, max: 30 }), async (req, res) => {
    const result = await emailVerification.confirm((req.body || {}).token);
    if (!result.ok) return res.status(400).json({ error: 'This verification link is invalid or has expired. Sign in and ask for a new one.' });
    // The account's own open windows drop the banner without a reload.
    io.to(`user:${result.username}`).emit('account:email-verified');
    return res.json({ success: true });
  });

  // Send the link again. Three an hour per account and ten per address: enough for a mistyped
  // spam filter, not enough to use the server as a way of mailing someone repeatedly.
  app.post('/auth/verify-email/resend',
    rateLimit({ id: 'verify-resend', windowMs: 60 * 60_000, max: 10, message: 'Too many emails requested — try again later.' }),
    authMiddleware,
    async (req, res, next) => {
      // Nothing to send to an account that is already verified, and that must not use up its quota.
      const user = await me(req);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (emailVerification.rowIsVerified(user)) return res.json({ success: true, alreadyVerified: true });
      req.account = user;
      return next();
    },
    rateLimit({ id: 'verify-resend-account', windowMs: 60 * 60_000, max: 3, message: 'Too many emails requested — try again later.', keyOf: byAccount }),
    async (req, res) => {
      const sent = await emailVerification.sendLink(req.account);
      if (!sent) return res.status(502).json({ error: 'The email could not be sent. Try again in a little while.' });
      return res.json({ success: true, sent: true });
    });
}

module.exports = { registerSecurityRoutes };
