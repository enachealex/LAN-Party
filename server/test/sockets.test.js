// Smoke test for the realtime layer. The socket handlers are where the extracted activity and
// message helpers are actually wired up, so this catches a broken require/scope after refactoring
// in a way the HTTP tests can't.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');

// Resolve on the next event satisfying `match`, or reject so a hang fails fast instead of stalling
// the suite. The predicate matters because some events are sent speculatively — voice:join hands the
// joiner an `activity:update` of null before any activity exists.
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
const nonNull = (v) => v != null;

// The server reads its JWT from the handshake; connecting anonymously gets you `server:denied`.
const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

describe('realtime', () => {
  let server, call, sockA, sockB;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    const annToken = await makeUser(call, 'ann');
    const benToken = await makeUser(call, 'ben');
    sockA = await connect(server.base, annToken);
    sockB = await connect(server.base, benToken);
  });

  after(async () => {
    for (const s of [sockA, sockB]) { try { s?.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('joining the demo server lands you in a channel with its history', async () => {
    const joined = once(sockA, 'channel:joined');
    const history = once(sockA, 'messages:init');
    sockA.emit('join', { serverId: 'demo', name: 'ann' });
    const [ch, init] = await Promise.all([joined, history]);
    assert.equal(ch.serverId, 'demo');
    assert.equal(ch.channelId, 'general', 'should land in the first text channel');
    assert.ok(Array.isArray(init.messages), 'history should be an array');
  });

  test('a message sent by one client reaches the other', async () => {
    sockB.emit('join', { serverId: 'demo', name: 'ben' });
    await once(sockB, 'channel:joined');
    sockA.emit('joinChannel', { serverId: 'demo', channelId: 'general' });
    sockB.emit('joinChannel', { serverId: 'demo', channelId: 'general' });
    await once(sockB, 'messages:init');

    const delivered = once(sockB, 'message');
    sockA.emit('message', { serverId: 'demo', channelId: 'general', text: 'anyone up for a round?' });
    const msg = await delivered;

    assert.equal(msg.text, 'anyone up for a round?');
    assert.equal(msg.author, 'ann');
    assert.ok(msg.id, 'delivered message should carry an id');
    assert.ok(msg.ts, 'delivered message should carry a timestamp');
  });

  test('starting an activity broadcasts its initial state to the voice room', async () => {
    // Activities live in the voice room (`voice:<server>:<channel>`), joined via voice:join.
    for (const s of [sockA, sockB]) {
      const peers = once(s, 'voice:peers');
      s.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      await peers;
    }

    const update = once(sockB, 'activity:update', nonNull);
    sockA.emit('activity:start', { serverId: 'demo', channelId: 'voice1', type: 'ttt' });
    const act = await update;
    assert.ok(act, 'expected an activity payload');
    assert.equal(act.type, 'ttt');
    assert.equal(act.state.board.length, 9, 'tic-tac-toe should start with an empty 9-cell board');
  });

  test('a late joiner is handed the activity already in progress', async () => {
    const annToken = await makeUser(call, 'cara');
    const late = await connect(server.base, annToken);
    try {
      const update = once(late, 'activity:update', nonNull);
      late.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      const act = await update;
      assert.equal(act.type, 'ttt', 'should receive the in-progress tic-tac-toe game');
    } finally {
      late.close();
    }
  });

  test('an unknown channel is rejected rather than silently dropped', async () => {
    const rejected = once(sockA, 'message:error');
    sockA.emit('message', { serverId: 'demo', channelId: 'does-not-exist', text: 'lost message' });
    const err = await rejected;
    assert.equal(err.reason, 'unknown-channel');
    assert.equal(err.text, 'lost message', 'the text is echoed back so the client can recover it');
  });
});
