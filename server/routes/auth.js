// Authentication + account lifecycle: register, availability check, login, /auth/me, password
// reset (forgot/reset), account deactivation (request + confirm), logout, and the dev mock-emails
// list. deleteUserCompletely lives here since deactivation is its only caller.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mailer = require('../email');

/** @param {{ app: any, db: any, authMiddleware: any, JWT_SECRET: string, isStrongPassword: (pw: string) => boolean, mockEmails: any[] }} deps */
function registerAuthRoutes({ app, db, authMiddleware, JWT_SECRET, isStrongPassword, mockEmails }) {
  app.post('/auth/register', async (req, res) => {
    const { username, email, password, passwordConfirm } = req.body || {};
    if (!username || !email || !password || !passwordConfirm) return res.status(400).json({ error: 'Missing fields' });
    if (password !== passwordConfirm) return res.status(400).json({ error: 'Passwords do not match' });
    if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters and include 1 uppercase letter, 1 lowercase letter, 1 number, and 1 special character.' });
    // basic email format check
    if (!/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    // ensure username and email are unique with specific feedback
    const byUsername = await db.get('SELECT id FROM users WHERE username = ?', username);
    if (byUsername) return res.status(409).json({ error: 'Username already exists', field: 'username' });
    const byEmail = await db.get('SELECT id FROM users WHERE email = ?', email);
    if (byEmail) return res.status(409).json({ error: 'Email already exists', field: 'email' });
    const defaultSettings = {
      railColor: '#7a0d0d', sidebarColor: '#0f1418', panelColor: '#111417', headerColor: '#7a0d0d', accentStart: '#2bc3ff', accentEnd: '#0b86ff', fontColor: '#edf6ff', leftTileColor: '#1f2933',
      // Gaming profile (favorite genres + what they're playing lately) is now collected on first
      // login via the welcome/onboarding flow, not at signup. Start empty until then.
      gamingProfile: { genres: [], currentGames: '', updatedAt: 0 },
      // New accounts see the first-login welcome + gaming-profile onboarding. Existing users don't
      // have this flag, so `=== false` is false for them and they skip it.
      onboardingComplete: false,
    };
    const hash = bcrypt.hashSync(password, 10);
    await db.run('INSERT INTO users (username, email, password_hash, settings) VALUES (?, ?, ?, ?)', username, email, hash, JSON.stringify(defaultSettings));
    // Fire-and-forget welcome email (never block or fail registration on email).
    mailer.sendWelcome(username, email).catch((e) => console.warn('welcome email error', e && e.message));
    return res.json({ success: true });
  });

  app.post('/auth/check-availability', async (req, res) => {
    const { username, email } = req.body || {};
    if (!username && !email) return res.status(400).json({ error: 'Missing username or email' });
    if (username) {
      const byUsername = await db.get('SELECT id FROM users WHERE username = ?', username);
      if (byUsername) return res.json({ username: false });
    }
    if (email) {
      const byEmail = await db.get('SELECT id FROM users WHERE email = ?', email);
      if (byEmail) return res.json({ email: false });
    }
    return res.json({ username: username ? true : undefined, email: email ? true : undefined });
  });

  app.post('/auth/login', async (req, res) => {
    const { username, password, remember } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const settings = user.settings ? JSON.parse(user.settings) : {};
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: remember ? '90d' : '7d' });
    return res.json({ success: true, token, user: { username: user.username, email: user.email, settings } });
  });

  app.get('/auth/me', authMiddleware, async (req, res) => {
    const username = req.user.username;
    const user = await db.get('SELECT username, email, settings FROM users WHERE username = ?', username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ success: true, user: { username: user.username, email: user.email, settings: JSON.parse(user.settings || '{}') } });
  });

  const newAuthToken = () => crypto.randomBytes(24).toString('base64url');

  app.post('/auth/forgot', async (req, res) => {
    const email = String((req.body || {}).email || '').trim();
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const user = await db.get('SELECT id, username FROM users WHERE email = ?', email);
    // Only send when the account exists, but always report success so emails can't be enumerated.
    if (user) {
      const token = newAuthToken();
      await db.run('INSERT INTO auth_tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)', token, user.id, 'reset', Date.now() + 60 * 60 * 1000);
      mailer.sendPasswordReset(user.username, email, token).catch((e) => console.warn('reset email error', e && e.message));
    }
    return res.json({ success: true, message: 'If that email exists, a reset link is on its way.' });
  });

  // Complete a password reset with the emailed token.
  app.post('/auth/reset', async (req, res) => {
    const { token, email, password, passwordConfirm } = req.body || {};
    if (!token || !email || !password) return res.status(400).json({ error: 'Missing fields' });
    if (passwordConfirm != null && password !== passwordConfirm) return res.status(400).json({ error: 'Passwords do not match' });
    if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters and include 1 uppercase letter, 1 lowercase letter, 1 number, and 1 special character.' });
    const row = await db.get('SELECT user_id, purpose, expires_at FROM auth_tokens WHERE token = ?', token);
    if (!row || row.purpose !== 'reset' || row.expires_at < Date.now()) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    const user = await db.get('SELECT id, email FROM users WHERE id = ?', row.user_id);
    if (!user || user.email !== email) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), user.id);
    await db.run('DELETE FROM auth_tokens WHERE token = ?', token);
    return res.json({ success: true });
  });

  // Permanently delete a user and everything they own/authored (used by account deactivation).
  async function deleteUserCompletely(userId, username) {
    const owned = await db.all('SELECT id FROM servers WHERE owner = ?', username);
    await db.run('BEGIN');
    try {
      for (const s of owned) {
        await db.run('DELETE FROM channel_members WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)', s.id);
        await db.run('DELETE FROM channel_reads WHERE server_id = ?', s.id);
        await db.run('DELETE FROM messages WHERE server_id = ?', s.id);
        await db.run('DELETE FROM channels WHERE server_id = ?', s.id);
        await db.run('DELETE FROM server_members WHERE server_id = ?', s.id);
        await db.run('DELETE FROM server_emojis WHERE server_id = ?', s.id);
        await db.run('DELETE FROM servers WHERE id = ?', s.id);
      }
      await db.run('DELETE FROM server_members WHERE username = ?', username);
      await db.run('DELETE FROM channel_members WHERE username = ?', username);
      await db.run('DELETE FROM channel_reads WHERE username = ?', username);
      await db.run('DELETE FROM music_playlists WHERE username = ?', username);
      await db.run('DELETE FROM messages WHERE author = ?', username);
      await db.run('UPDATE messages SET pinned_by = NULL WHERE pinned_by = ?', username);
      await db.run('DELETE FROM server_emojis WHERE created_by = ?', username);
      await db.run('DELETE FROM apps WHERE created_by = ?', username);
      await db.run('DELETE FROM gifs WHERE created_by = ?', username);
      await db.run('DELETE FROM sounds WHERE created_by = ?', username);
      await db.run('DELETE FROM friendships WHERE user_id = ? OR friend_user_id = ?', userId, userId);
      await db.run('DELETE FROM friend_requests WHERE from_user_id = ? OR to_user_id = ?', userId, userId);
      await db.run('DELETE FROM direct_messages WHERE sender_id = ? OR recipient_id = ?', userId, userId);
      await db.run('DELETE FROM auth_tokens WHERE user_id = ?', userId);
      await db.run('DELETE FROM users WHERE id = ?', userId);
      await db.run('COMMIT');
    } catch (e) {
      await db.run('ROLLBACK').catch(() => {});
      throw e;
    }
  }

  // Step 1: request deactivation → emails a confirmation link.
  app.post('/account/deactivate', authMiddleware, async (req, res) => {
    const me = await db.get('SELECT id, username, email FROM users WHERE username = ?', req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    if (!me.email) return res.status(400).json({ error: 'No email on file to confirm with' });
    const token = newAuthToken();
    await db.run('INSERT INTO auth_tokens (token, user_id, purpose, expires_at) VALUES (?, ?, ?, ?)', token, me.id, 'deactivate', Date.now() + 60 * 60 * 1000);
    mailer.sendDeactivationConfirm(me.username, me.email, token).catch((e) => console.warn('deactivation confirm email error', e && e.message));
    return res.json({ success: true, message: 'Check your email to confirm deactivation.' });
  });

  // Step 2: confirm with the emailed token → delete the account + send the goodbye email.
  app.post('/account/deactivate/confirm', async (req, res) => {
    const { token, email } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const row = await db.get('SELECT user_id, purpose, expires_at FROM auth_tokens WHERE token = ?', token);
    if (!row || row.purpose !== 'deactivate' || row.expires_at < Date.now()) return res.status(400).json({ error: 'This confirmation link is invalid or has expired.' });
    const user = await db.get('SELECT id, username, email FROM users WHERE id = ?', row.user_id);
    if (!user || (email && user.email !== email)) return res.status(400).json({ error: 'This confirmation link is invalid or has expired.' });
    try {
      await deleteUserCompletely(user.id, user.username);
    } catch (e) {
      console.error('deactivation failed', e);
      return res.status(500).json({ error: 'Could not deactivate the account' });
    }
    if (user.email) mailer.sendDeactivationDone(user.username, user.email).catch((e) => console.warn('deactivation done email error', e && e.message));
    return res.json({ success: true });
  });

  // Logout: revoke the presented token so it cannot be used again
  app.post('/auth/logout', authMiddleware, async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(400).json({ error: 'Missing token' });
    // try to read expiry from token payload
    let exp = Date.now();
    try {
      const payload = jwt.decode(token) || {};
      exp = payload.exp ? payload.exp * 1000 : Date.now();
    } catch (e) { /* ignore */ }
    try {
      await db.run('INSERT OR REPLACE INTO revoked_tokens (token, expires_at) VALUES (?, ?)', token, exp);
      return res.json({ success: true });
    } catch (err) {
      console.error('Failed to revoke token', err);
      return res.status(500).json({ error: 'Failed to revoke token' });
    }
  });

  app.get('/mock-emails', (req, res) => res.json({ emails: mockEmails }));
}

module.exports = { registerAuthRoutes };
