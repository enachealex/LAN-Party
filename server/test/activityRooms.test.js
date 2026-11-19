// Several activities in one voice room. Starting one opens it for its starter only; everyone else in
// the call is told what is running (activity:list) and may open any of it (activity:join), leave it
// (activity:leave) or end the one they are in (activity:stop). Each activity's state goes to the
// people in it and nobody else.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const ofType = (type) => (v) => v != null && v.type === type;

describe('several activities in one voice room', () => {
  let server, base, tokens;
  /** @type {any[]} */
  const open = [];

  // Connected, on the demo server, and (with a channelId) in that voice room. Records every
  // activity:update and the last activity:list it was sent.
  async function enter(name, channelId) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[name] } });
    open.push(socket);
    await once(socket, 'connect');
    socket.updates = [];
    socket.running = null;
    socket.on('activity:update', (a) => { socket.updates.push(a); socket.act = a; });
    socket.on('activity:list', (l) => { socket.running = l; });
    const joined = once(socket, 'channel:joined');
    socket.emit('join', { serverId: 'demo', name });
    await joined;
    if (channelId) {
      const peers = once(socket, 'voice:peers');
      socket.emit('voice:join', { serverId: 'demo', channelId });
      await peers;
    }
    return socket;
  }
  const start = async (socket, channelId, type) => {
    const opened = once(socket, 'activity:update', ofType(type));
    socket.emit('activity:start', { serverId: 'demo', channelId, type });
    return opened;
  };
  const join = (socket, channelId, id) => {
    const opened = once(socket, 'activity:update', (v) => v != null && v.id === id);
    socket.emit('activity:join', { serverId: 'demo', channelId, id });
    return opened;
  };
  const event = (socket, channelId, ev) => socket.emit('activity:event', { serverId: 'demo', channelId, event: ev });
  // Resolves once this socket's list of what is running satisfies `match`.
  const listed = async (socket, match) => {
    if (socket.running && match(socket.running)) return socket.running;
    return once(socket, 'activity:list', match);
  };
  const rowOf = (list, id) => list.find((a) => a.id === id);

  before(async () => {
    server = await startServer();
    base = server.base;
    const call = apiFor(base);
    tokens = {};
    for (const name of ['ann', 'ben', 'cara', 'dana']) tokens[name] = await makeUser(call, name);
  });
  after(async () => {
    for (const s of open) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('two people start different activities in the same room, and neither is sent the other\'s state', async () => {
    const room = 'm-two';
    const ann = await enter('ann', room);
    const ben = await enter('ben', room);
    const ttt = await start(ann, room, 'ttt');
    const poll = await start(ben, room, 'poll');
    assert.notEqual(ttt.id, poll.id);

    // Both are running, each with its own starter in it, and both people are told so.
    for (const s of [ann, ben]) {
      const list = await listed(s, (l) => l.length === 2);
      assert.deepEqual(rowOf(list, ttt.id).people, ['ann']);
      assert.deepEqual(rowOf(list, poll.id).people, ['ben']);
      assert.ok(list.every((a) => !('state' in a)), 'the list never carries an activity\'s state');
    }

    // Each plays their own; the other hears nothing of it.
    const seated = once(ann, 'activity:update', (v) => ofType('ttt')(v) && v.state.players.X === 'ann');
    event(ann, room, { kind: 'join' });
    await seated;
    const created = once(ben, 'activity:update', (v) => ofType('poll')(v) && v.state.question === 'Pizza?');
    event(ben, room, { kind: 'create', question: 'Pizza?', options: ['yes', 'no'] });
    await created;
    await sleep(150);
    assert.ok(ann.updates.filter(Boolean).every((u) => u.type === 'ttt'), 'ann was only ever sent tic-tac-toe');
    assert.ok(ben.updates.filter(Boolean).every((u) => u.type === 'poll'), 'ben was only ever sent the poll');
    assert.equal(ann.act.id, ttt.id);
    assert.equal(ben.act.id, poll.id);
  });

  test('a third person can open either one and is given that one\'s state, and only while in it', async () => {
    const room = 'm-third';
    const ann = await enter('ann', room);
    const ben = await enter('ben', room);
    const cara = await enter('cara', room);
    const ttt = await start(ann, room, 'ttt');
    const poll = await start(ben, room, 'poll');
    const seated = once(ann, 'activity:update', (v) => ofType('ttt')(v) && v.state.players.X === 'ann');
    event(ann, room, { kind: 'join' });
    await seated;
    const created = once(ben, 'activity:update', (v) => ofType('poll')(v) && v.state.question === 'Tea?');
    event(ben, room, { kind: 'create', question: 'Tea?', options: ['yes', 'no'] });
    await created;
    await listed(cara, (l) => l.length === 2);
    assert.deepEqual(cara.updates.filter(Boolean), [], 'nothing opened for her by itself');

    const inTtt = await join(cara, room, ttt.id);
    assert.equal(inTtt.type, 'ttt');
    assert.deepEqual(inTtt.state.players, { X: 'ann' }, 'the game as it stands');
    assert.deepEqual(rowOf(await listed(ben, (l) => rowOf(l, ttt.id)?.people.length === 2), ttt.id).people, ['ann', 'cara']);

    // Moving to the poll takes her out of the game: its updates stop reaching her.
    const inPoll = await join(cara, room, poll.id);
    assert.equal(inPoll.type, 'poll');
    assert.equal(inPoll.state.question, 'Tea?');
    const list = await listed(ann, (l) => rowOf(l, poll.id)?.people.length === 2);
    assert.deepEqual(rowOf(list, ttt.id).people, ['ann']);
    assert.deepEqual(rowOf(list, poll.id).people, ['ben', 'cara']);
    const seen = cara.updates.length;
    const ben2 = once(ben, 'activity:update', (v) => ofType('poll')(v) && v.state.question === 'Coffee?');
    event(ben, room, { kind: 'create', question: 'Coffee?', options: ['yes', 'no'] });
    await ben2;
    const annMoved = once(ann, 'activity:update', (v) => ofType('ttt')(v) && v.state.board[0] === 'X');
    event(ann, room, { kind: 'move', i: 0 });
    await annMoved;
    await sleep(150);
    const since = cara.updates.slice(seen);
    assert.ok(since.length >= 1 && since.every((u) => u.type === 'poll'), 'she gets the poll\'s updates and not the game\'s');
  });

  test('activity:leave returns the leaver to the call; it goes on for the rest, and ends with the last one out', async () => {
    const room = 'm-leave';
    const ann = await enter('ann', room);
    const ben = await enter('ben', room);
    const ttt = await start(ann, room, 'ttt');
    await join(ben, room, ttt.id);

    const benOut = once(ben, 'activity:update', (v) => v === null);
    ben.emit('activity:leave');
    await benOut;
    let list = await listed(ann, (l) => rowOf(l, ttt.id)?.people.length === 1);
    assert.deepEqual(rowOf(list, ttt.id).people, ['ann'], 'still running, for ann');
    // It still works for her, and he is no longer sent it.
    const seen = ben.updates.length;
    const seated = once(ann, 'activity:update', (v) => ofType('ttt')(v) && v.state.players.X === 'ann');
    event(ann, room, { kind: 'join' });
    await seated;
    await sleep(150);
    assert.equal(ben.updates.length, seen, 'the leaver is sent nothing more');
    // Neither can he drive it from outside.
    event(ben, room, { kind: 'join' });
    await sleep(150);
    assert.deepEqual(ann.act.state.players, { X: 'ann' });

    const annOut = once(ann, 'activity:update', (v) => v === null);
    ann.emit('activity:leave');
    await annOut;
    list = await listed(ben, (l) => !rowOf(l, ttt.id));
    assert.deepEqual(list, [], 'with nobody left in it, it is gone from the list');
    // And it cannot be opened any more.
    const after = ben.updates.length;
    ben.emit('activity:join', { serverId: 'demo', channelId: room, id: ttt.id });
    await sleep(200);
    assert.equal(ben.updates.length, after);
  });

  test('activity:stop ends the activity its sender is in, for everyone in it, and no other', async () => {
    const room = 'm-stop';
    const ann = await enter('ann', room);
    const ben = await enter('ben', room);
    const cara = await enter('cara', room);
    const ttt = await start(ann, room, 'ttt');
    const poll = await start(ben, room, 'poll');
    await join(cara, room, poll.id);

    const annSeen = ann.updates.length;
    const ended = [once(ben, 'activity:update', (v) => v === null), once(cara, 'activity:update', (v) => v === null)];
    ben.emit('activity:stop', { serverId: 'demo', channelId: room });
    await Promise.all(ended);
    const list = await listed(ann, (l) => !rowOf(l, poll.id));
    assert.deepEqual(list.map((a) => a.id), [ttt.id], 'the other activity is still running');
    await sleep(150);
    assert.deepEqual(ann.updates.slice(annSeen), [], 'ann was sent no ending, nor anything else');
    assert.equal(ann.act.id, ttt.id, 'and is still in her game');
    const seated = once(ann, 'activity:update', (v) => ofType('ttt')(v) && v.state.players.X === 'ann');
    event(ann, room, { kind: 'join' });
    await seated;
  });

  test('someone not in the voice room cannot start, open or drive an activity there', async () => {
    const room = 'm-outside';
    const ann = await enter('ann', room);
    const dana = await enter('dana'); // a member of the server, not in this call
    const ttt = await start(ann, room, 'ttt');

    dana.emit('activity:start', { serverId: 'demo', channelId: room, type: 'poll' });
    dana.emit('activity:join', { serverId: 'demo', channelId: room, id: ttt.id });
    event(dana, room, { kind: 'join' });
    dana.emit('activity:stop', { serverId: 'demo', channelId: room });
    await sleep(400);
    assert.deepEqual(dana.updates, [], 'she was shown nothing');
    assert.equal(dana.running, null, 'not even what is running');
    assert.deepEqual(ann.running.map((a) => [a.id, a.people]), [[ttt.id, ['ann']]], 'nothing was started, and nobody joined');
    assert.equal(ann.act.id, ttt.id);
    assert.deepEqual(ann.act.state.players, {}, 'and nobody took a seat');
  });
});
