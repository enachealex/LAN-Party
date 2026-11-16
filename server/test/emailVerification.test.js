// Email verification through the real server, in both of its modes:
//   - with a mailer (fixtures/fakeMailer.js stands in for SMTP and writes each message to a file):
//     a new account is unverified until it opens the emailed link, and until then is refused the
//     things a throwaway account could bother people with, over HTTP and over raw sockets;
//   - with no mailer (how every other suite runs): nobody is asked to verify anything.
// Nothing here sends an email or leaves the machine.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startServer, dbAll, PASSWORD } = require('./helpers');

const FAKE_MAILER = path.join(__dirname, 'fixtures', 'fakeMailer.js');
const REFUSAL = { error: 'Verify your email first. Open the link we emailed you, or resend it from Settings > Security.', code: 'email-unverified' };

let nextAddress = 0;
const newAddress = () => `198.51.100.${(nextAddress = (nextAddress % 250) + 1)}`;

/** An API client for one server that always calls from one address of its own. */
function clientFor(server, address = newAddress()) {
  return async function call(method, route, body, token) {
    /** @type {Record<string, string>} */
    const headers = { 'X-Forwarded-For': address };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(server.base + route, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch (_) { /* no body */ }
    return { status: res.status, data };
  };
}

async function account(server, username, email = `${username}@example.com`) {
  const call = clientFor(server);
  const reg = await call('POST', '/auth/register', { username, email, password: PASSWORD, passwordConfirm: PASSWORD });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  let login = await call('POST', '/auth/login', { username, password: PASSWORD });
  // An unverified account is refused a session (auth.js). The gates tested below exist for the
  // sessions that predate that rule, so the test makes one the way it came about: signed in while
  // the account counted as verified, then the flag back to 0.
  let refusedLogin = null;
  if (login.status === 403) {
    refusedLogin = login;
    await dbAll(server.dataDir, 'UPDATE users SET email_verified = 1 WHERE username = ?', [username]);
    login = await call('POST', '/auth/login', { username, password: PASSWORD });
    await dbAll(server.dataDir, 'UPDATE users SET email_verified = 0 WHERE username = ?', [username]);
  }
  assert.equal(login.status, 200, JSON.stringify(login.data));
  return { username, email, call, token: login.data.token, registered: reg.data, login: login.data, refusedLogin };
}

/** Every message the fake mailer was handed, oldest first. */
function outbox(server) {
  try {
    return fs.readFileSync(path.join(server.dataDir, 'mail-sent.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}
/** The verification links emailed to an address: the tokens, oldest first. Registration sends the mail without waiting for it, hence the wait. */
async function emailedTokens(server, email, atLeast = 1) {
  const read = () => outbox(server)
    .filter((m) => m.to === email && /Confirm your email/.test(m.subject))
    .map((m) => decodeURIComponent((m.html.match(/\/app\/\?verify=([^"&]+)/) || [])[1] || ''));
  const deadline = Date.now() + 5000;
  while (read().length < atLeast && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return read();
}
const verifiedFlag = async (server, username) => (await dbAll(server.dataDir, 'SELECT email_verified FROM users WHERE username = ?', [username]))[0].email_verified;
/** Mark an account verified the way the migration marked everyone who already existed. */
const grandfather = (server, username) => dbAll(server.dataDir, 'UPDATE users SET email_verified = 1 WHERE username = ?', [username]);

function once(socket, event, match = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = (payload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`timed out waiting for "${event}"`)); }, timeoutMs);
    socket.on(event, onEvent);
  });
}
/** Resolves true if the event arrives within the wait, false if it does not. */
const arrives = (socket, event, waitMs = 400) => once(socket, event, () => true, waitMs).then(() => true, () => false);
async function connect(server, token) {
  const socket = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
}
const pngUpload = () => {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'dot.png');
  return form;
};

describe('email verification: an instance that can send email', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */ let server;
  let veteran; // an account that counts as verified (as every account that predates the feature does)
  const sockets = [];
  const open = async (token) => { const s = await connect(server, token); sockets.push(s); return s; };

  before(async () => {
    server = await startServer({ env: { EMAIL_TRANSPORT: FAKE_MAILER } });
    veteran = await account(server, 'veteran');
    await grandfather(server, 'veteran');
  });
  after(async () => {
    for (const s of sockets) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('the server says at boot that verification is required', () => {
    assert.match(server.log(), /\[email\] new accounts must verify their email address/);
  });

  test('registering emails a link, signs nobody in, and refuses sign-in until the link is opened (a session from before that rule can still look around)', async () => {
    const newbie = await account(server, 'newbie');
    assert.deepEqual(newbie.registered, { success: true, verificationSent: true });
    assert.equal(await verifiedFlag(server, 'newbie'), 0);

    const [token] = await emailedTokens(server, newbie.email);
    assert.ok(token, 'a verification email went to the address they registered with');
    const rows = await dbAll(server.dataDir, "SELECT t.token, t.purpose, t.expires_at FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.username = 'newbie' AND t.purpose = 'verify-email'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token, token, 'the link carries the stored token');
    const hours = (rows[0].expires_at - Date.now()) / 3_600_000;
    assert.ok(hours > 23.9 && hours <= 24, `expires in 24 hours (${hours})`);
    const mail = outbox(server).find((m) => m.to === newbie.email && /Confirm your email/.test(m.subject));
    assert.match(mail.html, /href="[^"]+\/app\/\?verify=/, 'the link opens the app, like the reset and invite links');

    // The password is right but there is no session until the link is opened, and the answer
    // names the address the link went to.
    assert.equal(newbie.refusedLogin?.status, 403);
    assert.deepEqual(newbie.refusedLogin.data, { error: 'Confirm your email before signing in: open the link we emailed you.', code: 'email-unverified', email: newbie.email });
    // A session from before that rule (see account()) is told it is unverified...
    assert.equal(newbie.login.user.emailVerified, true, '(it was signed in while the flag was 1)');
    assert.equal((await newbie.call('GET', '/auth/me', undefined, newbie.token)).data.user.emailVerified, false);
    const sync = await newbie.call('GET', '/user/sync', undefined, newbie.token);
    assert.equal(sync.status, 200);
    assert.equal(sync.data.emailVerified, false);
    // Looking around works: servers, the commons' history, people, their own settings.
    assert.equal((await newbie.call('GET', '/servers', undefined, newbie.token)).status, 200);
    assert.equal((await newbie.call('GET', '/servers/demo/channels/general/messages', undefined, newbie.token)).status, 200);
    assert.equal((await newbie.call('GET', '/users/veteran/public', undefined, newbie.token)).status, 200);
    assert.equal((await newbie.call('GET', '/friends', undefined, newbie.token)).status, 200);
    assert.equal((await newbie.call('POST', '/user/settings', { settings: { onboardingComplete: true } }, newbie.token)).status, 200);
    assert.equal((await veteran.call('GET', '/auth/me', undefined, veteran.token)).data.user.emailVerified, true);
  });

  describe('what an unverified account is refused', () => {
    let rookie; let rookieServerId; let rookieSocket; let veteranSocket;
    before(async () => {
      rookie = await account(server, 'rookie');
      // Making a server of their own is allowed: nobody is in it but them.
      const made = await rookie.call('POST', '/servers', { name: 'Just me' }, rookie.token);
      assert.equal(made.status, 200, JSON.stringify(made.data));
      rookieServerId = made.data.server.id;
      rookieSocket = await open(rookie.token);
      veteranSocket = await open(veteran.token);
    });

    const refused = (res, what) => {
      assert.equal(res.status, 403, what);
      assert.deepEqual(res.data, REFUSAL, what);
    };

    test('HTTP: direct messages, group chats, friend requests', async () => {
      refused(await rookie.call('POST', '/messages/send', { toUsername: 'veteran', text: 'hello?' }, rookie.token), 'a direct message');
      refused(await rookie.call('POST', '/friends/request', { username: 'veteran' }, rookie.token), 'a friend request');
      refused(await rookie.call('POST', '/groups', { members: ['veteran', 'newbie'] }, rookie.token), 'starting a group');
      refused(await rookie.call('POST', '/groups/any-group/members', { usernames: ['veteran'] }, rookie.token), 'adding people to a group');
      refused(await rookie.call('POST', '/groups/any-group/messages', { text: 'hi all' }, rookie.token), 'posting in a group');
      assert.deepEqual(await dbAll(server.dataDir, "SELECT * FROM direct_messages WHERE body = 'hello?'"), []);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM friend_requests'), []);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM group_chats'), []);
    });

    test('HTTP: invite links and invitations, even in a server they own', async () => {
      refused(await rookie.call('POST', `/servers/${rookieServerId}/invites`, {}, rookie.token), 'an invite link');
      refused(await rookie.call('POST', `/servers/${rookieServerId}/invite`, { username: 'veteran' }, rookie.token), 'inviting someone by name');
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM server_invites'), []);
      assert.deepEqual(await dbAll(server.dataDir, "SELECT * FROM server_members WHERE username = 'veteran'"), []);
    });

    test('HTTP: uploads, and nothing is written to disk for a refused one', async () => {
      const uploads = path.join(server.dataDir, 'uploads');
      const before = fs.existsSync(uploads) ? fs.readdirSync(uploads).length : 0;
      refused(await rookie.call('POST', '/files/upload', pngUpload(), rookie.token), 'a file');
      refused(await rookie.call('POST', '/gifs', pngUpload(), rookie.token), 'a gif for the shared library');
      refused(await rookie.call('POST', '/sounds', pngUpload(), rookie.token), 'a soundboard clip');
      assert.equal(fs.existsSync(uploads) ? fs.readdirSync(uploads).length : 0, before);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM gifs'), []);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM sounds'), []);
    });

    test('HTTP: custom emoji and community apps, even in a server they own', async () => {
      refused(await rookie.call('POST', `/servers/${rookieServerId}/emojis`, { url: '/uploads/1700000000000-cat.png', name: 'cat' }, rookie.token), 'a custom emoji');
      refused(await rookie.call('POST', '/apps', { name: 'My app', url: 'https://example.com/' }, rookie.token), 'a link app');
      refused(await rookie.call('POST', '/apps/bundle', pngUpload(), rookie.token), 'an app bundle');
      refused(await rookie.call('PUT', '/apps/any-app/bundle', pngUpload(), rookie.token), 'replacing an app bundle');
      refused(await rookie.call('PATCH', '/apps/any-app', { url: 'https://example.com/elsewhere' }, rookie.token), "changing an app's address or details");
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM server_emojis'), []);
      assert.deepEqual(await dbAll(server.dataDir, "SELECT * FROM apps WHERE created_by = 'rookie'"), []);
    });

    test('socket: a message to the public commons is refused, with the text handed back', async () => {
      const joined = once(rookieSocket, 'channel:joined');
      rookieSocket.emit('join', { serverId: 'demo', name: 'rookie' });
      await joined; // reading the commons is fine
      const seenByOthers = arrives(veteranSocket, 'message');
      const error = once(rookieSocket, 'message:error');
      rookieSocket.emit('message', { serverId: 'demo', channelId: 'general', text: 'buy my stuff' });
      assert.deepEqual(await error, { serverId: 'demo', channelId: 'general', text: 'buy my stuff', reason: 'email-unverified', error: REFUSAL.error });
      assert.equal(await seenByOthers, false);
      assert.deepEqual(await dbAll(server.dataDir, "SELECT * FROM messages WHERE text = 'buy my stuff'"), []);
    });

    test('socket: a hand-written client that skips "join" is refused just the same', async () => {
      const raw = await open(rookie.token);
      const error = once(raw, 'message:error');
      raw.emit('message', { serverId: 'demo', channelId: 'general', text: 'straight in' });
      assert.equal((await error).reason, 'email-unverified');
      // Defaults: an empty payload means the commons' general channel.
      const error2 = once(raw, 'message:error');
      raw.emit('message', { text: 'by default' });
      assert.equal((await error2).reason, 'email-unverified');
      assert.deepEqual(await dbAll(server.dataDir, "SELECT * FROM messages WHERE text IN ('straight in', 'by default')"), []);
    });

    test('socket: the commons voice room is refused', async () => {
      const removed = once(rookieSocket, 'voice:removed');
      rookieSocket.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      assert.deepEqual(await removed, { serverId: 'demo', channelId: 'voice1', reason: 'email-unverified', error: REFUSAL.error });
    });

    test('socket: they can still post in a server of their own', async () => {
      const joined = once(rookieSocket, 'channel:joined', (c) => c && c.serverId === rookieServerId);
      rookieSocket.emit('join', { serverId: rookieServerId, name: 'rookie' });
      const { channelId } = await joined;
      const echoed = once(rookieSocket, 'message', (m) => m && m.text === 'note to self');
      rookieSocket.emit('message', { serverId: rookieServerId, channelId, text: 'note to self' });
      await echoed;
      assert.equal((await dbAll(server.dataDir, "SELECT * FROM messages WHERE text = 'note to self'")).length, 1);
    });

    test('socket: starting a call is refused and never rings', async () => {
      const rang = arrives(veteranSocket, 'call:incoming');
      const answer = once(rookieSocket, 'call:refused');
      rookieSocket.emit('call:invite', { to: 'veteran', video: false });
      assert.deepEqual(await answer, { to: 'veteran', reason: 'email-unverified', error: REFUSAL.error });
      assert.equal(await rang, false);
    });

    test('socket: accepting a call is refused and the caller is not connected', async () => {
      // A verified person calls them: it rings (they can see who wants them), but they cannot pick up.
      const incoming = once(rookieSocket, 'call:incoming');
      veteranSocket.emit('call:invite', { to: 'rookie', video: false });
      const ring = await incoming;
      const accepted = arrives(veteranSocket, 'call:accepted');
      const answer = once(rookieSocket, 'call:refused');
      rookieSocket.emit('call:accept', { to: ring.fromSocket });
      assert.equal((await answer).reason, 'email-unverified');
      assert.equal(await accepted, false);
    });

    test('a verified account is refused none of it', async () => {
      const pal = await account(server, 'pal');
      await grandfather(server, 'pal');
      assert.equal((await veteran.call('POST', '/friends/request', { username: 'pal' }, veteran.token)).status, 200);
      const made = await veteran.call('POST', '/servers', { name: 'Vets' }, veteran.token);
      assert.equal((await veteran.call('POST', `/servers/${made.data.server.id}/invites`, {}, veteran.token)).status, 200);
      assert.equal((await veteran.call('POST', `/servers/${made.data.server.id}/invite`, { username: 'pal' }, veteran.token)).status, 200);
      assert.equal((await veteran.call('POST', '/messages/send', { toUsername: 'pal', text: 'welcome' }, veteran.token)).status, 200);
      assert.equal((await veteran.call('POST', '/files/upload', pngUpload(), veteran.token)).status, 200);

      const joined = once(veteranSocket, 'channel:joined');
      veteranSocket.emit('join', { serverId: 'demo', name: 'veteran' });
      await joined;
      const echoed = once(veteranSocket, 'message', (m) => m && m.text === 'hello commons');
      veteranSocket.emit('message', { serverId: 'demo', channelId: 'general', text: 'hello commons' });
      await echoed;

      const palSocket = await open(pal.token);
      const ring = once(palSocket, 'call:incoming');
      veteranSocket.emit('call:invite', { to: 'pal', video: false });
      const accepted = once(veteranSocket, 'call:accepted');
      palSocket.emit('call:accept', { to: (await ring).fromSocket });
      await accepted;
    });

    test('opening the link lifts every restriction on the session and socket they already have', async () => {
      const [token] = await emailedTokens(server, rookie.email);
      const told = once(rookieSocket, 'account:email-verified');
      // Opened on some other device, signed out: no Authorization header at all.
      const res = await clientFor(server)('POST', '/auth/verify-email', { token });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { success: true }, 'verified, and nothing else: no session, no name');
      await told;
      assert.equal(await verifiedFlag(server, 'rookie'), 1);
      assert.equal((await rookie.call('GET', '/auth/me', undefined, rookie.token)).data.user.emailVerified, true);

      assert.equal((await rookie.call('POST', '/friends/request', { username: 'veteran' }, rookie.token)).status, 200);
      assert.equal((await rookie.call('POST', `/servers/${rookieServerId}/invites`, {}, rookie.token)).status, 200);
      assert.equal((await rookie.call('POST', '/files/upload', pngUpload(), rookie.token)).status, 200);
      const joined = once(rookieSocket, 'channel:joined');
      rookieSocket.emit('join', { serverId: 'demo', name: 'rookie' });
      await joined;
      const echoed = once(rookieSocket, 'message', (m) => m && m.text === 'made it');
      rookieSocket.emit('message', { serverId: 'demo', channelId: 'general', text: 'made it' });
      await echoed;
      const rang = once(veteranSocket, 'call:incoming');
      rookieSocket.emit('call:invite', { to: 'veteran', video: false });
      assert.equal((await rang).from, 'rookie');
    });
  });

  describe('the link', () => {
    test('works once', async () => {
      const acct = await account(server, 'linkonce');
      const [token] = await emailedTokens(server, acct.email);
      assert.equal((await acct.call('POST', '/auth/verify-email', { token })).status, 200);
      const again = await acct.call('POST', '/auth/verify-email', { token });
      assert.equal(again.status, 400);
      assert.match(again.data.error, /invalid or has expired/);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT * FROM auth_tokens WHERE token = ?', [token]), [], 'the token is gone');
    });

    test('expires, and an expired one verifies nobody', async () => {
      const acct = await account(server, 'linkexpired');
      const [token] = await emailedTokens(server, acct.email);
      await dbAll(server.dataDir, 'UPDATE auth_tokens SET expires_at = ? WHERE token = ?', [Date.now() - 1000, token]);
      const res = await acct.call('POST', '/auth/verify-email', { token });
      assert.equal(res.status, 400);
      assert.equal(await verifiedFlag(server, 'linkexpired'), 0);
      assert.deepEqual((await acct.call('POST', '/friends/request', { username: 'veteran' }, acct.token)).data, REFUSAL);
    });

    test('is refused when missing, made up, or a token meant for something else', async () => {
      const acct = await account(server, 'linkother');
      for (const token of [undefined, '', 'made-up', 12345, { $ne: '' }, 'x'.repeat(500)]) {
        assert.equal((await acct.call('POST', '/auth/verify-email', { token })).status, 400, JSON.stringify(token));
      }
      // A password-reset token does not verify an address...
      await acct.call('POST', '/auth/forgot', { email: acct.email });
      const [reset] = await dbAll(server.dataDir, "SELECT t.token FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.username = 'linkother' AND t.purpose = 'reset'");
      assert.equal((await acct.call('POST', '/auth/verify-email', { token: reset.token })).status, 400);
      assert.equal(await verifiedFlag(server, 'linkother'), 0);
      assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM auth_tokens WHERE token = ?', [reset.token]))[0].n, 1, 'and is not used up by the attempt');
      // ...and a verification token does not reset a password or delete an account.
      const [verify] = await emailedTokens(server, acct.email);
      assert.equal((await acct.call('POST', '/auth/reset', { token: verify, email: acct.email, password: 'Other9!newpw', passwordConfirm: 'Other9!newpw' })).status, 400);
      assert.equal((await acct.call('POST', '/account/deactivate/confirm', { token: verify })).status, 400);
      const login = await acct.call('POST', '/auth/login', { username: 'linkother', password: PASSWORD });
      assert.equal(login.status, 403, 'the password is unchanged (still right, still unverified)');
      assert.equal(login.data.code, 'email-unverified');
    });

    test('never signs anyone in: no token in the answer, and the answer is the same signed in or out', async () => {
      const acct = await account(server, 'linknosession');
      const [token] = await emailedTokens(server, acct.email);
      const res = await fetch(`${server.base}/auth/verify-email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('set-cookie'), null);
      const text = await res.text();
      assert.equal(text, JSON.stringify({ success: true }));
      assert.equal(/eyJ/.test(text), false);
    });

    test('the limit on guessing tokens: 30 tries per address', async () => {
      const call = clientFor(server);
      let res;
      for (let i = 0; i < 30; i++) res = await call('POST', '/auth/verify-email', { token: `guess-${i}` });
      assert.equal(res.status, 400);
      assert.equal((await call('POST', '/auth/verify-email', { token: 'guess-31' })).status, 429);
    });
  });

  describe('resending', () => {
    test('sends a new link and kills the old one', async () => {
      const acct = await account(server, 'resendann');
      const [first] = await emailedTokens(server, acct.email);
      const res = await acct.call('POST', '/auth/verify-email/resend', {}, acct.token);
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { success: true, sent: true });
      const tokens = await emailedTokens(server, acct.email, 2);
      assert.equal(tokens.length, 2);
      assert.notEqual(tokens[1], first);
      assert.equal((await acct.call('POST', '/auth/verify-email', { token: first })).status, 400, 'only the newest link works');
      assert.equal((await acct.call('POST', '/auth/verify-email', { token: tokens[1] })).status, 200);
    });

    test('needs a session', async () => {
      assert.equal((await clientFor(server)('POST', '/auth/verify-email/resend', {})).status, 401);
    });

    test('is limited to three an hour per account, from any address', async () => {
      const acct = await account(server, 'resendlimit');
      await emailedTokens(server, acct.email);
      for (let i = 1; i <= 3; i++) {
        assert.equal((await clientFor(server)('POST', '/auth/verify-email/resend', {}, acct.token)).status, 200, `resend ${i}`);
      }
      const fourth = await clientFor(server)('POST', '/auth/verify-email/resend', {}, acct.token);
      assert.equal(fourth.status, 429);
      assert.match(fourth.data.error, /Too many emails requested/);
      assert.equal((await emailedTokens(server, acct.email, 4)).length, 4, 'one from registering, three resends, and not a fifth');
    });

    test('and to ten an hour per address, whoever is asking', async () => {
      const call = clientFor(server);
      for (let i = 1; i <= 10; i++) assert.equal((await call('POST', '/auth/verify-email/resend', {})).status, 401);
      assert.equal((await call('POST', '/auth/verify-email/resend', {})).status, 429);
    });

    test('an account that is already verified is told so, and nothing is sent', async () => {
      const before = outbox(server).length;
      for (let i = 0; i < 5; i++) {
        const res = await veteran.call('POST', '/auth/verify-email/resend', {}, veteran.token);
        assert.equal(res.status, 200);
        assert.deepEqual(res.data, { success: true, alreadyVerified: true });
      }
      assert.equal(outbox(server).length, before, 'and it did not count against the three an hour either');
    });

    test('a mail server that refuses the message is reported, not hidden', async () => {
      const acct = await account(server, 'resendbounce', 'bounce@example.com');
      const res = await acct.call('POST', '/auth/verify-email/resend', {}, acct.token);
      assert.equal(res.status, 502);
      assert.equal(await verifiedFlag(server, 'resendbounce'), 0);
    });
  });

  describe('correcting a mistyped address', () => {
    const change = (acct, body, call = acct.call) => call('POST', '/auth/verify-email/change', body, acct.token);
    const storedEmail = async (username) => (await dbAll(server.dataDir, 'SELECT email FROM users WHERE username = ?', [username]))[0].email;

    test('moves the account to the new address, sends the link there, and kills every link sent to the old one', async () => {
      const acct = await account(server, 'typoann', 'typoan@example.com');
      const [oldLink] = await emailedTokens(server, acct.email);
      // A reset link mailed to the wrong address too, before the mistake was noticed.
      assert.equal((await acct.call('POST', '/auth/forgot', { email: acct.email })).status, 200);
      const resets = () => dbAll(server.dataDir, "SELECT t.token FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.username = 'typoann' AND t.purpose = 'reset'");
      assert.equal((await resets()).length, 1);
      const socket = await open(acct.token);
      const announced = once(socket, 'account:email-changed');

      const res = await change(acct, { email: ' typoann@example.com ', password: PASSWORD });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.deepEqual(res.data, { success: true, email: 'typoann@example.com', sent: true });
      assert.deepEqual(await announced, { email: 'typoann@example.com' }, 'their other windows are told');
      assert.equal(await storedEmail('typoann'), 'typoann@example.com');
      assert.equal((await acct.call('GET', '/auth/me', undefined, acct.token)).data.user.email, 'typoann@example.com');
      assert.equal((await resets()).length, 0, 'the reset link that went to the wrong address no longer works');

      const [newLink] = await emailedTokens(server, 'typoann@example.com');
      assert.ok(newLink, 'the link went to the corrected address');
      assert.equal((await acct.call('POST', '/auth/verify-email', { token: oldLink })).status, 400, 'the link sent to the old address is dead');
      assert.equal((await acct.call('POST', '/auth/verify-email', { token: newLink })).status, 200);
      assert.equal(await verifiedFlag(server, 'typoann'), 1);
    });

    test('needs the password, a real address, and one that is new and free; a refusal changes and sends nothing', async () => {
      const acct = await account(server, 'typobob', 'typobo@example.com');
      await emailedTokens(server, acct.email);
      const sentBefore = outbox(server).length;
      const wrong = await change(acct, { email: 'typobob@example.com', password: 'Not-the-password1!' });
      assert.equal(wrong.status, 403, 'a wrong password is 403, so the client does not treat it as a dead session');
      assert.equal(wrong.data.code, 'wrong-password');
      assert.equal((await change(acct, { email: 'typobob@example.com' })).status, 400);
      assert.equal((await change(acct, { email: 'not-an-address', password: PASSWORD })).status, 400);
      assert.equal((await change(acct, { email: 'typobo@example.com', password: PASSWORD })).status, 400, 'the same address: that is what Resend is for');
      const taken = await change(acct, { email: veteran.email, password: PASSWORD });
      assert.equal(taken.status, 409);
      assert.equal(taken.data.field, 'email');
      assert.equal(await storedEmail('typobob'), 'typobo@example.com');
      assert.equal(outbox(server).length, sentBefore);
      assert.equal((await clientFor(server)('POST', '/auth/verify-email/change', { email: 'x@example.com', password: PASSWORD })).status, 401, 'and a session');
    });

    test('a verified address is not changed here', async () => {
      const res = await change(veteran, { email: 'elsewhere@example.com', password: PASSWORD });
      assert.equal(res.status, 409);
      assert.equal(res.data.alreadyVerified, true);
      assert.equal(await storedEmail('veteran'), veteran.email);
    });

    test('is limited to five tries an hour per account, from any address', async () => {
      const acct = await account(server, 'typolimit');
      for (let i = 1; i <= 5; i++) {
        assert.equal((await change(acct, { email: `typolimit${i}@example.com`, password: PASSWORD }, clientFor(server))).status, 200, `change ${i}`);
      }
      const sixth = await change(acct, { email: 'typolimit6@example.com', password: PASSWORD }, clientFor(server));
      assert.equal(sixth.status, 429);
      assert.equal(await storedEmail('typolimit'), 'typolimit5@example.com');
    });

    test('a new address the mail server refuses is still saved, and the answer says nothing was sent', async () => {
      const acct = await account(server, 'typobounce');
      const res = await change(acct, { email: 'bounce-typobounce@example.com', password: PASSWORD });
      assert.equal(res.status, 200);
      assert.deepEqual(res.data, { success: true, email: 'bounce-typobounce@example.com', sent: false });
      assert.equal(await storedEmail('typobounce'), 'bounce-typobounce@example.com');
    });
  });

  describe('signing in before verifying', () => {
    const register = async (username, email = `${username}@example.com`) => {
      const call = clientFor(server);
      assert.equal((await call('POST', '/auth/register', { username, email, password: PASSWORD, passwordConfirm: PASSWORD })).status, 200);
      return call;
    };

    test('is refused with the address on file; a wrong password says only that, and leaks neither', async () => {
      const call = await register('gateann');
      const refused = await call('POST', '/auth/login', { username: 'gateann', password: PASSWORD });
      assert.equal(refused.status, 403);
      assert.equal(refused.data.code, 'email-unverified');
      assert.equal(refused.data.email, 'gateann@example.com');
      assert.equal(refused.data.token, undefined);
      const wrong = await call('POST', '/auth/login', { username: 'gateann', password: 'Not-the-password1!' });
      assert.deepEqual([wrong.status, wrong.data], [401, { error: 'Invalid credentials' }]);
    });

    test('the sign-in form can resend the link with the username and password, and opening it lets them in', async () => {
      const call = await register('gatebob');
      await emailedTokens(server, 'gatebob@example.com');
      assert.equal((await call('POST', '/auth/verify-email/resend', { username: 'gatebob', password: 'Not-the-password1!' })).status, 401);
      const resent = await call('POST', '/auth/verify-email/resend', { username: 'gatebob', password: PASSWORD });
      assert.deepEqual([resent.status, resent.data], [200, { success: true, sent: true }]);
      const tokens = await emailedTokens(server, 'gatebob@example.com', 2);
      assert.equal((await call('POST', '/auth/verify-email', { token: tokens[1] })).status, 200);
      const login = await call('POST', '/auth/login', { username: 'gatebob', password: PASSWORD });
      assert.equal(login.status, 200);
      assert.equal(login.data.user.emailVerified, true);
    });

    test('the sign-in form can correct a mistyped address, and the link sent there lets them in', async () => {
      const call = await register('gatecat', 'gatcat@example.com');
      const fixed = await call('POST', '/auth/verify-email/change', { username: 'gatecat', password: PASSWORD, email: 'gatecat@example.com' });
      assert.deepEqual([fixed.status, fixed.data], [200, { success: true, email: 'gatecat@example.com', sent: true }]);
      const again = await call('POST', '/auth/login', { username: 'gatecat', password: PASSWORD });
      assert.deepEqual([again.status, again.data.email], [403, 'gatecat@example.com'], 'still not in, but the new address is what they see');
      const [token] = await emailedTokens(server, 'gatecat@example.com');
      assert.equal((await call('POST', '/auth/verify-email', { token })).status, 200);
      assert.equal((await call('POST', '/auth/login', { username: 'gatecat', password: PASSWORD })).status, 200);
    });

    test('resetting the password from the emailed link proves the address too', async () => {
      const call = await register('gatedan');
      assert.equal((await call('POST', '/auth/forgot', { email: 'gatedan@example.com' })).status, 200);
      const [reset] = await dbAll(server.dataDir, "SELECT t.token FROM auth_tokens t JOIN users u ON u.id = t.user_id WHERE u.username = 'gatedan' AND t.purpose = 'reset'");
      assert.equal((await call('POST', '/auth/reset', { token: reset.token, email: 'gatedan@example.com', password: 'Fresh9!password', passwordConfirm: 'Fresh9!password' })).status, 200);
      assert.equal(await verifiedFlag(server, 'gatedan'), 1);
      assert.equal((await call('POST', '/auth/login', { username: 'gatedan', password: 'Fresh9!password' })).status, 200);
    });
  });

  test('two-factor and verification are independent: an unverified account can protect itself', async () => {
    const acct = await account(server, 'bothann');
    const totp = require('../services/totp');
    const started = await acct.call('POST', '/auth/2fa/setup', { password: PASSWORD }, acct.token);
    assert.equal(started.status, 200);
    const done = await acct.call('POST', '/auth/2fa/confirm', { code: totp.totp(totp.base32Decode(started.data.secret)) }, acct.token);
    assert.equal(done.status, 200);
    // Two-factor is not a way round verification: no ticket for the second step until it is done...
    const early = await acct.call('POST', '/auth/login', { username: 'bothann', password: PASSWORD });
    assert.equal(early.status, 403);
    assert.equal(early.data.code, 'email-unverified');
    assert.equal(early.data.ticket, undefined);
    // ...and verifying the address is not a way in either: signing in still takes both steps.
    const [token] = await emailedTokens(server, acct.email);
    assert.deepEqual((await acct.call('POST', '/auth/verify-email', { token })).data, { success: true });
    const login = await acct.call('POST', '/auth/login', { username: 'bothann', password: PASSWORD });
    assert.equal(login.data.twoFactorRequired, true);
    assert.equal(login.data.token, undefined);
  });

  test('no token appears in the server log', () => {
    const log = server.log();
    for (const m of outbox(server)) {
      const token = decodeURIComponent((m.html.match(/\/app\/\?verify=([^"&]+)/) || [])[1] || '');
      if (token) assert.equal(log.includes(token), false);
    }
  });
});

describe('email verification: an instance with no mailer', () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */ let server;
  before(async () => { server = await startServer(); }); // the harness default: EMAIL_TRANSPORT=off
  after(async () => { await server.stop(); });

  test('the server says at boot that verification is not required', () => {
    assert.match(server.log(), /\[email\] no mailer configured: email verification is not required/);
  });

  test('a new account is verified from the start and nothing is restricted', async () => {
    const ann = await account(server, 'freeann');
    const ben = await account(server, 'freeben');
    assert.deepEqual(ann.registered, { success: true, verificationSent: false });
    assert.equal(await verifiedFlag(server, 'freeann'), 1, 'stored as verified, so setting SMTP up later does not lock them out');
    assert.equal(ann.login.user.emailVerified, true);
    assert.equal((await ann.call('GET', '/user/sync', undefined, ann.token)).data.emailVerified, true);
    assert.deepEqual(await dbAll(server.dataDir, "SELECT * FROM auth_tokens WHERE purpose = 'verify-email'"), [], 'no token is minted for a link nobody can be sent');

    assert.equal((await ann.call('POST', '/friends/request', { username: 'freeben' }, ann.token)).status, 200);
    assert.equal((await ann.call('POST', '/files/upload', pngUpload(), ann.token)).status, 200);
    const made = await ann.call('POST', '/servers', { name: 'Free' }, ann.token);
    assert.equal((await ann.call('POST', `/servers/${made.data.server.id}/invites`, {}, ann.token)).status, 200);

    const socket = await connect(server, ann.token);
    try {
      const joined = once(socket, 'channel:joined');
      socket.emit('join', { serverId: 'demo', name: 'freeann' });
      await joined;
      const echoed = once(socket, 'message', (m) => m && m.text === 'no mailer here');
      socket.emit('message', { serverId: 'demo', channelId: 'general', text: 'no mailer here' });
      await echoed;
      void ben;
    } finally {
      socket.close();
    }
  });

  test('resend has nothing to do and says so', async () => {
    const acct = await account(server, 'freeresend');
    const res = await acct.call('POST', '/auth/verify-email/resend', {}, acct.token);
    assert.deepEqual(res.data, { success: true, alreadyVerified: true });
  });
});

describe('email verification: the mailer being added or removed later', () => {
  test('an account left unverified is not locked out when the mailer goes away, and is asked again when it comes back', async () => {
    let server = await startServer({ env: { EMAIL_TRANSPORT: FAKE_MAILER } });
    let dataDir;
    try {
      const acct = await account(server, 'flipann');
      const peer = await account(server, 'flippeer');
      await grandfather(server, 'flippeer');
      assert.deepEqual((await acct.call('POST', '/friends/request', { username: 'flippeer' }, acct.token)).data, REFUSAL);
      dataDir = server.dataDir;
      await server.stop({ keepData: true });

      // SMTP removed (or broken config): nobody can be sent a link, so nobody is asked for one.
      server = await startServer({ dataDir });
      const off = clientFor(server);
      assert.equal(await verifiedFlag(server, 'flipann'), 0, 'the stored flag is untouched');
      assert.equal((await off('GET', '/auth/me', undefined, acct.token)).data.user.emailVerified, true, 'but the account counts as verified');
      assert.equal((await off('POST', '/friends/request', { username: 'flippeer' }, acct.token)).status, 200);
      // An account that registers now is stored as verified.
      const during = await account(server, 'flipduring');
      assert.equal(await verifiedFlag(server, 'flipduring'), 1);
      await server.stop({ keepData: true });

      // The mailer is back: the one who never verified is asked again; the one admitted meanwhile is not.
      server = await startServer({ dataDir, env: { EMAIL_TRANSPORT: FAKE_MAILER } });
      const on = clientFor(server);
      assert.equal((await on('GET', '/auth/me', undefined, acct.token)).data.user.emailVerified, false);
      assert.deepEqual((await on('POST', '/messages/send', { toUsername: 'flippeer', text: 'hi' }, acct.token)).data, REFUSAL);
      assert.equal((await on('GET', '/auth/me', undefined, during.token)).data.user.emailVerified, true);
      void peer;
    } finally {
      await server.stop();
    }
  });

  test('a stand-in mailer that cannot be loaded leaves email off rather than falling back to real SMTP', async () => {
    const server = await startServer({ env: { EMAIL_TRANSPORT: path.join(__dirname, 'fixtures', 'no-such-mailer.js'), SMTP_HOST: 'smtp.invalid', SMTP_USER: 'someone', SMTP_PASS: 'not-a-real-password' } });
    try {
      assert.match(server.log(), /\[email\] no mailer configured: email verification is not required/);
      assert.match(server.log(), /EMAIL_TRANSPORT could not be loaded: email is off/);
      const acct = await account(server, 'seamann');
      assert.equal(acct.login.user.emailVerified, true);
    } finally {
      await server.stop();
    }
  });
});
