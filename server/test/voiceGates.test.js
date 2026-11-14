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
  let server, call, base, ownerToken, outsiderToken, privateServerId, voiceId;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    ownerToken = await makeUser(call, 'owner');
    outsiderToken = await makeUser(call, 'outsider');
    const made = await call('POST', '/servers', { name: 'Private Lounge' }, ownerToken);
    privateServerId = made.data.server.id;
    // Outside the commons a voice room is a channel of the server, so the tests need a real one.
    const ch = await call('POST', `/servers/${privateServerId}/channels`, { name: 'Lounge', type: 'voice' }, ownerToken);
    voiceId = ch.data.channel.id;
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
      sock.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
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
      owner.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
      await new Promise((r) => setTimeout(r, 300));

      const broadcast = notWithin(owner, 'activity:update', 1500);
      outsider.emit('activity:start', { serverId: privateServerId, channelId: voiceId, type: 'whiteboard' });
      assert.equal(await broadcast, null, 'no activity is started by a non-member');
    } finally { outsider.close(); owner.close(); }
  });

  test('sfu:caps answers null for a server the socket does not belong to', async () => {
    const outsider = await connect(base, outsiderToken);
    try {
      const answer = await request(outsider, 'sfu:caps', { serverId: privateServerId, channelId: voiceId });
      // null = "use the mesh"; it must not hand back router capabilities for someone else's room.
      assert.equal(answer, null);
    } finally { outsider.close(); }
  });

  // Being a member of the server was all the door asked about, so a private voice channel could be
  // joined by any member who knew its id — and a member who was kicked stayed in the call.
  describe('voice rooms follow channel access', () => {
    let memberToken, listedToken, privId;
    const enter = async (token, channelId) => {
      const sock = await connect(base, token);
      const peers = once(sock, 'voice:peers');
      sock.emit('voice:join', { serverId: privateServerId, channelId });
      return { sock, peers: await peers };
    };

    before(async () => {
      memberToken = await makeUser(call, 'member');
      listedToken = await makeUser(call, 'listed');
      for (const username of ['member', 'listed']) await call('POST', `/servers/${privateServerId}/invite`, { username }, ownerToken);
      const ch = await call('POST', `/servers/${privateServerId}/channels`, { name: 'Officers', type: 'voice', privacy: 'private', members: ['listed'] }, ownerToken);
      privId = ch.data.channel.id;
    });

    test('a member who is not on a private voice channel\'s list is refused at its door', async () => {
      const inside = await enter(listedToken, privId);
      const sock = await connect(base, memberToken);
      try {
        const refused = once(sock, 'voice:removed');
        const peers = notWithin(sock, 'voice:peers', 800);
        const heard = notWithin(inside.sock, 'voice:peer-joined', 800);
        sock.emit('voice:join', { serverId: privateServerId, channelId: privId });
        assert.deepEqual(await refused, { serverId: privateServerId, channelId: privId });
        assert.equal(await peers, null, 'no roster of who is in there');
        assert.equal(await heard, null, 'and nobody inside is told someone joined');
      } finally { sock.close(); inside.sock.close(); }
    });

    test('a voice room that is no channel of the server cannot be joined; the commons still takes any name', async () => {
      const sock = await connect(base, memberToken);
      try {
        const refused = once(sock, 'voice:removed');
        sock.emit('voice:join', { serverId: privateServerId, channelId: 'voice1' });
        assert.deepEqual(await refused, { serverId: privateServerId, channelId: 'voice1' });
        const peers = once(sock, 'voice:peers');
        sock.emit('voice:join', { serverId: 'demo', channelId: 'any-name-at-all' });
        assert.ok(Array.isArray(await peers));
      } finally { sock.close(); }
    });

    test('taken off the list while in the call: out of the room, and the others are told', async () => {
      const staying = await enter(ownerToken, privId);
      const leaving = await enter(listedToken, privId);
      try {
        const removed = once(leaving.sock, 'voice:removed');
        const gone = once(staying.sock, 'voice:peer-left');
        const res = await call('DELETE', `/servers/${privateServerId}/channels/${privId}/members/listed`, undefined, ownerToken);
        assert.equal(res.status, 200);
        assert.deepEqual(await removed, { serverId: privateServerId, channelId: privId });
        assert.deepEqual(await gone, { id: leaving.sock.id });
        // Really out, not just told: someone arriving now is not given that socket as a peer.
        const late = await enter(ownerToken, privId);
        assert.ok(!late.peers.some((p) => p.id === leaving.sock.id));
        late.sock.close();
      } finally { staying.sock.close(); leaving.sock.close(); }
    });

    test('kicked from the server while in a call: out of every voice room in it', async () => {
      const staying = await enter(ownerToken, voiceId);
      const kicked = await enter(memberToken, voiceId);
      try {
        const removed = once(kicked.sock, 'voice:removed');
        const gone = once(staying.sock, 'voice:peer-left');
        const res = await call('DELETE', `/servers/${privateServerId}/members/member`, undefined, ownerToken);
        assert.equal(res.status, 200);
        assert.deepEqual(await removed, { serverId: privateServerId, channelId: voiceId });
        assert.deepEqual(await gone, { id: kicked.sock.id });
        // And cannot walk back in.
        const denied = once(kicked.sock, 'server:denied');
        kicked.sock.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
        assert.equal((await denied).serverId, privateServerId);
      } finally { staying.sock.close(); kicked.sock.close(); }
    });
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
