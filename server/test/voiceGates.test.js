// Membership gates on voice + activities. These were missing: text channels checked roleOf and
// answered server:denied, but voice:join / sfu:caps / activity:* did not, so any socket — including
// one that presented no token, since a bad token only leaves socketUser null rather than refusing the
// connection — could join `voice:<serverId>:<channelId>` by guessing the ids, read the participant
// list, and start or drive activities.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}
function notWithin(socket, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (p) => { clearTimeout(timer); resolve(p ?? true); });
  });
}
const request = (socket, event, payload) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve('__timeout__'), 5000);
  socket.emit(event, payload, (answer) => { clearTimeout(timer); resolve(answer); });
});
const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, ...(token ? { auth: { token } } : {}) });
  await once(socket, 'connect');
  return socket;
};

describe('voice + activity membership gates', () => {
  let server, call, base, ownerToken, outsiderToken, privateServerId;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    ownerToken = await makeUser(call, 'owner');
    outsiderToken = await makeUser(call, 'outsider');
    const made = await call('POST', '/servers', { name: 'Private Lounge' }, ownerToken);
    privateServerId = made.data.server.id;
  });
  after(async () => { await server.stop(); });

  test('a non-member cannot join a private server voice room', async () => {
    const sock = await connect(base, outsiderToken);
    try {
      const denied = once(sock, 'server:denied');
      const peers = notWithin(sock, 'voice:peers', 1500);
      sock.emit('voice:join', { serverId: privateServerId, channelId: 'voice1' });
      const payload = await denied;
      assert.equal(payload.serverId, privateServerId);
      assert.equal(await peers, null, 'never receives the participant list');
    } finally { sock.close(); }
  });

  test('a tokenless socket cannot join any voice room', async () => {
    // A missing/invalid token leaves socketUser null; roleOf(null) is null, so even the public
    // commons is closed to an unauthenticated socket.
    const anon = await connect(base);
    try {
      const denied = once(anon, 'server:denied');
      const peers = notWithin(anon, 'voice:peers', 1500);
      anon.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      await denied;
      assert.equal(await peers, null);
    } finally { anon.close(); }
  });

  test('the owner CAN join their own server, and anyone can use the public commons', async () => {
    const sock = await connect(base, ownerToken);
    try {
      const peers = once(sock, 'voice:peers');
      sock.emit('voice:join', { serverId: privateServerId, channelId: 'voice1' });
      assert.ok(Array.isArray(await peers), 'member gets the roster');
    } finally { sock.close(); }

    const member = await connect(base, outsiderToken);
    try {
      const peers = once(member, 'voice:peers');
      member.emit('voice:join', { serverId: 'demo', channelId: 'voice1' }); // demo = public commons
      assert.ok(Array.isArray(await peers), 'demo stays open to any signed-in user');
    } finally { member.close(); }
  });

  test('a non-member cannot start or drive an activity in a private server', async () => {
    const outsider = await connect(base, outsiderToken);
    const owner = await connect(base, ownerToken);
    try {
      // Owner is in the room and would receive any activity broadcast.
      owner.emit('voice:join', { serverId: privateServerId, channelId: 'voice1' });
      await new Promise((r) => setTimeout(r, 300));

      const broadcast = notWithin(owner, 'activity:update', 1500);
      outsider.emit('activity:start', { serverId: privateServerId, channelId: 'voice1', type: 'whiteboard' });
      assert.equal(await broadcast, null, 'no activity is started by a non-member');
    } finally { outsider.close(); owner.close(); }
  });

  test('sfu:caps answers null for a server the socket does not belong to', async () => {
    const outsider = await connect(base, outsiderToken);
    try {
      const answer = await request(outsider, 'sfu:caps', { serverId: privateServerId, channelId: 'voice1' });
      // null = "use the mesh"; it must not hand back router capabilities for someone else's room.
      assert.equal(answer, null);
    } finally { outsider.close(); }
  });
});

describe('rate limiting', () => {
  let server, call;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    await makeUser(call, 'target');
  });
  after(async () => { await server.stop(); });

  test('repeated bad logins eventually get 429 instead of unbounded bcrypt work', async () => {
    let sawLimited = false;
    let unauthorized = 0;
    for (let i = 0; i < 30; i++) {
      const res = await call('POST', '/auth/login', { username: 'target', password: 'wrong-password' });
      if (res.status === 429) { sawLimited = true; break; }
      if (res.status === 401 || res.status === 400) unauthorized++;
    }
    assert.ok(unauthorized > 0, 'wrong passwords are rejected');
    assert.ok(sawLimited, 'the limiter kicks in before 30 attempts');
  });

  test('a good login still works within the limit', async () => {
    // Fresh server = fresh counters, proving the limiter does not lock out legitimate use.
    const s2 = await startServer();
    try {
      const c2 = apiFor(s2.base);
      const token = await makeUser(c2, 'legit'); // makeUser logs in
      assert.ok(token, 'normal sign-in is unaffected');
    } finally { await s2.stop(); }
  });
});
