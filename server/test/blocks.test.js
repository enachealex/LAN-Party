// Blocking: what one account shutting another out does, and what it must never give away.
//
// Two rules run through every test here:
//   1. It is enforced by the server. A hand-written client that ignores the block (a raw socket
//      emitting a typing hint or a call, a direct POST) gets nowhere.
//   2. The person who was blocked cannot find out. Wherever they are refused, the answer is
//      compared, whole, with the one the same request gets for someone they simply cannot reach;
//      wherever they are not refused, nothing they can read back differs from the ordinary case.
//
// Push notifications are checked with the fake sender from push.test.js (test/fixtures/fakeWebPush.js).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUserFromOwnAddress: makeUser, dbAll } = require('./helpers');
const { BLOCK_WRITE_MAX } = require('../routes/blocks');

const FAKE_WEB_PUSH = path.join(__dirname, 'fixtures', 'fakeWebPush.js');
const PUSH_ENV = { WEB_PUSH_MODULE: FAKE_WEB_PUSH, PUSH_EXTRA_HOSTS: 'push.example.com' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// Resolves true if the event does NOT arrive within the window.
const never = (socket, event, match = () => true, ms = 700) => once(socket, event, match, ms).then(() => false, () => true);

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

// Enter a server the way the client does, and hand back what the server sent about it.
async function joinServer(socket, serverId) {
  const state = once(socket, 'server:state', (s) => s.server.id === serverId);
  const init = once(socket, 'messages:init', (m) => m.serverId === serverId);
  socket.emit('join', { serverId });
  return { state: await state, init: await init };
}

async function befriend(call, fromToken, toToken, toUsername) {
  const req = await call('POST', '/friends/request', { username: toUsername }, fromToken);
  assert.equal(req.status, 200, `friend request should succeed: ${JSON.stringify(req.data)}`);
  const incoming = await call('GET', '/friends/requests/incoming', undefined, toToken);
  const res = await call('POST', `/friends/requests/${incoming.data.requests[0].id}/accept`, undefined, toToken);
  assert.equal(res.status, 200);
}

const friendNames = async (call, token) => (await call('GET', '/friends', undefined, token)).data.friends.map((f) => f.name).sort();
const incomingFrom = async (call, token) => (await call('GET', '/friends/requests/incoming', undefined, token)).data.requests.map((r) => r.fromUsername).sort();
const outgoingTo = async (call, token) => (await call('GET', '/friends/requests/outgoing', undefined, token)).data.requests.map((r) => r.toUsername).sort();

// A browser's push subscription, as in push.test.js. The last path segment names the browser.
const subscription = (who) => ({
  endpoint: `https://push.example.com/ok/${who}`,
  expirationTime: null,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  },
});
function pushedTo(server) {
  const file = path.join(server.dataDir, 'push-sent.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).endpoint.split('/').pop());
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

describe('the block list', () => {
  let server, call;
  const tok = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['lia', 'max', 'ned']) tok[name] = await makeUser(server.base, name);
  });
  after(async () => { await server.stop(); });

  test('every route needs a login', async () => {
    assert.equal((await call('GET', '/blocks')).status, 401);
    assert.equal((await call('POST', '/blocks/max')).status, 401);
    assert.equal((await call('DELETE', '/blocks/max')).status, 401);
  });

  test('you cannot block yourself, or an account that does not exist', async () => {
    const self = await call('POST', '/blocks/lia', undefined, tok.lia);
    assert.equal(self.status, 400);
    assert.match(self.data.error, /yourself/i);
    assert.equal((await call('POST', '/blocks/nobody-here', undefined, tok.lia)).status, 404);
    assert.equal((await call('DELETE', '/blocks/nobody-here', undefined, tok.lia)).status, 404);
    assert.deepEqual((await call('GET', '/blocks', undefined, tok.lia)).data.blocks, []);
  });

  test('block, list (who and when), block again, unblock, unblock again', async () => {
    const before = Date.now();
    const first = await call('POST', '/blocks/max', undefined, tok.lia);
    assert.equal(first.status, 200);
    assert.deepEqual(first.data, { success: true, blocked: true, username: 'max' });

    const list = await call('GET', '/blocks', undefined, tok.lia);
    assert.equal(list.status, 200);
    assert.equal(list.data.blocks.length, 1);
    assert.equal(list.data.blocks[0].username, 'max');
    assert.ok(list.data.blocks[0].blockedAt >= before && list.data.blocks[0].blockedAt <= Date.now());
    assert.deepEqual(Object.keys(list.data.blocks[0]).sort(), ['blockedAt', 'userId', 'username']);

    // Idempotent: the same answer, and still one row with its original time.
    const again = await call('POST', '/blocks/max', undefined, tok.lia);
    assert.deepEqual(again, first);
    const rows = await dbAll(server.dataDir, 'SELECT created_at FROM user_blocks');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].created_at, list.data.blocks[0].blockedAt);

    // One direction only: max has blocked nobody, and is not told anything.
    assert.deepEqual((await call('GET', '/blocks', undefined, tok.max)).data.blocks, []);

    const lifted = await call('DELETE', '/blocks/max', undefined, tok.lia);
    assert.equal(lifted.status, 200);
    assert.deepEqual(lifted.data, { success: true, blocked: false, username: 'max' });
    assert.deepEqual((await call('DELETE', '/blocks/max', undefined, tok.lia)), lifted, 'unblocking twice is the same success');
    assert.deepEqual((await call('GET', '/blocks', undefined, tok.lia)).data.blocks, []);
  });

  test('a block follows the account through a rename (it is kept by user id)', async () => {
    await call('POST', '/blocks/ned', undefined, tok.lia);
    const renamed = await call('POST', '/user/username', { username: 'neddy' }, tok.ned);
    assert.equal(renamed.status, 200);
    assert.deepEqual((await call('GET', '/blocks', undefined, tok.lia)).data.blocks.map((b) => b.username), ['neddy']);
    // And the blocker's own rename does not lose their list either.
    const mine = await call('POST', '/user/username', { username: 'lia2' }, tok.lia);
    assert.deepEqual((await call('GET', '/blocks', undefined, mine.data.token)).data.blocks.map((b) => b.username), ['neddy']);
  });

  test('the routes are rate limited per account', async () => {
    const spammer = await makeUser(server.base, 'spammer');
    await makeUser(server.base, 'target');
    for (let i = 0; i < BLOCK_WRITE_MAX; i++) {
      const res = await call(i % 2 ? 'DELETE' : 'POST', '/blocks/target', undefined, spammer);
      assert.equal(res.status, 200, `request ${i + 1} is inside the limit`);
    }
    const over = await call('POST', '/blocks/target', undefined, spammer);
    assert.equal(over.status, 429);
    assert.ok(over.data.retryAfter > 0);
    // Someone else's bucket is their own.
    assert.equal((await call('POST', '/blocks/target', undefined, tok.max)).status, 200);
  });
});

describe('a block between two people', () => {
  let server, call;
  const tok = {};
  const sock = {};
  // ann blocks ben. cat is a bystander who shares a server with both. dan is a stranger to ben: no
  // friendship, no server in common, and has blocked nobody. Whatever ben is told about ann has to
  // be what he is told about dan. eve never connects (the "not online" case for calls).
  const NAMES = ['ann', 'ben', 'cat', 'dan', 'eve', 'fay'];
  let crewId;

  before(async () => {
    server = await startServer({ env: PUSH_ENV });
    call = apiFor(server.base);
    for (const name of NAMES) tok[name] = await makeUser(server.base, name);
    crewId = (await call('POST', '/servers', { name: 'Crew' }, tok.cat)).data.server.id;
    for (const name of ['ann', 'ben', 'fay']) {
      assert.equal((await call('POST', `/servers/${crewId}/invite`, { username: name }, tok.cat)).status, 200);
    }
    await befriend(call, tok.ann, tok.ben, 'ben');
    // A conversation that exists before the block.
    assert.equal((await call('POST', '/messages/send', { toUsername: 'ann', text: 'before the block' }, tok.ben)).status, 200);
    assert.equal((await call('POST', '/messages/send', { toUsername: 'ben', text: 'my reply' }, tok.ann)).status, 200);
    // One more from ben that ann has not read: the block must not leave it as a badge.
    assert.equal((await call('POST', '/messages/send', { toUsername: 'ann', text: 'unread when blocked' }, tok.ben)).status, 200);
    // ann's phone, which is what would buzz.
    assert.equal((await call('POST', '/push/subscribe', subscription('ann-phone'), tok.ann)).status, 200);
    for (const name of ['ann', 'ben', 'cat', 'dan']) sock[name] = await connect(server.base, tok[name]);
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server.stop();
  });

  test('before the block: a message, a typing hint and a call all reach ann', async () => {
    const typing = once(sock.ann, 'typing', (p) => p.scope === 'dm' && p.from === 'ben');
    sock.ben.emit('typing', { scope: 'dm', to: 'ann' });
    await typing;
    const ringing = once(sock.ann, 'call:incoming', (p) => p.from === 'ben');
    sock.ben.emit('call:invite', { to: 'ann' });
    await ringing;
    sock.ben.emit('call:cancel', { to: 'ann' });
    assert.equal((await call('GET', '/messages/conversations', undefined, tok.ann)).data.totalUnread, 2);
  });

  test('blocking removes the friendship both ways and clears the unread badge; ben is told only what an unfriend tells him', async () => {
    const benSees = [];
    const record = (event) => (payload) => benSees.push({ event, payload });
    const listeners = ['friend:list-updated', 'friend:pending-updated', 'blocks:updated', 'dm:unread-updated'].map((event) => {
      const fn = record(event);
      sock.ben.on(event, fn);
      return [event, fn];
    });
    const annTold = once(sock.ann, 'blocks:updated');
    const res = await call('POST', '/blocks/ben', undefined, tok.ann);
    assert.equal(res.status, 200);
    await annTold;
    await sleep(300);
    for (const [event, fn] of listeners) sock.ben.off(event, fn);

    assert.deepEqual(await friendNames(call, tok.ann), []);
    assert.deepEqual(await friendNames(call, tok.ben), []);
    assert.equal((await call('GET', '/messages/conversations', undefined, tok.ann)).data.totalUnread, 0, 'the unread message from ben no longer counts');
    // Exactly the event DELETE /friends/:username sends the other person, and nothing that
    // mentions a block.
    assert.deepEqual(benSees.map((e) => e.event), ['friend:list-updated']);
    assert.deepEqual(benSees[0].payload, {});
  });

  test('pending friend requests between the two are dropped, whichever way they went', async () => {
    const p = {};
    for (const name of ['pia', 'quin', 'rex', 'sol']) p[name] = await makeUser(server.base, name);
    // quin asked pia; pia blocks quin.
    await call('POST', '/friends/request', { username: 'pia' }, p.quin);
    assert.deepEqual(await incomingFrom(call, p.pia), ['quin']);
    await call('POST', '/blocks/quin', undefined, p.pia);
    assert.deepEqual(await incomingFrom(call, p.pia), []);
    assert.deepEqual(await outgoingTo(call, p.quin), []);
    // rex asked sol; rex then blocks sol.
    await call('POST', '/friends/request', { username: 'sol' }, p.rex);
    await call('POST', '/blocks/sol', undefined, p.rex);
    assert.deepEqual(await incomingFrom(call, p.sol), []);
    assert.deepEqual(await outgoingTo(call, p.rex), []);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM friend_requests'))[0].n, 0);
  });

  test('ben cannot message ann, and is answered exactly as for someone he cannot reach', async () => {
    const before = (await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM direct_messages'))[0].n;
    const quiet = never(sock.ann, 'dm:message');
    const toAnn = await call('POST', '/messages/send', { toUsername: 'ann', text: 'let me in' }, tok.ben);
    const toStranger = await call('POST', '/messages/send', { toUsername: 'dan', text: 'let me in' }, tok.ben);
    assert.equal(toAnn.status, 403);
    assert.deepEqual(toAnn, toStranger, 'the same status and the same body as for a stranger');
    assert.doesNotMatch(JSON.stringify(toAnn.data), /block/i);
    assert.ok(await quiet, 'nothing was delivered to ann');
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM direct_messages'))[0].n, before, 'nothing was stored');
    // An attachment-only message takes the same path.
    const file = await call('POST', '/messages/send', { toUsername: 'ann', attachment: { url: '/uploads/x.png', name: 'x.png' } }, tok.ben);
    assert.deepEqual(file, toStranger);
  });

  test('ann cannot message ben either while her block stands', async () => {
    const quiet = never(sock.ben, 'dm:message');
    const res = await call('POST', '/messages/send', { toUsername: 'ben', text: 'one more thing' }, tok.ann);
    assert.equal(res.status, 403);
    assert.ok(await quiet);
  });

  test('the existing conversation stays readable on both sides, with ben\'s messages marked for ann only', async () => {
    const annView = await call('GET', '/messages/with/ben', undefined, tok.ann);
    assert.equal(annView.status, 200);
    assert.deepEqual(annView.data.messages.map((m) => m.text), ['before the block', 'my reply', 'unread when blocked']);
    assert.deepEqual(annView.data.messages.map((m) => m.blocked === true), [true, false, true]);
    // ben's view is what it always was: readable, and nothing marked.
    const benView = await call('GET', '/messages/with/ann', undefined, tok.ben);
    assert.equal(benView.status, 200);
    assert.deepEqual(benView.data.messages.map((m) => m.text), ['before the block', 'my reply', 'unread when blocked']);
    assert.ok(benView.data.messages.every((m) => !('blocked' in m)));
  });

  test('ann keeps her side of the conversation even with nothing else connecting them; ben is treated as any stranger would be', async () => {
    // gus and hal are friends with a conversation and share no server. gus blocks hal, which ends
    // the friendship: by the ordinary rule neither could open the conversation any more.
    const gus = await makeUser(server.base, 'gus');
    const hal = await makeUser(server.base, 'hal');
    await befriend(call, gus, hal, 'hal');
    await call('POST', '/messages/send', { toUsername: 'gus', text: 'old news' }, hal);
    await call('POST', '/blocks/hal', undefined, gus);
    const mine = await call('GET', '/messages/with/hal', undefined, gus);
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.data.messages.map((m) => m.text), ['old news']);
    // hal gets what he would get had gus simply unfriended him.
    const ivo = await makeUser(server.base, 'ivo');
    const jan = await makeUser(server.base, 'jan');
    await befriend(call, ivo, jan, 'jan');
    await call('POST', '/messages/send', { toUsername: 'ivo', text: 'old news' }, jan);
    await call('DELETE', '/friends/jan', undefined, ivo);
    assert.deepEqual(
      await call('GET', '/messages/with/gus', undefined, hal),
      await call('GET', '/messages/with/ivo', undefined, jan),
      'blocked and unfriended read the same',
    );
  });

  test('a raw socket cannot get a typing hint or a call through, in either direction', async () => {
    // Fresh sockets: the typing relay is throttled per connection.
    const ben = await connect(server.base, tok.ben);
    const ann = await connect(server.base, tok.ann);
    try {
      const noTyping = never(sock.ann, 'typing');
      const noRing = never(sock.ann, 'call:incoming');
      const told = once(ben, 'call:unavailable');
      ben.emit('typing', { scope: 'dm', to: 'ann' });
      ben.emit('call:invite', { to: 'ann', video: true });
      const answer = await told;
      assert.ok(await noTyping, 'no typing hint reached ann');
      assert.ok(await noRing, 'the call never rang');

      // The answer ben gets is the one for somebody who is not online, shape and all.
      const offline = once(ben, 'call:unavailable');
      ben.emit('call:invite', { to: 'eve', video: true });
      assert.deepEqual(answer, { to: 'ann' });
      assert.deepEqual(await offline, { to: 'eve' });

      // A cancel addressed to her by name is not relayed either.
      const noCancel = never(sock.ann, 'call:canceled');
      ben.emit('call:cancel', { to: 'ann' });
      assert.ok(await noCancel);

      // And ann cannot ring or nudge ben while her block stands.
      const benQuiet = Promise.all([never(sock.ben, 'typing'), never(sock.ben, 'call:incoming')]);
      const annTold = once(ann, 'call:unavailable');
      ann.emit('typing', { scope: 'dm', to: 'ben' });
      ann.emit('call:invite', { to: 'ben' });
      assert.deepEqual(await annTold, { to: 'ben' });
      assert.deepEqual(await benQuiet, [true, true]);
    } finally { ben.close(); ann.close(); }
  });

  test('ben\'s friend request is taken, shown to him as pending, and never reaches ann', async () => {
    const sentBefore = pushedTo(server).length;
    const annQuiet = never(sock.ann, 'friend:pending-updated');
    const toAnn = await call('POST', '/friends/request', { username: 'ann' }, tok.ben);
    const toDan = await call('POST', '/friends/request', { username: 'dan' }, tok.ben);
    assert.equal(toAnn.status, 200);
    assert.deepEqual(toAnn, toDan, 'the same answer as an ordinary request');

    // Everything ben can read back treats the two requests alike.
    const outgoing = (await call('GET', '/friends/requests/outgoing', undefined, tok.ben)).data.requests;
    assert.deepEqual(outgoing.map((r) => r.toUsername).sort(), ['ann', 'dan']);
    const [forAnn, forDan] = ['ann', 'dan'].map((name) => outgoing.find((r) => r.toUsername === name));
    assert.deepEqual(Object.keys(forAnn).sort(), Object.keys(forDan).sort());
    assert.deepEqual(
      await call('POST', '/friends/request', { username: 'ann' }, tok.ben),
      await call('POST', '/friends/request', { username: 'dan' }, tok.ben),
      'asking twice: "already pending", for both',
    );

    // ann never has it: not listed, not counted, not announced, not pushed.
    assert.deepEqual(await incomingFrom(call, tok.ann), []);
    assert.deepEqual(await incomingFrom(call, tok.dan), ['ben']);
    assert.ok(await annQuiet, 'ann was not told her pending count changed');
    await sleep(400); // a push is sent after the response; give one time to have happened
    assert.ok(!pushedTo(server).slice(sentBefore).includes('ann-phone'), 'ann\'s phone did not buzz');

    // Even knowing the row's id, ann cannot act on it.
    const [row] = await dbAll(server.dataDir, "SELECT fr.id, fr.status FROM friend_requests fr JOIN users u ON u.id = fr.to_user_id WHERE u.username = 'ann'");
    assert.equal(row.status, 'withheld');
    assert.equal((await call('POST', `/friends/requests/${row.id}/accept`, undefined, tok.ann)).status, 400);
    assert.deepEqual(await friendNames(call, tok.ann), []);

    // Cancelling works for ben like any other request, and tells ann nothing.
    const stillQuiet = never(sock.ann, 'friend:pending-updated');
    assert.deepEqual(
      await call('POST', `/friends/requests/${forAnn.id}/cancel`, undefined, tok.ben),
      await call('POST', `/friends/requests/${forDan.id}/cancel`, undefined, tok.ben),
    );
    assert.ok(await stillQuiet);
    assert.deepEqual(await outgoingTo(call, tok.ben), []);
    // A cancelled request can be sent again (this used to hit a UNIQUE constraint and take the
    // server down), and is withheld again.
    assert.equal((await call('POST', '/friends/request', { username: 'ann' }, tok.ben)).status, 200);
    assert.deepEqual(await outgoingTo(call, tok.ben), ['ann']);
    assert.deepEqual(await incomingFrom(call, tok.ann), []);
  });

  test('ann has to unblock before she can send ben a friend request', async () => {
    const res = await call('POST', '/friends/request', { username: 'ben' }, tok.ann);
    assert.equal(res.status, 403);
    assert.match(res.data.error, /unblock/i);
    assert.deepEqual(await incomingFrom(call, tok.ben), []);
  });

  test('neither can add the other to a group chat; ben is answered as for a stranger', async () => {
    const withAnn = await call('POST', '/groups', { members: ['ann', 'cat'] }, tok.ben);
    const withDan = await call('POST', '/groups', { members: ['dan', 'cat'] }, tok.ben);
    assert.equal(withAnn.status, 403);
    assert.equal(withAnn.status, withDan.status);
    assert.equal(withAnn.data.error.replace('(ann)', '(X)'), withDan.data.error.replace('(dan)', '(X)'), 'the same words, apart from the name');
    assert.doesNotMatch(withAnn.data.error, /block/i);

    // Adding to a group he is already in is refused the same way.
    const group = (await call('POST', '/groups', { members: ['cat', 'fay'] }, tok.ben)).data.group;
    const addAnn = await call('POST', `/groups/${group.id}/members`, { usernames: ['ann'] }, tok.ben);
    const addDan = await call('POST', `/groups/${group.id}/members`, { usernames: ['dan'] }, tok.ben);
    assert.equal(addAnn.status, 403);
    assert.equal(addAnn.data.error.replace('(ann)', '(X)'), addDan.data.error.replace('(dan)', '(X)'));

    // ann cannot add ben while her block stands.
    assert.equal((await call('POST', '/groups', { members: ['ben', 'cat'] }, tok.ann)).status, 403);
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE u.username = 'ann'"))[0].n, 0);
  });

  test('search: ann no longer finds ben\'s messages in their conversation; ben\'s search is unchanged', async () => {
    const annFinds = await call('GET', '/search?q=block&scope=dm&with=ben', undefined, tok.ann);
    assert.equal(annFinds.status, 200);
    assert.deepEqual(annFinds.data.results.map((r) => r.message.author), [], 'both matches were written by ben');
    const annOwn = await call('GET', '/search?q=reply&scope=all', undefined, tok.ann);
    assert.deepEqual(annOwn.data.results.map((r) => r.message.text), ['my reply'], 'her own messages are still found');
    const benFinds = await call('GET', '/search?q=block&scope=dm&with=ann', undefined, tok.ben);
    assert.equal(benFinds.status, 200);
    assert.deepEqual(benFinds.data.results.map((r) => r.message.text).sort(), ['before the block', 'unread when blocked']);
  });

  test('a reaction or an edit from ben is not delivered to ann, and looks normal to ben', async () => {
    const [first] = (await call('GET', '/messages/with/ann', undefined, tok.ben)).data.messages;
    const annQuiet = Promise.all([never(sock.ann, 'reaction:updated'), never(sock.ann, 'dm:message-edited')]);
    const benReacted = once(sock.ben, 'reaction:updated', (p) => p.scope === 'dm');
    sock.ben.emit('reaction:toggle', { scope: 'dm', messageId: first.id, emoji: '👀' });
    await benReacted;
    const edited = await call('PATCH', `/messages/${first.id}`, { text: 'before the block (edited)' }, tok.ben);
    assert.equal(edited.status, 200);
    assert.deepEqual(await annQuiet, [true, true]);
  });

  test('unblocking: ben can message ann again, and the withheld request is gone rather than delivered', async () => {
    const annQuiet = never(sock.ann, 'friend:pending-updated');
    assert.equal((await call('DELETE', '/blocks/ben', undefined, tok.ann)).status, 200);
    assert.ok(await annQuiet);
    assert.deepEqual(await incomingFrom(call, tok.ann), [], 'the request sent while blocked does not appear late');
    assert.deepEqual(await outgoingTo(call, tok.ben), [], 'to ben it reads as declined');
    assert.deepEqual(await friendNames(call, tok.ann), [], 'the friendship does not come back by itself');

    // They still share a server, so the ordinary rule lets a message through again.
    const delivered = once(sock.ann, 'dm:message', (p) => p.fromUsername === 'ben');
    assert.equal((await call('POST', '/messages/send', { toUsername: 'ann', text: 'hello again' }, tok.ben)).status, 200);
    assert.equal((await delivered).message.text, 'hello again');
    // And a fresh request is an ordinary one.
    assert.equal((await call('POST', '/friends/request', { username: 'ann' }, tok.ben)).status, 200);
    assert.deepEqual(await incomingFrom(call, tok.ann), ['ben']);
  });

  test('a friend request that was declined can be sent again (it used to crash the server)', async () => {
    const kai = await makeUser(server.base, 'kai');
    const lou = await makeUser(server.base, 'lou');
    await call('POST', '/friends/request', { username: 'lou' }, kai);
    const [req] = (await call('GET', '/friends/requests/incoming', undefined, lou)).data.requests;
    assert.equal((await call('POST', `/friends/requests/${req.id}/decline`, undefined, lou)).status, 200);
    assert.equal((await call('POST', '/friends/request', { username: 'lou' }, kai)).status, 200);
    assert.deepEqual(await incomingFrom(call, lou), ['kai']);
    assert.equal((await call('GET', '/friends', undefined, kai)).status, 200, 'the server is still up');
  });
});

describe('a blocked person in servers and groups you share', () => {
  let server, call;
  const tok = {};
  const sock = {};
  let crewId, generalId, groupId;
  const channelMessages = (token) => call('GET', `/servers/${crewId}/channels/${generalId}/messages`, undefined, token);

  before(async () => {
    server = await startServer({ env: PUSH_ENV });
    call = apiFor(server.base);
    for (const name of ['ann', 'ben', 'cat']) tok[name] = await makeUser(server.base, name);
    crewId = (await call('POST', '/servers', { name: 'Crew' }, tok.cat)).data.server.id;
    for (const name of ['ann', 'ben']) await call('POST', `/servers/${crewId}/invite`, { username: name }, tok.cat);
    // A group all three are in, made before the block (cat shares a server with both).
    groupId = (await call('POST', '/groups', { name: 'Trio', members: ['ann', 'ben'] }, tok.cat)).data.group.id;
    assert.equal((await call('POST', '/push/subscribe', subscription('ann-phone'), tok.ann)).status, 200);
    assert.equal((await call('POST', '/push/subscribe', subscription('cat-phone'), tok.cat)).status, 200);
    assert.equal((await call('POST', '/blocks/ben', undefined, tok.ann)).status, 200);
    for (const name of ['ann', 'ben', 'cat']) {
      sock[name] = await connect(server.base, tok[name]);
      const { state } = await joinServer(sock[name], crewId);
      generalId = state.server.channels.find((c) => c.type === 'text').id;
    }
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server.stop();
  });

  test('a live channel message from ben reaches ann marked blocked, and everyone else unmarked', async () => {
    const got = Object.fromEntries(['ann', 'ben', 'cat'].map((name) => [name, once(sock[name], 'message', (m) => m.text === 'needle one')]));
    const annNotNudged = never(sock.ann, 'unread:bump');
    const catNudged = once(sock.cat, 'unread:bump', (b) => b.author === 'ben');
    sock.ben.emit('message', { serverId: crewId, channelId: generalId, text: 'needle one' });
    const [ann, ben, cat] = await Promise.all([got.ann, got.ben, got.cat]);
    assert.equal(ann.blocked, true);
    assert.ok(!('blocked' in cat), 'the mark is ann\'s alone');
    assert.ok(!('blocked' in ben), 'ben sees his own message as ever');
    assert.equal(ann.text, 'needle one', 'it is sent, not withheld: the client collapses it');
    await catNudged;
    assert.ok(await annNotNudged, 'no unread bump (and so no badge or notification) for ann');
  });

  test('history marks ben\'s messages for ann and for nobody else, on every path that sends it', async () => {
    sock.cat.emit('message', { serverId: crewId, channelId: generalId, text: 'needle two' });
    await once(sock.ann, 'message', (m) => m.text === 'needle two');

    const marks = (messages) => messages.map((m) => [m.author, m.blocked === true]);
    const expected = [['ben', true], ['cat', false]];
    // The paged HTTP route.
    assert.deepEqual(marks((await channelMessages(tok.ann)).data.messages), expected);
    // Opening the channel over the socket.
    const init = once(sock.ann, 'messages:init', (m) => m.channelId === generalId);
    sock.ann.emit('joinChannel', { serverId: crewId, channelId: generalId });
    assert.deepEqual(marks((await init).messages), expected);
    // Entering the server.
    assert.deepEqual(marks((await joinServer(sock.ann, crewId)).init.messages), expected);
    // The start-up sync.
    assert.deepEqual(marks((await call('GET', '/user/sync', undefined, tok.ann)).data.servers[crewId].messages[generalId]), expected);

    for (const name of ['ben', 'cat']) {
      const page = (await channelMessages(tok[name])).data.messages;
      assert.equal(page.length, 2);
      assert.ok(page.every((m) => !('blocked' in m)), `${name} sees no marks`);
    }
  });

  test('ben\'s messages do not count as unread or as mentions for ann; cat\'s do', async () => {
    // ann looks away (her read marker stays where it is), then both of them mention her.
    const seen = once(sock.cat, 'message', (m) => m.text === '@ann from cat');
    sock.ben.emit('message', { serverId: crewId, channelId: generalId, text: '@ann from ben' });
    await once(sock.cat, 'message', (m) => m.text === '@ann from ben');
    sock.cat.emit('message', { serverId: crewId, channelId: generalId, text: '@ann from cat' });
    await seen;
    const ann = (await call('GET', '/unreads', undefined, tok.ann)).data;
    assert.equal(ann.unreads[crewId][generalId], 1, 'only cat\'s message is unread');
    assert.equal(ann.mentions[crewId][generalId], 1, 'only cat\'s mention counts');
    // For cat, who blocked nobody, ben's messages count as they always did (two so far).
    const cat = (await call('GET', '/unreads', undefined, tok.cat)).data;
    assert.equal(cat.unreads[crewId][generalId], 2);
  });

  test('a mention from ben does not push ann\'s phone; one from cat does', async () => {
    const before = pushedTo(server).length;
    sock.ben.emit('message', { serverId: crewId, channelId: generalId, text: 'hey @ann and @cat look' });
    // cat is named in the same message and has blocked nobody: her push is the proof the message
    // went through the push path at all.
    await waitFor(() => pushedTo(server).slice(before).includes('cat-phone'), 'cat\'s push');
    await sleep(200);
    assert.ok(!pushedTo(server).slice(before).includes('ann-phone'));

    const mid = pushedTo(server).length;
    sock.cat.emit('message', { serverId: crewId, channelId: generalId, text: 'hey @ann' });
    await waitFor(() => pushedTo(server).slice(mid).includes('ann-phone'), 'ann\'s push from cat');
  });

  test('search does not return ben\'s messages to ann; cat finds them', async () => {
    for (const scope of [`scope=channel&serverId=${crewId}&channelId=${generalId}`, `scope=server&serverId=${crewId}`, 'scope=all']) {
      const ann = await call('GET', `/search?q=needle&${scope}`, undefined, tok.ann);
      assert.equal(ann.status, 200);
      assert.deepEqual(ann.data.results.map((r) => r.message.text), ['needle two'], scope);
    }
    const cat = await call('GET', '/search?q=needle&scope=all', undefined, tok.cat);
    assert.deepEqual(cat.data.results.map((r) => r.message.text).sort(), ['needle one', 'needle two']);
  });

  test('ben typing in the channel is shown to cat and not to ann', async () => {
    const ben = await connect(server.base, tok.ben); // a fresh connection: typing is throttled per socket
    try {
      const shown = once(sock.cat, 'typing', (p) => p.scope === 'channel' && p.from === 'ben');
      const hidden = never(sock.ann, 'typing');
      ben.emit('typing', { scope: 'channel', serverId: crewId, channelId: generalId });
      await shown;
      assert.ok(await hidden);
    } finally { ben.close(); }
  });

  test('the group carries on: ben\'s message is marked for ann, and raises nothing for her', async () => {
    const before = pushedTo(server).length;
    const forAnn = once(sock.ann, 'group:message', (p) => p.groupId === groupId);
    const forCat = once(sock.cat, 'group:message', (p) => p.groupId === groupId);
    const posted = await call('POST', `/groups/${groupId}/messages`, { text: 'needle in the group' }, tok.ben);
    assert.equal(posted.status, 200);
    assert.ok(!('blocked' in posted.data.message));
    assert.equal((await forAnn).message.blocked, true);
    assert.ok(!('blocked' in (await forCat).message));

    // cat is pushed for it; ann is not.
    await waitFor(() => pushedTo(server).slice(before).includes('cat-phone'), 'cat\'s group push');
    await sleep(200);
    assert.ok(!pushedTo(server).slice(before).includes('ann-phone'));

    // ann's conversation list: no unread count for it, and it is not the preview.
    const annGroup = (await call('GET', '/groups', undefined, tok.ann)).data.groups.find((g) => g.id === groupId);
    assert.equal(annGroup.unreadCount, 0);
    assert.equal(annGroup.lastMessage, null);
    const catGroup = (await call('GET', '/groups', undefined, tok.cat)).data.groups.find((g) => g.id === groupId);
    assert.equal(catGroup.unreadCount, 1);
    assert.equal(catGroup.lastMessage.text, 'needle in the group');

    // History: marked for ann, plain for cat.
    assert.deepEqual((await call('GET', `/groups/${groupId}/messages`, undefined, tok.ann)).data.messages.map((m) => m.blocked === true), [true]);
    assert.ok((await call('GET', `/groups/${groupId}/messages`, undefined, tok.cat)).data.messages.every((m) => !('blocked' in m)));

    // Search: not for ann.
    assert.deepEqual((await call('GET', `/search?q=needle&scope=group&groupId=${groupId}`, undefined, tok.ann)).data.results, []);
    assert.equal((await call('GET', `/search?q=needle&scope=group&groupId=${groupId}`, undefined, tok.cat)).data.results.length, 1);
  });

  test('ben typing in the group is shown to cat and not to ann', async () => {
    const ben = await connect(server.base, tok.ben);
    try {
      const shown = once(sock.cat, 'typing', (p) => p.scope === 'group' && p.from === 'ben');
      const hidden = never(sock.ann, 'typing');
      ben.emit('typing', { scope: 'group', groupId });
      await shown;
      assert.ok(await hidden);
    } finally { ben.close(); }
  });

  test('none of it is told to ben: his own views of the channel and the group are unchanged', async () => {
    const page = (await channelMessages(tok.ben)).data.messages;
    assert.ok(page.length >= 4);
    assert.ok(page.every((m) => !('blocked' in m)));
    const group = (await call('GET', '/groups', undefined, tok.ben)).data.groups.find((g) => g.id === groupId);
    assert.deepEqual(group.members.map((m) => m.name).sort(), ['ann', 'ben', 'cat']);
    assert.deepEqual((await call('GET', '/blocks', undefined, tok.ben)).data.blocks, []);
  });

  test('once unblocked, ben\'s messages arrive unmarked and count again', async () => {
    assert.equal((await call('DELETE', '/blocks/ben', undefined, tok.ann)).status, 200);
    const got = once(sock.ann, 'message', (m) => m.text === 'after the block');
    const nudged = once(sock.ann, 'unread:bump', (b) => b.author === 'ben');
    sock.ben.emit('message', { serverId: crewId, channelId: generalId, text: 'after the block' });
    assert.ok(!('blocked' in (await got)));
    await nudged;
    assert.ok((await channelMessages(tok.ann)).data.messages.every((m) => !('blocked' in m)), 'the old ones are unmarked too');
  });
});

describe('added to a server by someone you blocked', () => {
  // ben runs a server and is blocked by ann. Refusing to let him add her would tell him about the
  // block, so the add goes through as it would for anyone; it is the "you were added" alert that
  // she is spared. cat, whom she has not blocked, is the control.
  let server, call;
  const tok = {};
  const sock = {};
  const serverNames = async (token) => (await call('GET', '/servers', undefined, token)).data.servers.map((s) => s.name).sort();

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['ann', 'ben', 'cat', 'dee']) tok[name] = await makeUser(server.base, name);
    assert.equal((await call('POST', '/blocks/ben', undefined, tok.ann)).status, 200);
    for (const name of ['ann', 'ben']) sock[name] = await connect(server.base, tok[name]);
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server.stop();
  });

  test('ben\'s add goes through and is answered as any add is; ann\'s list updates, with no alert', async () => {
    const bensId = (await call('POST', '/servers', { name: 'Bens Place' }, tok.ben)).data.server.id;
    const listRefreshed = once(sock.ann, 'servers:updated');
    const noAlert = never(sock.ann, 'server:invited');
    const res = await call('POST', `/servers/${bensId}/invite`, { username: 'ann' }, tok.ben);
    // The same answer cat gets below for an account that has blocked nobody.
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { success: true });
    await listRefreshed;
    assert.ok(await noAlert, 'no "you were added" for an add by someone she blocked');
    assert.deepEqual(await serverNames(tok.ann), ['Bens Place']);
    const roster = (await call('GET', `/servers/${bensId}/members`, undefined, tok.ben)).data.members.map((m) => m.username).sort();
    assert.deepEqual(roster, ['ann', 'ben'], 'ben sees her added, as he would anyone');
    // She can walk out again.
    assert.equal((await call('POST', `/servers/${bensId}/leave`, undefined, tok.ann)).status, 200);
    assert.deepEqual(await serverNames(tok.ann), []);
  });

  test('the same holds when he is an admin of someone else\'s server', async () => {
    const deesId = (await call('POST', '/servers', { name: 'Dees Den' }, tok.dee)).data.server.id;
    assert.equal((await call('POST', `/servers/${deesId}/invite`, { username: 'ben' }, tok.dee)).status, 200);
    assert.equal((await call('PATCH', `/servers/${deesId}/members/ben`, { role: 'admin' }, tok.dee)).status, 200);
    const listRefreshed = once(sock.ann, 'servers:updated');
    const noAlert = never(sock.ann, 'server:invited');
    assert.equal((await call('POST', `/servers/${deesId}/invite`, { username: 'ann' }, tok.ben)).status, 200);
    await listRefreshed;
    assert.ok(await noAlert);
    assert.deepEqual(await serverNames(tok.ann), ['Dees Den']);
  });

  test('an add by someone she has not blocked still alerts her, naming who did it', async () => {
    const catsId = (await call('POST', '/servers', { name: 'Cats Corner' }, tok.cat)).data.server.id;
    const alert = once(sock.ann, 'server:invited');
    const res = await call('POST', `/servers/${catsId}/invite`, { username: 'ann' }, tok.cat);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { success: true });
    assert.deepEqual(await alert, { serverId: catsId, name: 'Cats Corner', by: 'cat' });
  });

  test('the block is one way: ann adding ben to her server still alerts him', async () => {
    const annsId = (await call('POST', '/servers', { name: 'Anns Attic' }, tok.ann)).data.server.id;
    const alert = once(sock.ben, 'server:invited');
    assert.equal((await call('POST', `/servers/${annsId}/invite`, { username: 'ben' }, tok.ann)).status, 200);
    assert.equal((await alert).by, 'ann');
  });

  test('once unblocked, his adds alert her again', async () => {
    assert.equal((await call('DELETE', '/blocks/ben', undefined, tok.ann)).status, 200);
    const bensId = (await call('POST', '/servers', { name: 'Bens Second' }, tok.ben)).data.server.id;
    const alert = once(sock.ann, 'server:invited');
    assert.equal((await call('POST', `/servers/${bensId}/invite`, { username: 'ann' }, tok.ben)).status, 200);
    assert.equal((await alert).by, 'ben');
  });
});
