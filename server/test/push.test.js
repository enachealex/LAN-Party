// Web Push: who gets a notification when their app is closed, and — just as important — who does not.
//
// The HTTP/socket suites boot the real server with the web-push library swapped for
// test/fixtures/fakeWebPush.js (via WEB_PUSH_MODULE), so the real routes, triggers and database run
// and nothing is ever sent to a push service. The fake writes every send to a file in the server's
// DATA_DIR, which is how these tests see exactly which browsers were pushed.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');
const { migrate } = require('../db/schema');
const {
  createPush, previewOf, mentionedUsernames, vapidSubjectFor, isVapidPair, generateVapidKeys,
  MAX_SUBSCRIPTIONS_PER_USER, BODY_MAX, MENTION_PUSHES_PER_WINDOW,
} = require('../services/push');

const FAKE_WEB_PUSH = path.join(__dirname, 'fixtures', 'fakeWebPush.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What a browser hands over: PushSubscription.toJSON(). The keys are the right SIZE (a 65-byte
// uncompressed P-256 point, a 16-byte secret) but random, which is all the server may assume.
// `where` picks the fake push service's answer (see the fixture) and names the browser.
const subscription = (where) => ({
  endpoint: `https://push.example.com/${where}`,
  expirationTime: null,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  },
});

// Everything the fake sender has been asked to send so far, oldest first.
function sentBy(server) {
  const file = path.join(server.dataDir, 'push-sent.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

function once(socket, event, match = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = (payload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.on(event, onEvent);
  });
}

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

// The client's focus report, acknowledged so the test knows the server has it before sending.
const focus = (socket, state) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('presence:focus was never acknowledged')), 5000);
  socket.emit('presence:focus', state, (answer) => { clearTimeout(timer); resolve(answer); });
});

// The last path segment of an endpoint is the browser's name in these tests.
const browsers = (pushes) => pushes.map((p) => p.endpoint.split('/').pop()).sort();

describe('push subscriptions', () => {
  let server, call, tok;

  before(async () => {
    server = await startServer({ env: { WEB_PUSH_MODULE: FAKE_WEB_PUSH, PUSH_EXTRA_HOSTS: 'push.example.com' } });
    call = apiFor(server.base);
    tok = {};
    for (const name of ['sam', 'tess', 'uma']) tok[name] = await makeUser(call, name);
  });
  after(async () => { await server.stop(); });

  const rowsFor = (username) => dbAll(server.dataDir, 'SELECT * FROM push_subscriptions WHERE username = ? ORDER BY created_at, endpoint', [username]);

  test('every endpoint needs a login', async () => {
    assert.equal((await call('GET', '/push/public-key')).status, 401);
    assert.equal((await call('POST', '/push/subscribe', subscription('ok/anon'))).status, 401);
    assert.equal((await call('POST', '/push/unsubscribe', { endpoint: subscription('ok/anon').endpoint })).status, 401);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM push_subscriptions'))[0].n, 0);
  });

  test('the public key is generated once, kept in DATA_DIR/vapid.json, and the private half stays private', async () => {
    const first = await call('GET', '/push/public-key', undefined, tok.sam);
    assert.equal(first.status, 200);
    assert.equal(first.data.available, true);
    // What a browser needs for applicationServerKey: a 65-byte uncompressed P-256 point.
    assert.equal(Buffer.from(first.data.publicKey, 'base64url').length, 65);
    assert.equal((await call('GET', '/push/public-key', undefined, tok.tess)).data.publicKey, first.data.publicKey, 'one key for everyone');

    const file = path.join(server.dataDir, 'vapid.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(stored.publicKey, first.data.publicKey);
    assert.ok(isVapidPair(stored.publicKey, stored.privateKey), 'the two halves belong together');
    // Windows has no owner-only mode bits to check.
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!server.log().includes(stored.privateKey), 'the private key is never logged');
    assert.ok(!JSON.stringify(first.data).includes(stored.privateKey));
  });

  test('a subscription is stored for the caller, and sending it again changes nothing', async () => {
    const sub = subscription('ok/sam-phone');
    const res = await call('POST', '/push/subscribe', sub, tok.sam);
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    const [row, ...rest] = await rowsFor('sam');
    assert.equal(rest.length, 0);
    assert.equal(row.endpoint, sub.endpoint);
    assert.equal(row.p256dh, sub.keys.p256dh);
    assert.equal(row.auth, sub.keys.auth);
    assert.ok(row.created_at > 0);
    assert.equal(row.last_success_at, null, 'nothing has been delivered yet');
    assert.ok(typeof row.user_agent === 'string');

    // The client re-sends on every login.
    assert.equal((await call('POST', '/push/subscribe', sub, tok.sam)).status, 200);
    const again = await rowsFor('sam');
    assert.equal(again.length, 1);
    assert.equal(again[0].created_at, row.created_at, 'still the same subscription, not a new one');
  });

  test('anything that is not a real push subscription is refused', async () => {
    const good = subscription('ok/tess-phone');
    const withEndpoint = (endpoint) => ({ ...good, endpoint });
    const endpointError = /https endpoint of a push service/;
    const bad = [
      ['plain http', withEndpoint('http://push.example.com/ok/x'), endpointError],
      ['not a url', withEndpoint('push.example.com/ok/x'), endpointError],
      ['missing', { keys: good.keys }, endpointError],
      ['not a string', withEndpoint(42), endpointError],
      // The server will POST to this url later, so it must not be able to point inside the network.
      ['an ip address', withEndpoint('https://192.168.0.10/ok/x'), endpointError],
      ['an ipv6 address', withEndpoint('https://[::1]/ok/x'), endpointError],
      ['localhost', withEndpoint('https://localhost/ok/x'), endpointError],
      ['a LAN name', withEndpoint('https://nas.local/ok/x'), endpointError],
      // Looking public is not enough: a public-looking name can resolve to a LAN or tailnet address,
      // and any https host could be made a target the server POSTs to. Only real push services pass.
      ['a tailnet name', withEndpoint('https://box.sometailnet.ts.net/admin/x'), endpointError],
      ['an arbitrary public host', withEndpoint('https://victim.example.org/hook'), endpointError],
      ['a lookalike of a push service', withEndpoint('https://fcm.googleapis.com.evil.example/x'), endpointError],
      ['another port', withEndpoint('https://push.example.com:8443/ok/x'), endpointError],
      ['credentials in the url', withEndpoint('https://user:pw@push.example.com/ok/x'), endpointError],
      ['far too long', withEndpoint(`https://push.example.com/${'x'.repeat(3000)}`), endpointError],
      ['no keys', { endpoint: good.endpoint }, /p256dh and auth keys/],
      ['no auth key', { endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh } }, /p256dh and auth keys/],
      ['an empty key', { endpoint: good.endpoint, keys: { ...good.keys, auth: '' } }, /p256dh and auth keys/],
      ['a key of the wrong size', { endpoint: good.endpoint, keys: { ...good.keys, p256dh: 'c2hvcnQ' } }, /p256dh and auth keys/],
      ['a key that is not base64url', { endpoint: good.endpoint, keys: { ...good.keys, auth: '!!!!not base64!!!!' } }, /p256dh and auth keys/],
    ];
    for (const [label, body, error] of bad) {
      const res = await call('POST', '/push/subscribe', body, tok.tess);
      assert.equal(res.status, 400, label);
      assert.match(res.data.error, error, label);
    }
    assert.equal((await rowsFor('tess')).length, 0, 'none of them left a row behind');
    assert.equal((await call('POST', '/push/unsubscribe', {}, tok.tess)).status, 400);
    assert.equal((await call('POST', '/push/unsubscribe', { endpoint: 'http://push.example.com/x' }, tok.tess)).status, 400);
  });

  test('a browser that signs in as someone else moves to them', async () => {
    // One device, two people: the endpoint identifies the browser, so it can only belong to whoever
    // is using it now. Otherwise the second person would keep getting the first one's notifications.
    const shared = subscription('ok/shared-tablet');
    assert.equal((await call('POST', '/push/subscribe', shared, tok.tess)).status, 200);
    assert.deepEqual((await rowsFor('tess')).map((r) => r.endpoint), [shared.endpoint]);

    assert.equal((await call('POST', '/push/subscribe', shared, tok.uma)).status, 200);
    assert.equal((await rowsFor('tess')).length, 0, 'tess no longer has it');
    assert.deepEqual((await rowsFor('uma')).map((r) => r.endpoint), [shared.endpoint]);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?', [shared.endpoint]))[0].n, 1);
  });

  test('unsubscribing removes your own subscription and nobody else\'s', async () => {
    const mine = subscription('ok/tess-laptop');
    await call('POST', '/push/subscribe', mine, tok.tess);
    const [umas] = await rowsFor('uma');

    // Knowing someone's endpoint is not enough to remove it.
    const notMine = await call('POST', '/push/unsubscribe', { endpoint: umas.endpoint }, tok.tess);
    assert.equal(notMine.status, 200);
    assert.equal(notMine.data.removed, 0);
    assert.equal((await rowsFor('uma')).length, 1);

    const res = await call('POST', '/push/unsubscribe', { endpoint: mine.endpoint }, tok.tess);
    assert.equal(res.status, 200);
    assert.equal(res.data.removed, 1);
    assert.equal((await rowsFor('tess')).length, 0);

    // Sign-out may race a toggle; asking twice must not be an error.
    const twice = await call('POST', '/push/unsubscribe', { endpoint: mine.endpoint }, tok.tess);
    assert.equal(twice.status, 200);
    assert.equal(twice.data.removed, 0);
  });

  test(`one person keeps at most ${MAX_SUBSCRIPTIONS_PER_USER} browsers, and it is the stalest that go`, async () => {
    const before = (await rowsFor('sam')).map((r) => r.endpoint); // sam-phone, from above
    assert.equal(before.length, 1);
    const added = [];
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER + 2; i += 1) {
      const sub = subscription(`ok/sam-extra-${String(i).padStart(2, '0')}`);
      assert.equal((await call('POST', '/push/subscribe', sub, tok.sam)).status, 200, 'the newest is never refused');
      added.push(sub.endpoint);
      await sleep(3); // distinct created_at, so "oldest" is unambiguous
    }
    const kept = (await rowsFor('sam')).map((r) => r.endpoint);
    assert.equal(kept.length, MAX_SUBSCRIPTIONS_PER_USER);
    assert.deepEqual(kept, added.slice(-MAX_SUBSCRIPTIONS_PER_USER), 'the most recent ones survive');
    assert.ok(!kept.includes(before[0]), 'the oldest was dropped to make room');
    assert.equal((await rowsFor('uma')).length, 1, 'somebody else\'s browsers are never touched by it');
  });

  test('renaming an account takes its subscriptions along', async () => {
    const renamed = await call('POST', '/user/username', { username: 'uma2' }, tok.uma);
    assert.equal(renamed.status, 200);
    assert.equal((await rowsFor('uma')).length, 0);
    assert.equal((await rowsFor('uma2')).length, 1, 'notifications keep arriving under the new name');
  });
});

describe('who gets pushed', () => {
  let server, call, tok, ids, serverId, generalId, aliceSock;
  let aliceAt = { serverId: null, channelId: null }; // where alice's socket currently is
  const sockets = [];
  let flushCount = 0;

  const sent = () => sentBy(server);

  // Has everything the server was going to push been pushed? Sends are fire-and-forget, so "nobody
  // else was notified" cannot be observed directly. Instead a throwaway DM goes to a canary user
  // afterwards and we wait for THAT push: work queued before it has been through the same pipeline
  // by then. Returns what was pushed in between, canary excluded.
  async function pushedBy(action) {
    const mark = sent().length;
    const result = await action();
    const nonce = `flush ${++flushCount} ${crypto.randomBytes(4).toString('hex')}`;
    const res = await call('POST', '/messages/send', { toUsername: 'canary', text: nonce }, tok.flush);
    assert.equal(res.status, 200);
    await waitFor(() => sent().some((p) => p.payload.body === nonce), 'the canary push');
    await sleep(40);
    return { result, pushes: sent().slice(mark).filter((p) => !p.endpoint.endsWith('/canary')) };
  }

  const dm = (from, to, text, extra = {}) => call('POST', '/messages/send', { toUsername: to, text, ...extra }, tok[from]);

  // Put alice's socket in a channel, the way the client does: 'join' picks the server (and lands in
  // its first text channel), 'joinChannel' moves within it. Returns the channel she ends up in.
  async function enter(targetServer, targetChannel) {
    if (aliceAt.serverId !== targetServer) {
      const joined = once(aliceSock, 'channel:joined', (p) => p.serverId === targetServer);
      aliceSock.emit('join', { serverId: targetServer, name: 'alice' });
      aliceAt = { serverId: targetServer, channelId: (await joined).channelId };
    }
    if (targetChannel && aliceAt.channelId !== targetChannel) {
      const joined = once(aliceSock, 'channel:joined', (p) => p.channelId === targetChannel);
      aliceSock.emit('joinChannel', { serverId: targetServer, channelId: targetChannel });
      await joined;
      aliceAt.channelId = targetChannel;
    }
    return aliceAt.channelId;
  }

  // A channel message goes over the socket; the echo back to the sender means it was stored + emitted.
  async function say(channelId, text, inServer = serverId) {
    await enter(inServer, channelId);
    const echoed = once(aliceSock, 'message', (m) => m.text === text && m.channelId === channelId);
    aliceSock.emit('message', { serverId: inServer, channelId, text });
    return echoed;
  }

  before(async () => {
    // CLIENT_ORIGIN is what the VAPID subject is derived from when none is configured.
    server = await startServer({ env: { WEB_PUSH_MODULE: FAKE_WEB_PUSH, PUSH_EXTRA_HOSTS: 'push.example.com', CLIENT_ORIGIN: 'https://party.example.org' } });
    call = apiFor(server.base);
    tok = {};
    for (const name of ['alice', 'bob', 'carol', 'dave', 'flush', 'canary']) tok[name] = await makeUser(call, name);
    ids = Object.fromEntries((await dbAll(server.dataDir, 'SELECT id, username FROM users')).map((r) => [r.username, r.id]));

    // alice, bob and carol share a server (so they may DM and form a group). dave is an outsider.
    serverId = (await call('POST', '/servers', { name: 'Push Test' }, tok.alice)).data.server.id;
    for (const username of ['bob', 'carol']) await call('POST', `/servers/${serverId}/invite`, { username }, tok.alice);
    // The canary pair only needs to be able to DM each other.
    const flushServer = (await call('POST', '/servers', { name: 'Flush' }, tok.flush)).data.server.id;
    await call('POST', `/servers/${flushServer}/invite`, { username: 'canary' }, tok.flush);

    // Everyone has push on. bob has two browsers.
    const browsersOf = { alice: ['alice'], bob: ['bob-phone', 'bob-laptop'], carol: ['carol'], dave: ['dave'], canary: ['canary'] };
    for (const [name, list] of Object.entries(browsersOf)) {
      for (const browser of list) {
        const res = await call('POST', '/push/subscribe', subscription(`ok/${browser}`), tok[name]);
        assert.equal(res.status, 200);
      }
    }

    aliceSock = await connect(server.base, tok.alice);
    sockets.push(aliceSock);
    generalId = await enter(serverId);
  });
  after(async () => {
    for (const s of sockets) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('a direct message pushes the recipient on each of their browsers, and nobody else', async () => {
    const { result, pushes } = await pushedBy(() => dm('alice', 'bob', 'fancy a game?'));
    assert.equal(result.status, 200);
    assert.deepEqual(browsers(pushes), ['bob-laptop', 'bob-phone'], 'not the sender, not a bystander');
    for (const push of pushes) {
      assert.deepEqual(push.payload, {
        title: '💬 alice',
        body: 'fancy a game?',
        tag: 'lanparty-dm-dm-alice', // the tag the in-page notification uses, so the two collapse
        url: `/app/?open=dm/${ids.alice}/alice`,
      });
      assert.equal(push.ttl, 24 * 60 * 60);
      assert.equal(push.urgency, 'high');
      assert.match(push.topic, /^[A-Za-z0-9_-]{1,32}$/, 'a topic the push services accept');
      assert.equal(push.subject, 'mailto:admin@party.example.org', 'derived from CLIENT_ORIGIN');
    }
    assert.equal(new Set(pushes.map((p) => p.topic)).size, 1, 'same conversation, same topic');

    // Delivery is recorded per browser.
    const rows = await waitFor(async () => {
      const found = await dbAll(server.dataDir, "SELECT last_success_at FROM push_subscriptions WHERE username = 'bob'");
      return found.every((r) => r.last_success_at > 0) && found;
    }, 'last_success_at');
    assert.equal(rows.length, 2);
  });

  test('the body is one short line: long text is cut, and media is named rather than quoted', async () => {
    const long = `${'so '.repeat(120)}long`;
    const cases = [
      [{ text: long }, (body) => { assert.ok(Array.from(body).length <= BODY_MAX, `cut to ${BODY_MAX}`); assert.ok(body.endsWith('…')); assert.ok(long.startsWith(body.slice(0, -1))); }],
      [{ text: 'line one\n\nline two' }, (body) => assert.equal(body, 'line one line two')],
      [{ text: 'https://media.tenor.com/AbC123/cat-jam.gif' }, (body) => assert.equal(body, 'Sent a GIF')],
      [{ text: '/gifs/1700000000000-ab12cd-party.webp' }, (body) => assert.equal(body, 'Sent an image')],
      [{ text: 'look at this https://cdn.example.com/clips/win.mp4?x=1' }, (body) => assert.equal(body, 'look at this', 'a caption stands for its media')],
      [{ text: 'see https://example.com/patch-notes for details' }, (body) => assert.equal(body, 'see https://example.com/patch-notes for details', 'a link mid-sentence is just text')],
      [{ text: '', attachment: { url: '/uploads/1700000000000-ab12cd-shot.png', name: 'shot.png', type: 'image/png', size: 10 } }, (body) => assert.equal(body, 'Sent an image')],
      [{ text: '', attachment: { url: '/uploads/1700000000000-ab12cd-notes.pdf', name: 'notes.pdf', type: 'application/pdf', size: 10 } }, (body) => assert.equal(body, 'Sent a file')],
    ];
    for (const [message, check] of cases) {
      const { result, pushes } = await pushedBy(() => dm('alice', 'carol', message.text, message.attachment ? { attachment: message.attachment } : {}));
      assert.equal(result.status, 200);
      assert.deepEqual(browsers(pushes), ['carol']);
      check(pushes[0].payload.body);
    }
  });

  test('a group message pushes every other member', async () => {
    const group = (await call('POST', '/groups', { name: 'Raid night', members: ['bob', 'carol'] }, tok.alice)).data.group;
    const { result, pushes } = await pushedBy(() => call('POST', `/groups/${group.id}/messages`, { text: 'ready?' }, tok.alice));
    assert.equal(result.status, 200);
    assert.deepEqual(browsers(pushes), ['bob-laptop', 'bob-phone', 'carol'], 'the sender and non-members hear nothing');
    for (const push of pushes) {
      assert.deepEqual(push.payload, {
        title: '👥 Raid night',
        body: 'alice: ready?',
        tag: `lanparty-group-${group.id}`,
        url: `/app/?open=group/${group.id}`,
      });
    }

    // From someone else, the set changes with the sender; media is attributed.
    const reply = await pushedBy(() => call('POST', `/groups/${group.id}/messages`, { text: 'https://media.tenor.com/x/yes.gif' }, tok.bob));
    assert.deepEqual(browsers(reply.pushes), ['alice', 'carol']);
    assert.equal(reply.pushes[0].payload.body, 'bob sent a GIF');

    // Someone who has left is no longer a recipient.
    await call('DELETE', `/groups/${group.id}/members/carol`, undefined, tok.carol);
    const after = await pushedBy(() => call('POST', `/groups/${group.id}/messages`, { text: 'carol left' }, tok.alice));
    assert.deepEqual(browsers(after.pushes), ['bob-laptop', 'bob-phone']);
  });

  test('a channel message pushes only the members it @mentions', async () => {
    const quiet = await pushedBy(() => say(generalId, 'anyone around tonight?'));
    assert.deepEqual(quiet.pushes, [], 'ordinary channel chatter never pushes');

    const { pushes } = await pushedBy(() => say(generalId, '@bob you up?'));
    assert.deepEqual(browsers(pushes), ['bob-laptop', 'bob-phone']);
    assert.deepEqual(pushes[0].payload, {
      title: '🔔 general · Push Test',
      body: 'alice: @bob you up?',
      tag: `lanparty-channel-${serverId}-${generalId}`,
      url: `/app/?open=channel/${serverId}/${generalId}`,
    });

    const several = await pushedBy(() => say(generalId, 'gg @bob and @carol. mail bob@example.com about it, also @bob again'));
    assert.deepEqual(browsers(several.pushes), ['bob-laptop', 'bob-phone', 'carol'], 'each once; trailing punctuation is not part of a name');

    assert.deepEqual((await pushedBy(() => say(generalId, '@alice note to self'))).pushes, [], 'mentioning yourself is not a notification');
    assert.deepEqual((await pushedBy(() => say(generalId, 'is @dave coming?'))).pushes, [], 'dave is not in this server');
    assert.deepEqual((await pushedBy(() => say(generalId, 'paging @nobody-by-that-name'))).pushes, []);
    assert.deepEqual((await pushedBy(() => say(generalId, 'write to carol@example.com'))).pushes, [], 'an email address is not a mention');
  });

  test('a mention in a private channel only reaches people who can open it', async () => {
    const made = await call('POST', `/servers/${serverId}/channels`, { name: 'officers', privacy: 'private', members: ['bob'] }, tok.alice);
    const officersId = made.data.channel.id;

    const { pushes } = await pushedBy(() => say(officersId, '@bob @carol the plan is on'));
    assert.deepEqual(browsers(pushes), ['bob-laptop', 'bob-phone'], 'carol cannot see this channel, so its text must not reach her lock screen');
    assert.equal(pushes[0].payload.title, '🔔 officers · Push Test');
  });

  test('in the public server a mention only pushes someone the sender could already message', async () => {
    // Everyone counts as a member of the commons, so without this any stranger could ring any phone.
    // bob shares a real server with alice; dave has no connection to her at all.
    const channelId = await enter('demo');
    const { pushes } = await pushedBy(() => say(channelId, 'welcome @bob, @dave and @ghost-user', 'demo'));
    assert.deepEqual(browsers(pushes), ['bob-laptop', 'bob-phone'], 'dave is a stranger to alice, so he is not rung');
    assert.equal(pushes[0].payload.url, `/app/?open=channel/demo/${channelId}`);
  });

  test('a friend request pushes the person it was sent to', async () => {
    const { result, pushes } = await pushedBy(() => call('POST', '/friends/request', { username: 'carol' }, tok.dave));
    assert.equal(result.status, 200);
    assert.deepEqual(browsers(pushes), ['carol']);
    assert.deepEqual(pushes[0].payload, {
      title: '👋 Friend request',
      body: 'dave wants to be friends',
      tag: 'lanparty-friend-dave',
      url: '/app/?open=requests',
    });

    // A request that was refused is not announced.
    const dup = await pushedBy(() => call('POST', '/friends/request', { username: 'carol' }, tok.dave));
    assert.equal(dup.result.status, 409);
    assert.deepEqual(dup.pushes, []);
    assert.deepEqual((await pushedBy(() => call('POST', '/friends/request', { username: 'dave' }, tok.dave))).pushes, [], 'nor one to yourself');
  });

  test('nobody is pushed while they are looking at the app', async () => {
    const first = await connect(server.base, tok.carol);
    sockets.push(first);

    // Connected is not the same as looking: a tab that has not reported focus still gets the push.
    assert.deepEqual(browsers((await pushedBy(() => dm('alice', 'carol', 'connected, not focused'))).pushes), ['carol']);

    assert.deepEqual(await focus(first, { focused: true }), { ok: true });
    assert.deepEqual((await pushedBy(() => dm('alice', 'carol', 'you can see this already'))).pushes, [], 'a focused window means no push');
    assert.deepEqual((await pushedBy(() => say(generalId, '@carol also on screen'))).pushes, [], 'mentions included');
    // Only the person looking is spared; everyone else is still pushed.
    assert.deepEqual(browsers((await pushedBy(() => dm('carol', 'bob', 'bob is away'))).pushes), ['bob-laptop', 'bob-phone']);

    // A second window that is in the background does not undo the first one's focus…
    const second = await connect(server.base, tok.carol);
    sockets.push(second);
    await focus(second, false);
    assert.deepEqual((await pushedBy(() => dm('alice', 'carol', 'one focused window is enough'))).pushes, []);

    // …and once no window has focus, pushes resume, however many are still connected.
    await focus(first, { focused: false });
    assert.deepEqual(browsers((await pushedBy(() => dm('alice', 'carol', 'both in the background'))).pushes), ['carol']);

    // The bare boolean form is accepted too.
    await focus(second, true);
    assert.deepEqual((await pushedBy(() => dm('alice', 'carol', 'second window focused'))).pushes, []);

    // A focused window that goes away (closed tab, dead connection) stops counting. The server
    // learns of the disconnect a moment later, so ask until it has.
    second.close();
    let attempt = 0;
    await waitFor(async () => {
      attempt += 1;
      const { pushes } = await pushedBy(() => dm('alice', 'carol', `after closing, try ${attempt}`));
      return pushes.length === 1;
    }, 'pushes to resume after the focused window closed');
    first.close();
  });

  test('a subscription the push service says is gone is deleted; other failures leave it alone', async () => {
    for (const where of ['gone/bob-old-phone', 'missing/bob-older-phone', 'busy/bob-flaky']) {
      assert.equal((await call('POST', '/push/subscribe', subscription(where), tok.bob)).status, 200);
    }
    const { result, pushes } = await pushedBy(() => dm('alice', 'bob', 'pruning time'));
    assert.equal(result.status, 200);
    assert.deepEqual(browsers(pushes), ['bob-flaky', 'bob-laptop', 'bob-old-phone', 'bob-older-phone', 'bob-phone'], 'every browser was tried');

    const left = await waitFor(async () => {
      const rows = await dbAll(server.dataDir, "SELECT endpoint, last_success_at FROM push_subscriptions WHERE username = 'bob'");
      return rows.length === 3 && rows;
    }, 'the dead subscriptions to be pruned');
    assert.deepEqual(browsers(left), ['bob-flaky', 'bob-laptop', 'bob-phone'], '410 and 404 are final; a 500 may be temporary');
    assert.equal(left.find((r) => r.endpoint.endsWith('/bob-flaky')).last_success_at, null);

    // The failure is logged by host only: the path of an endpoint is its secret.
    await waitFor(() => /\[push\] send to push\.example\.com failed: HTTP 500/.test(server.log()), 'the failure to be logged');
    assert.ok(!server.log().includes('bob-flaky'), 'no endpoint path in the log');
    assert.ok(!server.log().includes('bob-old-phone'));

    // Next time only the survivors are tried.
    const next = await pushedBy(() => dm('alice', 'bob', 'after pruning'));
    assert.deepEqual(browsers(next.pushes), ['bob-flaky', 'bob-laptop', 'bob-phone']);
  });

  test('a sender that throws never fails the message that triggered it', async () => {
    assert.equal((await call('POST', '/push/subscribe', subscription('throw/bob-cursed'), tok.bob)).status, 200);
    assert.equal((await call('POST', '/push/subscribe', subscription('throw/carol-cursed'), tok.carol)).status, 200);

    const direct = await pushedBy(() => dm('alice', 'bob', 'still delivered'));
    assert.equal(direct.result.status, 200);
    assert.equal(direct.result.data.message.text, 'still delivered');
    assert.ok(browsers(direct.pushes).includes('bob-cursed'), 'the broken browser was attempted');
    assert.ok(browsers(direct.pushes).includes('bob-phone'), 'and did not stop the working ones');
    const thread = await call('GET', '/messages/with/alice', undefined, tok.bob);
    assert.ok(thread.data.messages.some((m) => m.text === 'still delivered'), 'the message itself is stored');

    const group = (await call('POST', '/groups', { name: '', members: ['bob', 'carol'] }, tok.alice)).data.group;
    const grouped = await pushedBy(() => call('POST', `/groups/${group.id}/messages`, { text: 'group survives too' }, tok.alice));
    assert.equal(grouped.result.status, 200);
    assert.equal(grouped.pushes[0].payload.title, '👥 Group chat', 'an unnamed group still gets a title');

    const mention = await pushedBy(() => say(generalId, '@bob @carol channel survives too'));
    assert.equal(mention.result.text, '@bob @carol channel survives too');

    assert.equal((await call('POST', '/friends/request', { username: 'bob' }, tok.dave)).status, 200);
    // And the server is still standing.
    assert.equal((await call('GET', '/push/public-key', undefined, tok.alice)).status, 200);
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE '%cursed'"))[0].n, 2, 'a thrown error is not proof the subscription is dead');
  });

  test('deactivating an account removes its subscriptions', async () => {
    // Left behind, they would deliver to whoever registers the freed username next. The confirm
    // token only exists in an email, so read it from the database as the mail link would carry it.
    assert.equal((await call('POST', '/account/deactivate', {}, tok.dave)).status, 200);
    const [row] = await dbAll(server.dataDir, "SELECT token FROM auth_tokens WHERE purpose = 'deactivate' AND user_id = ?", [ids.dave]);
    assert.equal((await call('POST', '/account/deactivate/confirm', { token: row.token })).status, 200);
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM push_subscriptions WHERE username = 'dave'"))[0].n, 0);
  });
});

describe('without the web-push module', () => {
  // The production host does not reinstall dependencies on deploy, so this is a real state: the code
  // is there and the library is not. Everything else has to carry on exactly as before.
  let server, call, tok;

  before(async () => {
    server = await startServer({ env: { WEB_PUSH_MODULE: 'web-push-is-not-installed-here', PUSH_EXTRA_HOSTS: 'push.example.com' } });
    call = apiFor(server.base);
    tok = {};
    for (const name of ['ann', 'ben', 'cy']) tok[name] = await makeUser(call, name);
    const serverId = (await call('POST', '/servers', { name: 'No Push' }, tok.ann)).data.server.id;
    for (const username of ['ben', 'cy']) await call('POST', `/servers/${serverId}/invite`, { username }, tok.ann);
  });
  after(async () => { await server.stop(); });

  test('the server boots and says push is off', async () => {
    assert.match(server.log(), /\[push\] web-push is not installed: push notifications are off/);
    assert.ok(!fs.existsSync(path.join(server.dataDir, 'vapid.json')), 'no keys are minted for a feature that cannot run');
  });

  test('every push endpoint reports it unavailable instead of failing', async () => {
    const key = await call('GET', '/push/public-key', undefined, tok.ann);
    assert.equal(key.status, 200);
    assert.deepEqual(key.data, { available: false, publicKey: null });

    const sub = await call('POST', '/push/subscribe', subscription('ok/ann'), tok.ann);
    assert.equal(sub.status, 503);
    assert.equal(sub.data.available, false);
    assert.match(sub.data.error, /not available/);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM push_subscriptions'))[0].n, 0);

    // Unsubscribing is the one thing that still works: it is what sign-out depends on.
    const unsub = await call('POST', '/push/unsubscribe', { endpoint: subscription('ok/ann').endpoint }, tok.ann);
    assert.equal(unsub.status, 200);
    assert.equal(unsub.data.available, false);
  });

  test('messages, groups, mentions and friend requests all still work', async () => {
    const direct = await call('POST', '/messages/send', { toUsername: 'ben', text: 'no push, no problem' }, tok.ann);
    assert.equal(direct.status, 200);

    const group = await call('POST', '/groups', { members: ['ben', 'cy'] }, tok.ann);
    assert.equal(group.status, 200);
    assert.equal((await call('POST', `/groups/${group.data.group.id}/messages`, { text: 'hello all' }, tok.ann)).status, 200);

    assert.equal((await call('POST', '/friends/request', { username: 'ben' }, tok.cy)).status, 200);

    const sock = await connect(server.base, tok.ann);
    try {
      const joined = once(sock, 'channel:joined');
      sock.emit('join', { serverId: 'demo', name: 'ann' });
      const { channelId } = await joined;
      const echoed = once(sock, 'message', (m) => m.text === 'hey @ben');
      sock.emit('message', { serverId: 'demo', channelId, text: 'hey @ben' });
      assert.equal((await echoed).author, 'ann');
      // The focus report is harmless too.
      assert.deepEqual(await focus(sock, true), { ok: true });
    } finally {
      sock.close();
    }
    // Still answering afterwards: nothing above crashed it out of band.
    assert.equal((await call('GET', '/push/public-key', undefined, tok.ann)).status, 200);
  });
});

describe('push service (in process)', () => {
  const tmpDirs = [];
  const dbs = [];
  const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lanparty-push-')); tmpDirs.push(d); return d; };
  const freshDb = async () => {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await migrate(db);
    dbs.push(db);
    return db;
  };
  // Collects what would have been logged, so tests can assert on it (and keep the output clean).
  const recorder = () => {
    const lines = [];
    const add = (...args) => lines.push(args.map(String).join(' '));
    return { log: add, warn: add, lines };
  };
  const payload = { title: 'T', body: 'B', tag: 'lanparty-dm-dm-zed', url: '/app/' };

  after(async () => {
    for (const db of dbs) { try { await db.close(); } catch (_) { /* already closed */ } }
    for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
  });

  test('the keypair survives a restart, and is replaced only when it is unusable', async () => {
    const dir = tmpDir();
    const db = await freshDb();
    const sender = async () => ({ statusCode: 201 });
    const first = createPush({ db, dataDir: dir, env: {}, sender, log: recorder() });
    assert.equal(first.available(), true);
    const key = first.publicKey();

    const second = createPush({ db, dataDir: dir, env: {}, sender, log: recorder() });
    assert.equal(second.publicKey(), key, 'a restart must not orphan every subscription');

    // Garbage in the file: there is no key to preserve, so a new one is made and saved.
    fs.writeFileSync(path.join(dir, 'vapid.json'), '{ not json');
    const log = recorder();
    const third = createPush({ db, dataDir: dir, env: {}, sender, log });
    assert.equal(third.available(), true);
    assert.notEqual(third.publicKey(), key);
    assert.ok(log.lines.some((l) => /not valid JSON/.test(l)));
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'vapid.json'), 'utf8'));
    assert.equal(stored.publicKey, third.publicKey());
    assert.ok(!log.lines.join('\n').includes(stored.privateKey), 'the private key is never logged');
  });

  test('keys in the environment win over the file, and a mismatched pair turns push off', async () => {
    const dir = tmpDir();
    const db = await freshDb();
    const sender = async () => ({ statusCode: 201 });
    const pair = generateVapidKeys();
    const fromEnv = createPush({ db, dataDir: dir, env: { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: pair.privateKey }, sender, log: recorder() });
    assert.equal(fromEnv.publicKey(), pair.publicKey);
    assert.ok(!fs.existsSync(path.join(dir, 'vapid.json')), 'nothing is written when the operator supplies the keys');

    const other = generateVapidKeys();
    const log = recorder();
    const mismatched = createPush({ db, dataDir: dir, env: { VAPID_PUBLIC_KEY: pair.publicKey, VAPID_PRIVATE_KEY: other.privateKey }, sender, log });
    assert.equal(mismatched.available(), false);
    assert.equal(mismatched.publicKey(), null);
    assert.ok(log.lines.some((l) => /not a matching keypair/.test(l)));
    assert.ok(!log.lines.join('\n').includes(other.privateKey));
    await mismatched.notify(['zed'], payload); // inert, not an error
  });

  test('without the library there is no sender, no keys, and nothing throws', async () => {
    const dir = tmpDir();
    const db = await freshDb();
    const push = createPush({ db, dataDir: dir, env: {}, webpush: null, log: recorder() });
    assert.equal(push.available(), false);
    assert.equal(push.publicKey(), null);
    assert.ok(!fs.existsSync(path.join(dir, 'vapid.json')));
    await push.notifyDirectMessage({ from: 'a', fromUserId: 1, to: 'b', text: 'hi' });
    await push.notifyGroupMessage({ groupId: 'grp-1', from: 'a', to: ['b', 'c'], text: 'hi' });
    await push.notifyMention({ serverId: 's', channelId: 'c', from: 'a', to: ['b'], text: '@b' });
    await push.notifyFriendRequest({ from: 'a', to: 'b' });
  });

  test('notify resolves whatever the sender or the database does', async () => {
    const dir = tmpDir();
    const db = await freshDb();
    const log = recorder();
    const calls = [];
    const push = createPush({
      db, dataDir: dir, env: {}, log,
      sender: (target) => { calls.push(target.endpoint); throw new Error(`exploded for ${target.endpoint}`); },
    });
    await push.subscribe('zed', subscription('ok/zed-secret-path'), 'test agent');
    await push.notify(['zed'], payload);
    assert.equal(calls.length, 1);
    assert.ok(log.lines.some((l) => /send to push\.example\.com failed/.test(l)));
    assert.ok(!log.lines.join('\n').includes('zed-secret-path'), 'even an error that quotes the endpoint is not echoed');
    assert.equal((await db.all('SELECT endpoint FROM push_subscriptions')).length, 1);

    // A database that fails mid-lookup: still a resolved promise.
    const broken = createPush({
      db: { ...db, all: async () => { throw new Error('disk on fire'); }, run: db.run.bind(db), get: db.get.bind(db), exec: db.exec.bind(db) },
      dataDir: dir, env: {}, log, sender: async () => ({ statusCode: 201 }),
    });
    await broken.notify(['zed'], payload);
  });

  test('the sender and focused users are left out, and duplicates collapse', async () => {
    const dir = tmpDir();
    const db = await freshDb();
    const sentTo = [];
    const push = createPush({ db, dataDir: dir, env: {}, log: recorder(), sender: async (target) => { sentTo.push(target.endpoint.split('/').pop()); } });
    for (const name of ['amy', 'bo', 'cat']) await push.subscribe(name, subscription(`ok/${name}`));

    await push.notifyGroupMessage({ groupId: 'grp-1', groupName: 'G', from: 'amy', to: ['amy', 'bo', 'cat', 'bo'], text: 'hi' });
    assert.deepEqual(sentTo.splice(0).sort(), ['bo', 'cat']);

    push.setFocus('socket-1', 'bo', true);
    assert.equal(push.isFocused('bo'), true);
    await push.notifyGroupMessage({ groupId: 'grp-1', groupName: 'G', from: 'amy', to: ['bo', 'cat'], text: 'hi' });
    assert.deepEqual(sentTo.splice(0), ['cat']);

    push.setFocus('socket-2', 'bo', false); // another window, in the background
    assert.equal(push.isFocused('bo'), true, 'one focused window is enough');
    push.dropSocket('socket-1');
    assert.equal(push.isFocused('bo'), false);
    push.setFocus('socket-3', null, true); // a socket with no login is nobody
    assert.equal(push.isFocused('null'), false);

    await push.notifyDirectMessage({ from: 'amy', fromUserId: 1, to: 'amy', text: 'to myself' });
    assert.deepEqual(sentTo, []);
  });

  test('the real web-push library accepts the keys, subject and options we give it', async () => {
    // No network: generateRequestDetails does everything sendNotification does (validation, VAPID
    // signing, payload encryption) except the request itself. This is what catches a key written in
    // the wrong encoding or an option the library rejects.
    const real = require('web-push');
    const dir = tmpDir();
    const db = await freshDb();
    let details = null;
    const log = recorder();
    const push = createPush({
      db, dataDir: dir, env: {}, clientOrigin: 'https://party.example.org', log,
      webpush: { sendNotification: async (target, body, options) => { details = real.generateRequestDetails(target, body, options); return { statusCode: 201 }; } },
    });
    const browser = crypto.createECDH('prime256v1');
    browser.generateKeys();
    await push.subscribe('zed', {
      endpoint: 'https://push.example.com/ok/zed',
      keys: { p256dh: browser.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
    });
    await push.notifyDirectMessage({ from: 'yan', fromUserId: 7, to: 'zed', text: 'hello' });
    assert.ok(details, `the library refused the request: ${log.lines.join(' | ')}`);
    assert.equal(details.endpoint, 'https://push.example.com/ok/zed');
    assert.equal(details.method, 'POST');
    assert.equal(details.headers.TTL, 24 * 60 * 60);
    assert.equal(details.headers.Urgency, 'high');
    assert.match(details.headers.Topic, /^[A-Za-z0-9_-]{1,32}$/);
    assert.match(details.headers.Authorization, /^vapid t=/);
    assert.ok(details.headers.Authorization.includes(push.publicKey()), 'signed with the key the browsers subscribed against');
    assert.ok(details.body.length > 0 && details.body.length < 4096, 'encrypted, and inside the push services\' size limit');
    assert.equal((await db.get('SELECT last_success_at FROM push_subscriptions')).last_success_at > 0, true);
  });

  test('the VAPID subject comes from the environment, else from where the app is hosted', () => {
    assert.equal(vapidSubjectFor({ VAPID_SUBJECT: 'mailto:ops@example.org' }, 'https://party.example.org'), 'mailto:ops@example.org');
    assert.equal(vapidSubjectFor({ VAPID_SUBJECT: 'https://example.org/contact' }, '*'), 'https://example.org/contact');
    assert.equal(vapidSubjectFor({ VAPID_SUBJECT: 'not a contact' }, 'https://party.example.org'), 'mailto:admin@party.example.org', 'an unusable value is ignored, not sent');
    assert.equal(vapidSubjectFor({}, 'https://party.example.org:8443, https://other.example.org'), 'mailto:admin@party.example.org');
    assert.equal(vapidSubjectFor({}, '*'), 'mailto:admin@localhost');
    assert.equal(vapidSubjectFor({}, undefined), 'mailto:admin@localhost');
  });

  test('previews follow the client\'s media rule', () => {
    assert.deepEqual(previewOf('hello there'), { text: 'hello there', media: null });
    assert.deepEqual(previewOf('  https://media.tenor.com/a/b.gif  '), { text: '', media: 'gif' });
    assert.deepEqual(previewOf('https://example.com/a/photo.JPG?size=large'), { text: '', media: 'image' });
    assert.deepEqual(previewOf('/uploads/1-abc-clip.webm'), { text: '', media: 'video' });
    assert.deepEqual(previewOf('wow https://example.com/a.png'), { text: 'wow', media: null });
    assert.deepEqual(previewOf('https://example.com/a.png wow'), { text: 'https://example.com/a.png wow', media: null }, 'only a TRAILING media url counts');
    assert.deepEqual(previewOf('https://example.com/article'), { text: 'https://example.com/article', media: null });
    assert.deepEqual(previewOf('/shrug'), { text: '/shrug', media: null });
    assert.deepEqual(previewOf('', { type: 'image/gif', name: 'x.bin' }), { text: '', media: 'gif' });
    assert.deepEqual(previewOf('', { type: 'application/zip', name: 'mods.zip' }), { text: '', media: 'file' });
    assert.deepEqual(previewOf('caption', { type: 'image/png', name: 'x.png' }), { text: 'caption', media: null }, 'text wins over an attachment');
    assert.deepEqual(previewOf('', null), { text: '', media: null });
    // Cut by code point: an emoji is never split in half.
    const emoji = '😀'.repeat(BODY_MAX + 20);
    const cut = previewOf(emoji).text;
    assert.equal(Array.from(cut).length, BODY_MAX);
    assert.ok(cut.endsWith('…') && !/�/.test(cut) && cut.slice(0, -1) === '😀'.repeat(BODY_MAX - 1));
  });

  test('mentions are whole @names, not fragments of other things', () => {
    assert.deepEqual(mentionedUsernames('hi @sam and @alex_99'), ['sam', 'alex_99']);
    assert.deepEqual(mentionedUsernames('@sam, @sam and @sam'), ['sam']);
    assert.deepEqual(mentionedUsernames('thanks @j.doe.'), ['j.doe.', 'j.doe'], 'the name as written, and without the sentence\'s full stop');
    assert.deepEqual(mentionedUsernames('mail sam@example.com'), []);
    assert.deepEqual(mentionedUsernames('(@sam)'), ['sam']);
    assert.deepEqual(mentionedUsernames('no mentions here @ all'), []);
    assert.deepEqual(mentionedUsernames(undefined), []);
  });
});

describe('push hardening', () => {
  let server, call;
  before(async () => {
    server = await startServer({ env: { WEB_PUSH_MODULE: FAKE_WEB_PUSH, PUSH_EXTRA_HOSTS: 'push.example.com' } });
    call = apiFor(server.base);
  });
  after(async () => { await server.stop(); });

  test('the real push services are accepted without any configuration', async () => {
    const token = await makeUser(call, 'realhosts');
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://wns2-by3p.notify.windows.com/w/?token=abc',
    ]) {
      const res = await call('POST', '/push/subscribe', { ...subscription('ok/x'), endpoint }, token);
      assert.equal(res.status, 200, endpoint);
    }
  });

  test('a token whose account is gone cannot register a browser', async () => {
    // The token outlives the account (rename, deletion). A row stored under the freed name would
    // deliver the NEXT owner of that username's messages to this old device.
    const token = await makeUser(call, 'ghosted');
    await dbAll(server.dataDir, "DELETE FROM users WHERE username = 'ghosted'");
    const res = await call('POST', '/push/subscribe', subscription('ok/ghost'), token);
    assert.equal(res.status, 401);
    assert.deepEqual(await dbAll(server.dataDir, "SELECT 1 FROM push_subscriptions WHERE username = 'ghosted'"), []);
  });

  test('mention pushes from one sender are capped per minute', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-push-cap-'));
    const push = createPush({ db: { get: async () => null, all: async () => [], run: async () => ({}) }, dataDir: dir, env: {}, sender: async () => {}, log: { log() {}, warn() {} } });
    const t0 = 1_000_000;
    const allowed = Array.from({ length: MENTION_PUSHES_PER_WINDOW + 3 }, (_, i) => push.allowMentionPush('spammer', t0 + i));
    assert.equal(allowed.filter(Boolean).length, MENTION_PUSHES_PER_WINDOW, 'only the first few ring phones');
    assert.equal(push.allowMentionPush('someone-else', t0 + 50), true, 'the cap is per sender');
    assert.equal(push.allowMentionPush('spammer', t0 + 61_000), true, 'and it lifts once the window has passed');
  });
});
