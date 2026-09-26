// Editing a message used to change it only on the editor's own screen: nothing was saved, nobody else
// saw it, and it reverted on reload. These pin down the server side of real edits, for channel
// messages (socket `message:edit`) and direct messages (PATCH /messages/:id).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');

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

// Emit with an acknowledgement and wait for it.
const emitAck = (socket, event, payload) => new Promise((resolve, reject) => {
  socket.timeout(5000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
});

async function joinGeneral(socket, name) {
  const joined = once(socket, 'channel:joined');
  socket.emit('join', { serverId: 'demo', name });
  await joined;
}

async function send(sockFrom, sockTo, payload) {
  const delivered = once(sockTo, 'message', (m) => m.text === payload.text);
  sockFrom.emit('message', { serverId: 'demo', channelId: 'general', ...payload });
  return delivered;
}

describe('editing channel messages', () => {
  let server, call, sockA, sockB, annToken;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    annToken = await makeUser(call, 'ann');
    const benToken = await makeUser(call, 'ben');
    sockA = await connect(server.base, annToken);
    sockB = await connect(server.base, benToken);
    await joinGeneral(sockA, 'ann');
    await joinGeneral(sockB, 'ben');
  });
  after(async () => {
    for (const s of [sockA, sockB]) { try { s?.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('the author edits a message; everyone in the channel gets the new text', async () => {
    const msg = await send(sockA, sockB, { text: 'see you at 7' });
    assert.equal(msg.edited, false, 'a fresh message is not edited');

    const seenByBen = once(sockB, 'message:edited', (e) => e.id === msg.id);
    const res = await emitAck(sockA, 'message:edit', { id: msg.id, text: 'see you at 8' });
    assert.equal(res.ok, true);
    const edited = await seenByBen;
    assert.equal(edited.text, 'see you at 8');
    assert.ok(edited.editedAt > 0);
  });

  test('the edit is saved: history after a reconnect has the new text, marked edited', async () => {
    const fresh = await connect(server.base, annToken);
    try {
      const history = once(fresh, 'messages:init');
      fresh.emit('join', { serverId: 'demo', name: 'ann' });
      const init = await history;
      const m = init.messages.find((x) => x.text === 'see you at 8');
      assert.ok(m, 'the edited text should be in the stored history');
      assert.equal(m.edited, true);
      assert.ok(!init.messages.some((x) => x.text === 'see you at 7'), 'the old text should be gone');
    } finally { fresh.close(); }
  });

  test("someone else's message can't be edited", async () => {
    const msg = await send(sockA, sockB, { text: "ann's words" });
    const res = await emitAck(sockB, 'message:edit', { id: msg.id, text: 'ben rewrote this' });
    assert.deepEqual(res, { ok: false, error: 'not-author' });
  });

  test('an edit to empty text is refused', async () => {
    const msg = await send(sockA, sockB, { text: 'keep me' });
    const res = await emitAck(sockA, 'message:edit', { id: msg.id, text: '   ' });
    assert.deepEqual(res, { ok: false, error: 'empty' });
  });

  test('a message with an attachment is not editable', async () => {
    const msg = await send(sockA, sockB, { text: 'photo', attachment: { url: '/uploads/pic.png', name: 'pic.png', type: 'image/png', size: 1 } });
    const res = await emitAck(sockA, 'message:edit', { id: msg.id, text: 'caption' });
    assert.deepEqual(res, { ok: false, error: 'has-attachment' });
  });

  test('editing a message that does not exist is refused', async () => {
    const res = await emitAck(sockA, 'message:edit', { id: 999999, text: 'ghost' });
    assert.deepEqual(res, { ok: false, error: 'not-found' });
  });
});

describe('editing direct messages', () => {
  let server, call, aliceToken, bobToken, sockBob, messageId;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    aliceToken = await makeUser(call, 'alice');
    bobToken = await makeUser(call, 'bob');
    await call('POST', '/friends/request', { username: 'bob' }, aliceToken);
    const incoming = await call('GET', '/friends/requests/incoming', undefined, bobToken);
    await call('POST', `/friends/requests/${incoming.data.requests[0].id}/accept`, undefined, bobToken);
    const sent = await call('POST', '/messages/send', { toUsername: 'bob', text: 'lunch at noon?' }, aliceToken);
    messageId = sent.data.message.id;
    sockBob = await connect(server.base, bobToken);
  });
  after(async () => {
    try { sockBob?.close(); } catch (_) { /* already closed */ }
    await server.stop();
  });

  test('the sender edits; the recipient is told live', async () => {
    const live = once(sockBob, 'dm:message-edited', (e) => e.id === messageId);
    const res = await call('PATCH', `/messages/${messageId}`, { text: 'lunch at 1?' }, aliceToken);
    assert.equal(res.status, 200);
    assert.equal(res.data.text, 'lunch at 1?');
    const e = await live;
    assert.equal(e.text, 'lunch at 1?');
  });

  test('both sides see the saved edit, marked edited', async () => {
    for (const [token, peer] of [[aliceToken, 'bob'], [bobToken, 'alice']]) {
      const thread = await call('GET', `/messages/with/${peer}`, undefined, token);
      const m = thread.data.messages.find((x) => x.id === messageId);
      assert.equal(m.text, 'lunch at 1?');
      assert.equal(m.edited, true);
    }
  });

  test("the recipient can't edit the sender's message", async () => {
    const res = await call('PATCH', `/messages/${messageId}`, { text: 'bob was here' }, bobToken);
    assert.equal(res.status, 403);
  });

  test('empty text, unknown ids and anonymous calls are refused', async () => {
    assert.equal((await call('PATCH', `/messages/${messageId}`, { text: '  ' }, aliceToken)).status, 400);
    assert.equal((await call('PATCH', '/messages/999999', { text: 'x' }, aliceToken)).status, 404);
    assert.equal((await call('PATCH', `/messages/${messageId}`, { text: 'x' })).status, 401);
  });
});
