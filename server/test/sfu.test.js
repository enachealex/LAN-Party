// SFU signaling tests. A real media exchange needs a browser WebRTC stack, so these cover what Node
// can prove: the capability probe, transport provisioning (a real mediasoup worker spawns), the
// producer catalogue, and that leaving a room releases SFU state. DTLS/media flow is verified
// manually in the browser.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, sfuEnv, apiFor, makeUser } = require('./helpers');

function once(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

// socket.io ack as a promise.
function request(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for "${event}"`)), 8000);
    socket.emit(event, payload, (answer) => { clearTimeout(timer); resolve(answer); });
  });
}

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

describe('sfu signaling', () => {
  let server, call, sock;

  before(async () => {
    server = await startServer({ env: await sfuEnv() });
    call = apiFor(server.base);
    const token = await makeUser(call, 'sfuuser');
    sock = await connect(server.base, token);
  });
  after(async () => { try { sock?.close() } catch (_) {} await server.stop(); });

  test('sfu:caps answers null outside a voice room', async () => {
    const caps = await request(sock, 'sfu:caps', {});
    assert.equal(caps, null, 'not in a voice room -> mesh');
  });

  test('sfu:caps returns router capabilities inside a voice room', async () => {
    const peers = once(sock, 'voice:peers');
    sock.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
    await peers;
    const caps = await request(sock, 'sfu:caps', {});
    if (caps === null) {
      // Platform without a usable mediasoup worker — the designed fallback. Nothing more to test.
      console.log('  (sfu unavailable on this platform; fallback verified)');
      return;
    }
    assert.ok(caps.routerRtpCapabilities, 'expected router rtp capabilities');
    const mimes = caps.routerRtpCapabilities.codecs.map((c) => c.mimeType.toLowerCase());
    assert.ok(mimes.includes('audio/opus'), 'opus offered');
    assert.ok(mimes.includes('video/vp8'), 'vp8 offered');
  });

  test('provisions a WebRTC transport with ICE + DTLS parameters', async () => {
    const caps = await request(sock, 'sfu:caps', {});
    if (caps === null) return; // platform fallback, covered above
    const t = await request(sock, 'sfu:create-transport', {});
    assert.ok(t.id, 'transport id');
    assert.ok(t.iceParameters?.usernameFragment, 'ice params');
    assert.ok(Array.isArray(t.iceCandidates) && t.iceCandidates.length > 0, 'ice candidates');
    assert.ok(t.dtlsParameters?.fingerprints?.length > 0, 'dtls fingerprints');
  });

  test('producer catalogue starts empty and unknown transports are rejected', async () => {
    const caps = await request(sock, 'sfu:caps', {});
    if (caps === null) return;
    assert.deepEqual(await request(sock, 'sfu:producers', {}), []);
    const bad = await request(sock, 'sfu:consume', { transportId: 'nope', producerId: 'nope', rtpCapabilities: caps.routerRtpCapabilities });
    assert.ok(bad.error, 'consuming via an unknown transport should fail');
  });

  test('leaving the voice room releases SFU state', async () => {
    const caps = await request(sock, 'sfu:caps', {});
    if (caps === null) return;
    sock.emit('voice:leave', { serverId: 'demo', channelId: 'voice1' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await request(sock, 'sfu:caps', {}), null, 'no longer in a room -> mesh answer');
  });
});

// The reason no call ever used the SFU. A client sends voice:join and its first SFU request back to
// back. The join reads the database before the socket enters the room, so the request behind it was
// handled first, found no room, and was told "sfu unavailable" — after which the client fell back
// to the mesh. Every time.
describe('sfu requests sent right behind voice:join', () => {
  let server, call, token, outsiderToken, privateServerId, voiceId, usable;

  before(async () => {
    server = await startServer({ env: await sfuEnv() });
    call = apiFor(server.base);
    token = await makeUser(call, 'racer');
    outsiderToken = await makeUser(call, 'outsider');
    const made = await call('POST', '/servers', { name: 'Race Track' }, token);
    privateServerId = made.data.server.id;
    const ch = await call('POST', `/servers/${privateServerId}/channels`, { name: 'Pit', type: 'voice' }, token);
    voiceId = ch.data.channel.id;
    // A platform without a usable mediasoup worker answers null here, and there is no SFU to race for.
    const probe = await connect(server.base, token);
    usable = (await request(probe, 'sfu:caps', { serverId: 'demo', channelId: 'voice1' })) !== null;
    probe.close();
    if (!usable) console.log('  (sfu unavailable on this platform; race tests skipped)');
  });
  after(async () => { await server.stop(); });

  test('voice:join and sfu:create-transport back to back: the transport is provisioned', async () => {
    if (!usable) return;
    // A real server with a real channel: the join then reads the database twice, which is the
    // window the SFU request used to fall into.
    const sock = await connect(server.base, token);
    try {
      const peers = once(sock, 'voice:peers');
      sock.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
      const t = await request(sock, 'sfu:create-transport', { direction: 'send' });
      assert.equal(t.error, undefined, `expected a transport, got: ${t.error}`);
      assert.ok(t.id, 'transport id');
      assert.ok(t.iceParameters?.usernameFragment, 'ice params');
      assert.ok(Array.isArray(t.iceCandidates) && t.iceCandidates.length > 0, 'ice candidates');
      assert.ok(Array.isArray(await peers), 'and the join itself went through');
    } finally { sock.close(); }
  });

  test('everything a client sends behind the join is answered as a member of the room', async () => {
    if (!usable) return;
    const sock = await connect(server.base, token);
    try {
      sock.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
      // What a client does next, all of it written before the join has been decided.
      const send = request(sock, 'sfu:create-transport', { direction: 'send' });
      const recv = request(sock, 'sfu:create-transport', { direction: 'recv' });
      const producers = request(sock, 'sfu:producers', {});
      const caps = request(sock, 'sfu:caps', {});
      assert.ok((await send).id);
      assert.ok((await recv).id);
      assert.notEqual((await send).id, (await recv).id);
      assert.deepEqual(await producers, []);
      assert.ok((await caps)?.routerRtpCapabilities, 'caps with no room named are answered for the room being joined');
    } finally { sock.close(); }
  });

  test('a refused join: the SFU request behind it fails cleanly, and promptly', async () => {
    if (!usable) return;
    const sock = await connect(server.base, outsiderToken);
    try {
      const denied = once(sock, 'server:denied');
      const started = Date.now();
      sock.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
      const t = await request(sock, 'sfu:create-transport', { direction: 'send' });
      assert.deepEqual(t, { error: 'sfu unavailable' });
      assert.ok(Date.now() - started < 3000, 'it does not wait out a timeout for a join that was refused');
      assert.equal((await denied).serverId, privateServerId);
      // And the socket is not left stuck: a join it IS allowed still works, with its transport.
      sock.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      assert.ok((await request(sock, 'sfu:create-transport', {})).id);
    } finally { sock.close(); }
  });

  test('a leave sent right behind the join really leaves', async () => {
    const sock = await connect(server.base, token);
    const watcher = await connect(server.base, token);
    try {
      sock.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
      sock.emit('voice:leave', { serverId: privateServerId, channelId: voiceId });
      await new Promise((r) => setTimeout(r, 400));
      const peers = once(watcher, 'voice:peers');
      watcher.emit('voice:join', { serverId: privateServerId, channelId: voiceId });
      assert.deepEqual(await peers, [], 'the first socket is not sitting in a room its client left');
    } finally { sock.close(); watcher.close(); }
  });
});

// "Check connection": a transport outside any call, on one protocol, for a browser to connect to.
describe('sfu connection check', () => {
  let server, call, token, usable;

  before(async () => {
    server = await startServer({ env: await sfuEnv() });
    call = apiFor(server.base);
    token = await makeUser(call, 'checker');
    const probe = await connect(server.base, token);
    usable = (await request(probe, 'sfu:caps', { serverId: 'demo', channelId: 'voice1' })) !== null;
    probe.close();
    if (!usable) console.log('  (sfu unavailable on this platform; connection check tests skipped)');
  });
  after(async () => { await server.stop(); });

  test('a socket that is not signed in gets no transport', async () => {
    const anon = io(server.base, { transports: ['websocket'], forceNew: true });
    await once(anon, 'connect');
    try {
      assert.deepEqual(await request(anon, 'sfu:probe-start', { protocol: 'udp' }), { error: 'not-allowed' });
    } finally { anon.close(); }
  });

  test('one transport per protocol, outside any voice room, closed on request', async () => {
    if (!usable) return;
    const sock = await connect(server.base, token);
    try {
      assert.deepEqual(await request(sock, 'sfu:probe-start', { protocol: 'sctp' }), { error: 'bad-protocol' });
      const udp = await request(sock, 'sfu:probe-start', { protocol: 'udp' });
      const tcp = await request(sock, 'sfu:probe-start', { protocol: 'tcp' });
      for (const [t, protocol] of [[udp, 'udp'], [tcp, 'tcp']]) {
        assert.equal(t.error, undefined);
        assert.ok(t.id && t.iceParameters?.usernameFragment && t.dtlsParameters?.fingerprints?.length > 0);
        assert.ok(t.routerRtpCapabilities?.codecs?.length > 0, 'what a browser needs to load a device');
        assert.ok(t.iceCandidates.length > 0);
        assert.ok(t.iceCandidates.every((c) => c.protocol === protocol), `only ${protocol} candidates`);
      }
      // Not a room: nothing about it is reachable through the room handlers.
      assert.ok((await request(sock, 'sfu:connect-transport', { transportId: udp.id, dtlsParameters: udp.dtlsParameters })).error);
      assert.equal(await request(sock, 'sfu:caps', {}), null);
      sock.emit('sfu:probe-stop', { transportId: udp.id });
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(await request(sock, 'sfu:probe-connect', { transportId: udp.id, dtlsParameters: udp.dtlsParameters }), { error: 'unknown transport' });
    } finally { sock.close(); }
  });

  test('rate limited per account, across sockets', async () => {
    if (!usable) return;
    const limitedToken = await makeUser(call, 'eager');
    const a = await connect(server.base, limitedToken);
    const b = await connect(server.base, limitedToken);
    try {
      const answers = [];
      for (let i = 0; i < 8; i++) answers.push(await request(i % 2 ? a : b, 'sfu:probe-start', { protocol: i % 2 ? 'udp' : 'tcp' }));
      assert.equal(answers.filter((x) => x.id).length, 6, 'six starts a minute (three checks)');
      assert.deepEqual(answers.slice(6), [{ error: 'rate-limited' }, { error: 'rate-limited' }]);
      // Somebody else is not held back by it.
      const other = await connect(server.base, token);
      try { assert.ok((await request(other, 'sfu:probe-start', { protocol: 'udp' })).id); } finally { other.close(); }
    } finally { a.close(); b.close(); }
  });
});
