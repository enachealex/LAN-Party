// Two-factor sign-in through the real server: setup, the two-step login, the ticket, recovery
// codes, lockout and rate limits, turning it off, password reset, and the instance owner's way of
// clearing it. The clock-dependent edges (drift window, expiries, the pause ending) are in
// test/twoFactorService.test.js, where the test owns the clock.
//
// A TOTP code can only be used once per account and only moves forward, so a test here that needs
// several of them for one account would have to wait out real 30-second steps. Each account
// therefore uses at most two (the current step to confirm setup, the next one after it) and
// recovery codes for everything else; accounts are cheap.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, dbAll, PASSWORD } = require('./helpers');
const totp = require('../services/totp');

describe('two-factor sign-in', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */ let server;
  let nextAddress = 0;

  /** An API client that always calls from one address of its own, so the per-address limits of one account never touch another's. */
  function clientFrom(address) {
    return async function call(method, route, body, token) {
      /** @type {Record<string, string>} */
      const headers = { 'X-Forwarded-For': address };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await fetch(server.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      let data = null;
      try { data = await res.json(); } catch (_) { /* no body */ }
      return { status: res.status, data, headers: res.headers };
    };
  }
  const newAddress = () => `203.0.113.${(nextAddress = (nextAddress % 250) + 1)}`;

  /** Register and sign in (no two-factor yet). */
  async function account(username) {
    const call = clientFrom(newAddress());
    const reg = await call('POST', '/auth/register', { username, email: `${username}@example.com`, password: PASSWORD, passwordConfirm: PASSWORD });
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const login = await call('POST', '/auth/login', { username, password: PASSWORD });
    assert.equal(login.status, 200);
    return { username, call, token: login.data.token, registered: reg.data, login: login.data };
  }

  /** An account with two-factor on. `nextCode()` is the one further TOTP code it can use (see the note at the top). */
  async function accountWith2fa(username) {
    const acct = await account(username);
    const started = await acct.call('POST', '/auth/2fa/setup', { password: PASSWORD }, acct.token);
    assert.equal(started.status, 200, JSON.stringify(started.data));
    const key = totp.base32Decode(started.data.secret);
    const confirmedAt = Date.now();
    const confirmed = await acct.call('POST', '/auth/2fa/confirm', { code: totp.totp(key, confirmedAt) }, acct.token);
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
    // The step after the one that confirmed, or after the current one if time has moved on: later
    // than anything accepted so far, and inside the server's window either way.
    const nextCode = () => totp.hotp(key, Math.max(totp.stepAt(confirmedAt), totp.stepAt()) + 1);
    return { ...acct, secret: started.data.secret, otpauthUri: started.data.otpauthUri, recoveryCodes: confirmed.data.recoveryCodes, nextCode };
  }

  /** The password step for an account that has two-factor on: returns the ticket. */
  async function ticketFor(acct, password = PASSWORD) {
    const res = await acct.call('POST', '/auth/login', { username: acct.username, password });
    assert.equal(res.status, 200);
    assert.equal(res.data.twoFactorRequired, true);
    return res.data.ticket;
  }

  let owner;
  before(async () => {
    server = await startServer();
    owner = await account('tfowner'); // the first account: the instance owner
  });
  after(async () => { await server.stop(); });

  const FAILED = { error: 'That code did not work, or this sign-in has expired.', code: 'two-factor-failed' };

  describe('setting it up', () => {
    test('needs the password, returns the secret once, and is not on until a code confirms it', async () => {
      const acct = await account('setupann');
      assert.deepEqual((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data, { enabled: false, enabledAt: null, recoveryCodesRemaining: 0, setupPending: false });
      assert.equal(acct.login.user.twoFactorEnabled, false);

      assert.equal((await acct.call('POST', '/auth/2fa/setup', {})).status, 401, 'signed out');
      assert.equal((await acct.call('POST', '/auth/2fa/setup', {}, acct.token)).status, 400, 'no password');
      const wrong = await acct.call('POST', '/auth/2fa/setup', { password: 'Wrong123!pw' }, acct.token);
      assert.equal(wrong.status, 403, 'a wrong password is 403, so the client does not take it for an expired session');
      assert.equal(wrong.data.code, 'wrong-password');

      const started = await acct.call('POST', '/auth/2fa/setup', { password: PASSWORD }, acct.token);
      assert.equal(started.status, 200);
      assert.match(started.data.secret, /^[A-Z2-7]{32}$/);
      assert.equal(started.data.otpauthUri, `otpauth://totp/LAN%20Party:setupann?secret=${started.data.secret}&issuer=LAN%20Party&algorithm=SHA1&digits=6&period=30`);
      assert.equal(started.data.expiresIn, 900);
      assert.deepEqual(Object.keys(started.data).sort(), ['expiresIn', 'otpauthUri', 'secret']);

      // Pending: sign-in is still one step.
      assert.equal((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data.setupPending, true);
      const stillOneStep = await acct.call('POST', '/auth/login', { username: 'setupann', password: PASSWORD });
      assert.ok(stillOneStep.data.token, 'an unconfirmed setup changes nothing about signing in');

      const bad = await acct.call('POST', '/auth/2fa/confirm', { code: '000000' }, acct.token);
      assert.equal(bad.status, 400);
      assert.equal(bad.data.code, 'two-factor-failed');
      assert.equal((await acct.call('POST', '/auth/2fa/confirm', {}, acct.token)).status, 400);

      const key = totp.base32Decode(started.data.secret);
      const done = await acct.call('POST', '/auth/2fa/confirm', { code: totp.totp(key) }, acct.token);
      assert.equal(done.status, 200);
      assert.equal(done.data.recoveryCodes.length, 10);
      for (const code of done.data.recoveryCodes) assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);

      const status = (await acct.call('GET', '/auth/2fa', undefined, acct.token)).data;
      assert.equal(status.enabled, true);
      assert.equal(status.recoveryCodesRemaining, 10);
      assert.equal((await acct.call('GET', '/auth/me', undefined, acct.token)).data.user.twoFactorEnabled, true);

      // Already on: no second setup, and nothing to confirm.
      assert.equal((await acct.call('POST', '/auth/2fa/setup', { password: PASSWORD }, acct.token)).status, 409);
      const again = await acct.call('POST', '/auth/2fa/confirm', { code: totp.totp(key) }, acct.token);
      assert.equal(again.status, 400);
      assert.equal(again.data.code, 'two-factor-no-setup');
    });

    test('confirming with nothing started is refused', async () => {
      const acct = await account('setupnone');
      const res = await acct.call('POST', '/auth/2fa/confirm', { code: '123456' }, acct.token);
      assert.equal(res.status, 400);
      assert.equal(res.data.code, 'two-factor-no-setup');
    });

    test('the session that was already signed in keeps working after two-factor is turned on', async () => {
      const acct = await accountWith2fa('setupkeeps');
      assert.equal((await acct.call('GET', '/auth/me', undefined, acct.token)).status, 200);
      assert.equal((await acct.call('GET', '/servers', undefined, acct.token)).status, 200);
    });

    test('the secret is never returned again, and the database holds neither it nor a recovery code', async () => {
      const acct = await accountWith2fa('setupsecret');
      const raw = totp.base32Decode(acct.secret);
      const spellings = [acct.secret, raw.toString('hex'), raw.toString('base64'), raw.toString('base64url')];
      const leaks = (value) => { const text = JSON.stringify(value); return spellings.some((s) => text.includes(s)); };

      const ticket = await ticketFor(acct);
      const signedIn = await acct.call('POST', '/auth/login/2fa', { ticket, recoveryCode: acct.recoveryCodes[0] });
      assert.equal(signedIn.status, 200);
      const answers = [
        await acct.call('GET', '/auth/2fa', undefined, acct.token),
        await acct.call('GET', '/auth/me', undefined, acct.token),
        await acct.call('GET', '/user/settings', undefined, acct.token),
        await acct.call('GET', '/user/sync', undefined, acct.token),
        await acct.call('GET', `/users/${acct.username}/public`, undefined, acct.token),
        await acct.call('POST', '/auth/2fa/setup', { password: PASSWORD }, acct.token),
        signedIn,
      ];
      for (const a of answers) assert.equal(leaks(a.data), false);

      // Every row of every table that could hold it.
      const [me] = await dbAll(server.dataDir, 'SELECT id FROM users WHERE username = ?', [acct.username]);
      const row = (await dbAll(server.dataDir, 'SELECT * FROM user_two_factor WHERE user_id = ?', [me.id]))[0];
      assert.match(row.secret_enc, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/, 'stored encrypted');
      assert.equal(row.pending_enc, null);
      const users = await dbAll(server.dataDir, 'SELECT * FROM users WHERE id = ?', [me.id]);
      const tickets = await dbAll(server.dataDir, 'SELECT * FROM login_tickets');
      const codes = await dbAll(server.dataDir, 'SELECT * FROM two_factor_recovery_codes WHERE user_id = ?', [me.id]);
      assert.equal(leaks([row, users, tickets, codes]), false, 'no plain copy of the secret anywhere');

      assert.equal(codes.length, 10);
      const stored = JSON.stringify(codes);
      for (const code of acct.recoveryCodes) {
        assert.equal(stored.includes(code), false);
        assert.equal(stored.includes(code.replace(/-/g, '')), false);
      }
      for (const c of codes) assert.match(c.code_hash, /^[0-9a-f]{64}$/);
      assert.equal(codes.filter((c) => c.used_at !== null).length, 1, 'the one just used is marked, not readable');
    });
  });

  describe('signing in', () => {
    test('the password step returns a ticket and no session; the code step returns the usual sign-in', async () => {
      const acct = await accountWith2fa('loginann');
      const first = await acct.call('POST', '/auth/login', { username: 'loginann', password: PASSWORD, remember: true });
      assert.equal(first.status, 200);
      assert.deepEqual(Object.keys(first.data).sort(), ['expiresIn', 'ticket', 'twoFactorRequired']);
      assert.equal(first.data.twoFactorRequired, true);
      assert.equal(first.data.expiresIn, 300);

      // A wrong password is still just a wrong password: no ticket, no hint that two-factor is on.
      const wrongPw = await acct.call('POST', '/auth/login', { username: 'loginann', password: 'Wrong123!pw' });
      assert.equal(wrongPw.status, 401);
      assert.deepEqual(wrongPw.data, { error: 'Invalid credentials' });

      assert.equal((await acct.call('POST', '/auth/login/2fa', { ticket: first.data.ticket })).status, 400, 'no code');
      assert.equal((await acct.call('POST', '/auth/login/2fa', { code: '123456' })).status, 400, 'no ticket');

      const second = await acct.call('POST', '/auth/login/2fa', { ticket: first.data.ticket, code: acct.nextCode() });
      assert.equal(second.status, 200, JSON.stringify(second.data));
      assert.equal(second.data.success, true);
      assert.deepEqual(Object.keys(second.data.user).sort(), ['email', 'emailVerified', 'instanceOwner', 'settings', 'twoFactorEnabled', 'username']);
      assert.equal(second.data.user.username, 'loginann');
      assert.equal(second.data.user.twoFactorEnabled, true);
      const me = await acct.call('GET', '/auth/me', undefined, second.data.token);
      assert.equal(me.status, 200);
      assert.equal(me.data.user.username, 'loginann');
      // "Remember me" was asked for at the password step and carried through the ticket.
      const claims = JSON.parse(Buffer.from(second.data.token.split('.')[1], 'base64url').toString());
      assert.equal(claims.exp - claims.iat, 90 * 24 * 3600);
    });

    test('a ticket is single use, and the code that was used with it cannot be replayed on a new one', async () => {
      const acct = await accountWith2fa('loginreplay');
      const ticket = await ticketFor(acct);
      const code = acct.nextCode();
      assert.equal((await acct.call('POST', '/auth/login/2fa', { ticket, code })).status, 200);

      const reuse = await acct.call('POST', '/auth/login/2fa', { ticket, recoveryCode: acct.recoveryCodes[0] });
      assert.equal(reuse.status, 401, 'the spent ticket, with a perfectly good recovery code');
      assert.deepEqual(reuse.data, FAILED);
      assert.equal((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data.recoveryCodesRemaining, 10, 'which was not used up by it');

      const fresh = await ticketFor(acct);
      const replay = await acct.call('POST', '/auth/login/2fa', { ticket: fresh, code });
      assert.equal(replay.status, 401, 'the same six digits again, inside their window');
      assert.deepEqual(replay.data, FAILED);
    });

    test('a wrong code, a forged ticket and a used ticket all get the same answer', async () => {
      const acct = await accountWith2fa('loginsame');
      const ticket = await ticketFor(acct);
      const wrongCode = await acct.call('POST', '/auth/login/2fa', { ticket, code: '000000' });
      const garbage = await acct.call('POST', '/auth/login/2fa', { ticket: 'not-a-ticket', code: '000000' });
      const tampered = await acct.call('POST', '/auth/login/2fa', { ticket: `${ticket.slice(0, -4)}AAAA`, code: '000000' });
      const session = await acct.call('POST', '/auth/login/2fa', { ticket: acct.token, code: '000000' });
      for (const res of [wrongCode, garbage, tampered, session]) {
        assert.equal(res.status, 401);
        assert.deepEqual(res.data, FAILED);
      }
    });

    test('a recovery code signs in once and is then gone', async () => {
      const acct = await accountWith2fa('loginrecover');
      const [code] = acct.recoveryCodes;
      const first = await acct.call('POST', '/auth/login/2fa', { ticket: await ticketFor(acct), recoveryCode: code.toLowerCase() });
      assert.equal(first.status, 200);
      assert.ok(first.data.token);
      assert.equal(first.data.recoveryCodesRemaining, 9, 'the client is told how many are left');

      const second = await acct.call('POST', '/auth/login/2fa', { ticket: await ticketFor(acct), recoveryCode: code });
      assert.equal(second.status, 401);
      assert.deepEqual(second.data, FAILED);
      // Another account's code is no good either.
      const other = await accountWith2fa('loginrecover2');
      const crossed = await acct.call('POST', '/auth/login/2fa', { ticket: await ticketFor(acct), recoveryCode: other.recoveryCodes[0] });
      assert.equal(crossed.status, 401);
    });

    test('the ticket follows the account through a rename', async () => {
      const acct = await accountWith2fa('loginrename');
      const renamed = await acct.call('POST', '/user/username', { username: 'loginrenamed' }, acct.token);
      assert.equal(renamed.status, 200);
      const login = await acct.call('POST', '/auth/login', { username: 'loginrenamed', password: PASSWORD });
      assert.equal(login.data.twoFactorRequired, true, 'two-factor stayed on');
      const done = await acct.call('POST', '/auth/login/2fa', { ticket: login.data.ticket, recoveryCode: acct.recoveryCodes[0] });
      assert.equal(done.status, 200);
      assert.equal(done.data.user.username, 'loginrenamed');
    });
  });

  describe('a ticket is not a session', () => {
    let acct; let ticket;
    before(async () => {
      acct = await accountWith2fa('ticketann');
      ticket = await ticketFor(acct);
    });

    test('authMiddleware refuses it on every kind of route', async () => {
      const routes = [
        ['GET', '/auth/me'], ['GET', '/servers'], ['GET', '/user/sync'], ['GET', '/friends'], ['GET', '/auth/2fa'],
        ['POST', '/auth/2fa/disable'], ['POST', '/auth/2fa/recovery-codes'], ['POST', '/integrations/vault/sso-token'],
        ['POST', '/user/username'], ['POST', '/auth/logout'], ['POST', '/account/deactivate'], ['POST', '/auth/verify-email/resend'],
      ];
      for (const [method, route] of routes) {
        const res = await acct.call(method, route, method === 'POST' ? {} : undefined, ticket);
        assert.equal(res.status, 401, `${method} ${route}`);
        assert.deepEqual(res.data, { error: 'Invalid token' }, `${method} ${route}`);
      }
      // The one route that takes a session in the query string instead.
      const audio = await fetch(`${server.base}/music/audio/abcdefghijk?token=${encodeURIComponent(ticket)}`);
      assert.equal(audio.status, 401);
      // And the ticket is still good for what it IS for, so those refusals were not about expiry.
      assert.equal((await acct.call('POST', '/auth/login/2fa', { ticket, recoveryCode: acct.recoveryCodes[0] })).status, 200);
    });

    test('the socket handshake does not accept it: the connection is anonymous', async () => {
      const fresh = await ticketFor(acct);
      const outcome = (token) => new Promise((resolve, reject) => {
        const socket = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token } });
        const timer = setTimeout(() => { socket.close(); reject(new Error('no answer to join')); }, 5000);
        const finish = (what) => { clearTimeout(timer); socket.close(); resolve(what); };
        socket.on('server:denied', () => finish('denied'));
        socket.on('channel:joined', () => finish('joined'));
        socket.on('connect', () => socket.emit('join', { serverId: 'demo', name: 'ticketann' }));
      });
      assert.equal(await outcome(fresh), 'denied', 'a ticket');
      assert.equal(await outcome(acct.token), 'joined', 'the real session, for comparison');
    });

    test('a token that carries a purpose is not a session even when the server secret signed it', async () => {
      // Defence in depth: nothing signs such a token today, but if something ever does it must not
      // work as a login. (test-secret is the harness's JWT_SECRET.)
      const jwt = require('jsonwebtoken');
      const purposed = jwt.sign({ username: 'ticketann', purpose: '2fa' }, 'test-secret', { expiresIn: 300 });
      const nameless = jwt.sign({ uid: 1 }, 'test-secret', { expiresIn: 300 });
      for (const t of [purposed, nameless]) assert.equal((await acct.call('GET', '/auth/me', undefined, t)).status, 401);
    });
  });

  describe('limits', () => {
    test('five wrong codes kill the ticket and pause the account, right code or not', async () => {
      const acct = await accountWith2fa('lockann');
      const ticket = await ticketFor(acct);
      for (let i = 1; i <= 4; i++) {
        const res = await acct.call('POST', '/auth/login/2fa', { ticket, code: '000000' });
        assert.equal(res.status, 401, `wrong code ${i}`);
      }
      const fifth = await acct.call('POST', '/auth/login/2fa', { ticket, code: '000000' });
      assert.equal(fifth.status, 429);
      assert.equal(fifth.data.code, 'two-factor-locked');
      assert.equal(fifth.data.retryAfter, 300);
      assert.equal(fifth.headers.get('retry-after'), '300');

      const dead = await acct.call('POST', '/auth/login/2fa', { ticket, code: acct.nextCode() });
      assert.equal(dead.status, 401, 'the ticket is dead: same answer as any bad ticket');
      assert.deepEqual(dead.data, FAILED);

      // The password step still works, but its ticket is no use while the pause lasts.
      const fresh = await ticketFor(acct);
      const paused = await acct.call('POST', '/auth/login/2fa', { ticket: fresh, recoveryCode: acct.recoveryCodes[0] });
      assert.equal(paused.status, 429);
      assert.equal(paused.data.code, 'two-factor-locked');
      assert.ok(paused.data.retryAfter > 0 && paused.data.retryAfter <= 300);
      // From another address as well: the pause is on the account.
      const elsewhere = clientFrom(newAddress());
      const login = await elsewhere('POST', '/auth/login', { username: 'lockann', password: PASSWORD });
      assert.equal((await elsewhere('POST', '/auth/login/2fa', { ticket: login.data.ticket, recoveryCode: acct.recoveryCodes[0] })).status, 429);
      // And on the settings forms that take a code.
      assert.equal((await acct.call('POST', '/auth/2fa/disable', { password: PASSWORD, recoveryCode: acct.recoveryCodes[0] }, acct.token)).status, 429);
      assert.equal((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data.recoveryCodesRemaining, 10, 'nothing offered during the pause was used up');
    });

    test('wrong codes while confirming a setup are limited the same way', async () => {
      const acct = await account('lockconfirm');
      const started = await acct.call('POST', '/auth/2fa/setup', { password: PASSWORD }, acct.token);
      for (let i = 1; i <= 4; i++) assert.equal((await acct.call('POST', '/auth/2fa/confirm', { code: '000000' }, acct.token)).status, 400);
      const fifth = await acct.call('POST', '/auth/2fa/confirm', { code: '000000' }, acct.token);
      assert.equal(fifth.status, 429);
      const right = await acct.call('POST', '/auth/2fa/confirm', { code: totp.totp(totp.base32Decode(started.data.secret)) }, acct.token);
      assert.equal(right.status, 429, 'the right code has to wait too');
      assert.equal((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data.enabled, false);
    });

    test('the second step is rate limited per address', async () => {
      const call = clientFrom(newAddress());
      let res;
      for (let i = 1; i <= 20; i++) {
        res = await call('POST', '/auth/login/2fa', { ticket: 'nope', code: '000000' });
        assert.equal(res.status, 401, `attempt ${i}`);
      }
      res = await call('POST', '/auth/login/2fa', { ticket: 'nope', code: '000000' });
      assert.equal(res.status, 429);
      assert.match(res.data.error, /Too many sign-in attempts/);
      assert.equal(res.data.code, undefined, 'the limiter, not the lockout');
    });

    test('and per account, whatever address each attempt comes from', async () => {
      const acct = await accountWith2fa('limitacct');
      const ticket = await ticketFor(acct);
      // Requests without a code are refused before anything is counted against the account's
      // second factor, so this meets the limiter and not the five-wrong-codes pause.
      let res;
      for (let i = 1; i <= 20; i++) {
        res = await clientFrom(newAddress())('POST', '/auth/login/2fa', { ticket });
        assert.equal(res.status, 400, `attempt ${i}`);
      }
      res = await clientFrom(newAddress())('POST', '/auth/login/2fa', { ticket, recoveryCode: acct.recoveryCodes[0] });
      assert.equal(res.status, 429, 'the 21st for this account, from an address that has never called');
      assert.match(res.data.error, /Too many sign-in attempts/);
      // Another account is not affected.
      const other = await accountWith2fa('limitother');
      assert.equal((await clientFrom(newAddress())('POST', '/auth/login/2fa', { ticket: await ticketFor(other), recoveryCode: other.recoveryCodes[0] })).status, 200);
    });

    test('setup confirmation is rate limited per account and per address', async () => {
      const acct = await account('limitconfirm');
      // No setup pending, so each of these is refused without counting as a wrong code.
      let res;
      for (let i = 1; i <= 30; i++) {
        res = await clientFrom(newAddress())('POST', '/auth/2fa/confirm', { code: '000000' }, acct.token);
        assert.equal(res.status, 400, `attempt ${i}`);
      }
      res = await clientFrom(newAddress())('POST', '/auth/2fa/confirm', { code: '000000' }, acct.token);
      assert.equal(res.status, 429, 'per account');

      const oneAddress = clientFrom(newAddress());
      for (let i = 1; i <= 60; i++) res = await oneAddress('POST', '/auth/2fa/confirm', { code: '000000' });
      assert.equal(res.status, 401, 'the 60th is still let through to the session check');
      assert.equal((await oneAddress('POST', '/auth/2fa/confirm', { code: '000000' })).status, 429, 'per address, before a session is even looked at');
    });
  });

  describe('managing it', () => {
    test('turning it off needs the password AND a code', async () => {
      const acct = await accountWith2fa('manageoff');
      const off = (body) => acct.call('POST', '/auth/2fa/disable', body, acct.token);
      assert.equal((await off({})).status, 400);
      assert.equal((await off({ password: PASSWORD })).status, 400, 'the password alone');
      assert.equal((await off({ recoveryCode: acct.recoveryCodes[0] })).status, 400, 'a code alone');
      const wrongPw = await off({ password: 'Wrong123!pw', recoveryCode: acct.recoveryCodes[0] });
      assert.equal(wrongPw.status, 403);
      const wrongCode = await off({ password: PASSWORD, code: '000000' });
      assert.equal(wrongCode.status, 400);
      assert.equal(wrongCode.data.code, 'two-factor-failed');
      assert.equal((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data.enabled, true, 'still on after all of that');
      assert.equal((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data.recoveryCodesRemaining, 10, 'a wrong password did not burn the code');

      const done = await off({ password: PASSWORD, code: acct.nextCode() });
      assert.equal(done.status, 200);
      assert.deepEqual((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data, { enabled: false, enabledAt: null, recoveryCodesRemaining: 0, setupPending: false });
      const login = await acct.call('POST', '/auth/login', { username: 'manageoff', password: PASSWORD });
      assert.ok(login.data.token, 'one step again');
      const [me] = await dbAll(server.dataDir, 'SELECT id FROM users WHERE username = ?', ['manageoff']);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM user_two_factor WHERE user_id = ?', [me.id]), []);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM two_factor_recovery_codes WHERE user_id = ?', [me.id]), []);
      assert.equal((await off({ password: PASSWORD, code: '123456' })).status, 400, 'nothing to turn off');
    });

    test('a recovery code also turns it off, with the password', async () => {
      const acct = await accountWith2fa('manageoff2');
      const done = await acct.call('POST', '/auth/2fa/disable', { password: PASSWORD, recoveryCode: acct.recoveryCodes[3] }, acct.token);
      assert.equal(done.status, 200);
    });

    test('regenerating recovery codes needs a code from the app, and the old ones die', async () => {
      const acct = await accountWith2fa('manageregen');
      const regen = (body) => acct.call('POST', '/auth/2fa/recovery-codes', body, acct.token);
      assert.equal((await regen({})).status, 400);
      assert.equal((await regen({ recoveryCode: acct.recoveryCodes[0] })).status, 400, 'a recovery code cannot mint more recovery codes');
      assert.equal((await regen({ code: '000000' })).status, 400);
      const done = await regen({ code: acct.nextCode() });
      assert.equal(done.status, 200, JSON.stringify(done.data));
      assert.equal(done.data.recoveryCodes.length, 10);
      assert.equal(done.data.recoveryCodes.some((c) => acct.recoveryCodes.includes(c)), false);

      const old = await acct.call('POST', '/auth/login/2fa', { ticket: await ticketFor(acct), recoveryCode: acct.recoveryCodes[1] });
      assert.equal(old.status, 401);
      const fresh = await acct.call('POST', '/auth/login/2fa', { ticket: await ticketFor(acct), recoveryCode: done.data.recoveryCodes[0] });
      assert.equal(fresh.status, 200);

      const plain = await account('manageregen2');
      assert.equal((await plain.call('POST', '/auth/2fa/recovery-codes', { code: '123456' }, plain.token)).status, 400, 'not on: nothing to regenerate');
    });

    test('deleting the account removes its two-factor rows', async () => {
      const acct = await accountWith2fa('managegone');
      await ticketFor(acct); // a ticket left outstanding
      const [me] = await dbAll(server.dataDir, 'SELECT id FROM users WHERE username = ?', ['managegone']);
      assert.equal((await acct.call('POST', '/account/deactivate', {}, acct.token)).status, 200);
      const [pending] = await dbAll(server.dataDir, "SELECT token FROM auth_tokens WHERE purpose = 'deactivate' AND user_id = ?", [me.id]);
      assert.equal((await acct.call('POST', '/account/deactivate/confirm', { token: pending.token })).status, 200);
      for (const table of ['user_two_factor', 'two_factor_recovery_codes', 'login_tickets']) {
        assert.deepEqual(await dbAll(server.dataDir, `SELECT * FROM ${table} WHERE user_id = ?`, [me.id]), [], table);
      }
    });
  });

  describe('what does not get around it', () => {
    test('a password reset by email: the new password is still only the first step', async () => {
      const acct = await accountWith2fa('resetann');
      const email = 'resetann@example.com';
      assert.equal((await acct.call('POST', '/auth/forgot', { email })).status, 200);
      const [me] = await dbAll(server.dataDir, 'SELECT id FROM users WHERE username = ?', ['resetann']);
      const [row] = await dbAll(server.dataDir, "SELECT token FROM auth_tokens WHERE purpose = 'reset' AND user_id = ?", [me.id]);
      const NEW = 'Brand9!newpw';
      const reset = await acct.call('POST', '/auth/reset', { token: row.token, email, password: NEW, passwordConfirm: NEW });
      assert.equal(reset.status, 200);
      assert.deepEqual(reset.data, { success: true }, 'a reset signs nobody in');

      assert.equal((await acct.call('GET', '/auth/2fa', undefined, acct.token)).data.enabled, true, 'two-factor is still on');
      const login = await acct.call('POST', '/auth/login', { username: 'resetann', password: NEW });
      assert.equal(login.status, 200);
      assert.equal(login.data.twoFactorRequired, true);
      assert.equal(login.data.token, undefined);
      assert.equal((await acct.call('POST', '/auth/login/2fa', { ticket: login.data.ticket, code: '000000' })).status, 401);
      // The old recovery codes still work: the reset did not touch the second factor at all.
      assert.equal((await acct.call('POST', '/auth/login/2fa', { ticket: login.data.ticket, recoveryCode: acct.recoveryCodes[0] })).status, 200);
    });

    test('registering signs nobody in', async () => {
      const acct = await account('regnosession');
      assert.deepEqual(acct.registered, { success: true, verificationSent: false });
    });

    test('renaming re-issues a session only to someone who already has one', async () => {
      const acct = await accountWith2fa('renameann');
      const ticket = await ticketFor(acct);
      assert.equal((await acct.call('POST', '/user/username', { username: 'renamestolen' }, ticket)).status, 401);
      assert.equal((await acct.call('POST', '/user/username', { username: 'renamestolen' })).status, 401);
    });
  });

  describe('the instance owner can clear it for someone locked out', () => {
    test('only an owner, only when signed in, and it is written to the log', async () => {
      const lost = await accountWith2fa('lostann');
      const bystander = await account('bystander');
      const route = '/admin/users/lostann/2fa/clear';

      assert.equal((await bystander.call('POST', route, {})).status, 401, 'signed out');
      const refused = await bystander.call('POST', route, {}, bystander.token);
      assert.equal(refused.status, 403, 'an ordinary account');
      assert.equal((await lost.call('POST', route, {}, lost.token)).status, 403, 'not even for itself');
      assert.equal((await lost.call('POST', route, {}, await ticketFor(lost))).status, 401, 'a ticket is not a session here either');
      assert.equal((await lost.call('GET', '/auth/2fa', undefined, lost.token)).data.enabled, true);

      assert.equal((await owner.call('POST', '/admin/users/nobody-here/2fa/clear', {}, owner.token)).status, 404);
      const cleared = await owner.call('POST', route, {}, owner.token);
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.data, { success: true, wasEnabled: true });
      assert.match(server.log(), /\[2fa\] AUDIT: instance owner "tfowner" cleared two-factor for "lostann" \(was on\)/);

      const login = await lost.call('POST', '/auth/login', { username: 'lostann', password: PASSWORD });
      assert.ok(login.data.token, 'the password alone signs in again');
      assert.equal(login.data.user.twoFactorEnabled, false);
      const [me] = await dbAll(server.dataDir, 'SELECT id FROM users WHERE username = ?', ['lostann']);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM two_factor_recovery_codes WHERE user_id = ?', [me.id]), []);
      // And it can be set up again from scratch.
      assert.equal((await lost.call('POST', '/auth/2fa/setup', { password: PASSWORD }, login.data.token)).status, 200);
    });

    test('the owner route does not need the target to still have a pending ticket or the pause to be over', async () => {
      const acct = await accountWith2fa('lostlocked');
      const ticket = await ticketFor(acct);
      for (let i = 0; i < 5; i++) await acct.call('POST', '/auth/login/2fa', { ticket, code: '000000' });
      assert.equal((await owner.call('POST', '/admin/users/lostlocked/2fa/clear', {}, owner.token)).status, 200);
      assert.ok((await acct.call('POST', '/auth/login', { username: 'lostlocked', password: PASSWORD })).data.token);
    });
  });

  test('the server never logs a secret, a code or a ticket', async () => {
    // Everything above has run against this server by now.
    const log = server.log();
    assert.equal(/[A-Z2-7]{32}/.test(log), false, 'no base32 secret');
    assert.equal(/[A-Z2-7]{4}(-[A-Z2-7]{4}){3}/.test(log), false, 'no recovery code');
    assert.equal(/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(log), false, 'no ticket or session token');
  });
});
