// A voice room can hold people whose media goes through the SFU and people who connect to each
// other directly, as long as everyone knows which is which. The server's part is to remember what
// each participant said, tell the room, and forget it when they go. Plus what explains a call that
// went wrong: the diagnostics endpoint, the fallback line in the log, the stale-address warning.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { io } = require('socket.io-client');
const { startServer, sfuEnv, apiFor, makeUser } = require('./helpers');
const { createAddressMonitor, isPublicAddress, parseTrace, STALE_WARNING } = require('../services/sfuAddress');

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
const until = async (check, what, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe('voice modes', () => {
  let server, base, tokens, sfuUsable;
  const ROOM = { serverId: 'demo' };
  // Each test gets a room of its own, so who is in it is exactly who the test put there.
  let roomNo = 0;
  const freshRoom = () => ({ ...ROOM, channelId: `modes-${++roomNo}` });
  const enter = async (token, room, extra = {}) => {
    const sock = await connect(base, token);
    const peers = once(sock, 'voice:peers');
    sock.emit('voice:join', { ...room, ...extra });
    return { sock, peers: await peers };
  };

  before(async () => {
    server = await startServer({ env: await sfuEnv() });
    base = server.base;
    const call = apiFor(base);
    tokens = [];
    for (const name of ['ann', 'ben', 'cat', 'dan']) tokens.push(await makeUser(call, name));
    const probe = await connect(base, tokens[0]);
    sfuUsable = (await request(probe, 'sfu:caps', { serverId: 'demo', channelId: 'voice1' })) !== null;
    probe.close();
  });
  after(async () => { await server.stop(); });

  test('the mode given at the door is in the roster and in what the room is told', async () => {
    const room = freshRoom();
    const a = await enter(tokens[0], room, { mode: 'sfu' });
    try {
      assert.deepEqual(a.peers, []);
      const told = once(a.sock, 'voice:peer-joined');
      const b = await enter(tokens[1], room, { mode: 'mesh', reason: 'user-choice' });
      try {
        assert.deepEqual(b.peers.map((p) => ({ id: p.id, mode: p.mode })), [{ id: a.sock.id, mode: 'sfu' }]);
        const joined = await told;
        assert.equal(joined.id, b.sock.id);
        assert.equal(joined.mode, 'mesh');
      } finally { b.sock.close(); }
    } finally { a.sock.close(); }
  });

  test('a client that says nothing (an older one) has mode null, and so does a mode that is not one', async () => {
    const room = freshRoom();
    const old = await enter(tokens[0], room);
    const odd = await enter(tokens[1], room, { mode: 'carrier-pigeon' });
    try {
      // Everyone who arrives is announced, each with their own mode (the room is told a moment
      // after the newcomer has its roster, so these are collected rather than awaited one by one).
      const announced = {};
      old.sock.on('voice:peer-joined', (p) => { announced[p.id] = p; });
      const c = await enter(tokens[2], room, { mode: 'sfu' });
      try {
        const byId = Object.fromEntries(c.peers.map((p) => [p.id, p]));
        assert.equal(byId[old.sock.id].mode, null);
        assert.equal(byId[odd.sock.id].mode, null);
        assert.ok('mode' in byId[old.sock.id], 'null is stated, not left out');
        await until(() => announced[c.sock.id] && announced[odd.sock.id], 'both arrivals to be announced');
        assert.equal(announced[c.sock.id].mode, 'sfu');
        assert.equal(announced[odd.sock.id].mode, null);
      } finally { c.sock.close(); }
    } finally { old.sock.close(); odd.sock.close(); }
  });

  test('a change of mode is told to the room, kept for whoever arrives later, and logged with its reason', async () => {
    const room = freshRoom();
    const a = await enter(tokens[0], room, { mode: 'sfu' });
    const b = await enter(tokens[1], room, { mode: 'sfu' });
    try {
      const changed = once(b.sock, 'voice:mode');
      const echo = notWithin(a.sock, 'voice:mode', 400);
      a.sock.emit('voice:mode', { ...room, mode: 'mesh', reason: 'media-unreachable' });
      assert.deepEqual(await changed, { id: a.sock.id, mode: 'mesh' });
      assert.equal(await echo, null, 'the one who changed is not told about itself');
      const c = await enter(tokens[2], room, { mode: 'sfu' });
      try {
        assert.equal(c.peers.find((p) => p.id === a.sock.id).mode, 'mesh');
      } finally { c.sock.close(); }
      // One line, with the reason code and the socket id — which the log prints for every
      // connection anyway — and no account name.
      const line = `[voice] ${a.sock.id} fell back to direct connections (reason: media-unreachable)`;
      await until(() => server.log().includes(line), 'the fallback line');
      assert.equal(server.log().split(line).length - 1, 1, 'once');
      assert.ok(!/\[voice\][^\n]*\bann\b/.test(server.log()), 'no username in it');
    } finally { a.sock.close(); b.sock.close(); }
  });

  test('saying the same mode again, a mode that is not one, or a room one is not in: nothing happens', async () => {
    const room = freshRoom();
    const elsewhere = freshRoom();
    const a = await enter(tokens[0], room, { mode: 'mesh' });
    const b = await enter(tokens[1], room, { mode: 'sfu' });
    const outsider = await enter(tokens[2], elsewhere, { mode: 'sfu' });
    try {
      const heard = notWithin(b.sock, 'voice:mode', 600);
      a.sock.emit('voice:mode', { ...room, mode: 'mesh', reason: 'user-choice' });
      a.sock.emit('voice:mode', { ...room, mode: 'both' });
      a.sock.emit('voice:mode', null);
      outsider.sock.emit('voice:mode', { ...room, mode: 'mesh', reason: 'user-choice' });
      assert.equal(await heard, null);
      const c = await enter(tokens[3], room);
      try {
        assert.deepEqual(c.peers.map((p) => p.mode).sort(), ['mesh', 'sfu']);
      } finally { c.sock.close(); }
    } finally { a.sock.close(); b.sock.close(); outsider.sock.close(); }
  });

  test('a reason that is not a short code never reaches the log', async () => {
    const room = freshRoom();
    const a = await enter(tokens[0], room, { mode: 'sfu' });
    const b = await enter(tokens[1], room, { mode: 'sfu' });
    try {
      const changed = once(b.sock, 'voice:mode');
      a.sock.emit('voice:mode', { ...room, mode: 'mesh', reason: 'x\n[voice] forged line\nsecret=1' });
      await changed;
      const line = `[voice] ${a.sock.id} fell back to direct connections (reason: unspecified)`;
      await until(() => server.log().includes(line), 'the fallback line');
      assert.ok(!server.log().includes('forged line'));
    } finally { a.sock.close(); b.sock.close(); }
  });

  test('the mode is forgotten on leave: coming back without one is null again', async () => {
    const room = freshRoom();
    const a = await enter(tokens[0], room, { mode: 'mesh' });
    const b = await enter(tokens[1], room, { mode: 'sfu' });
    try {
      const left = once(b.sock, 'voice:peer-left');
      a.sock.emit('voice:leave', room);
      assert.deepEqual(await left, { id: a.sock.id });
      const back = once(b.sock, 'voice:peer-joined');
      const peers = once(a.sock, 'voice:peers');
      a.sock.emit('voice:join', room);
      await peers;
      assert.equal((await back).mode, null);
      const c = await enter(tokens[2], room);
      try {
        assert.equal(c.peers.find((p) => p.id === a.sock.id).mode, null);
      } finally { c.sock.close(); }
    } finally { a.sock.close(); b.sock.close(); }
  });

  test('a participant who disconnects is gone from the roster, mode and all', async () => {
    const room = freshRoom();
    const a = await enter(tokens[0], room, { mode: 'mesh' });
    const b = await enter(tokens[1], room, { mode: 'sfu' });
    try {
      const left = once(b.sock, 'voice:peer-left');
      const goneId = a.sock.id; // a closed socket no longer knows its id
      a.sock.close();
      assert.deepEqual(await left, { id: goneId });
      const c = await enter(tokens[2], room, { mode: 'sfu' });
      try {
        assert.deepEqual(c.peers.map((p) => ({ id: p.id, mode: p.mode })), [{ id: b.sock.id, mode: 'sfu' }]);
      } finally { c.sock.close(); }
    } finally { b.sock.close(); }
  });

  // What stops a participant from being heard twice, or waited for in silence: once it says it is
  // in mesh mode, nothing of it is left on the SFU for anyone to consume.
  describe('switching to direct connections takes the participant off the SFU', () => {
    const OPUS = { codecs: [{ mimeType: 'audio/opus', payloadType: 111, clockRate: 48000, channels: 2 }], encodings: [{ ssrc: 11110000 }] };
    const produce = async (sock, ssrc) => {
      const t = await request(sock, 'sfu:create-transport', { direction: 'send' });
      assert.ok(t.id, `transport: ${t.error}`);
      const made = await request(sock, 'sfu:produce', { transportId: t.id, kind: 'audio', rtpParameters: { ...OPUS, encodings: [{ ssrc }] } });
      assert.ok(made.id, `producer: ${made.error}`);
      return made.id;
    };

    test('voice:mode mesh closes its producers for everyone', async () => {
      if (!sfuUsable) return;
      const room = freshRoom();
      const a = await enter(tokens[0], room, { mode: 'sfu' });
      const b = await enter(tokens[1], room, { mode: 'sfu' });
      try {
        const announced = once(b.sock, 'sfu:new-producer');
        const producerId = await produce(a.sock, 22220001);
        assert.equal((await announced).producerId, producerId);
        assert.equal((await request(b.sock, 'sfu:producers', {})).length, 1);
        const closed = once(b.sock, 'sfu:producer-closed');
        a.sock.emit('voice:mode', { ...room, mode: 'mesh', reason: 'media-unreachable' });
        assert.deepEqual(await closed, { producerId, peerSocketId: a.sock.id });
        assert.deepEqual(await request(b.sock, 'sfu:producers', {}), []);
      } finally { a.sock.close(); b.sock.close(); }
    });

    test('an older client falling back (it joins the room it is already in) is taken off too, and logged', async () => {
      if (!sfuUsable) return;
      const room = freshRoom();
      const old = await enter(tokens[0], room);
      const b = await enter(tokens[1], room, { mode: 'sfu' });
      try {
        const producerId = await produce(old.sock, 22220002);
        const closed = once(b.sock, 'sfu:producer-closed');
        const again = once(old.sock, 'voice:peers');
        const told = once(b.sock, 'voice:mode');
        old.sock.emit('voice:join', room);
        assert.deepEqual(await closed, { producerId, peerSocketId: old.sock.id });
        // The room hears it from the server, since the client itself cannot say: whatever anyone
        // had started towards it is void, and it is about to offer to everyone.
        assert.deepEqual(await told, { id: old.sock.id, mode: null });
        // It is sent the roster again, as it always was: that is what it calls directly.
        assert.deepEqual((await again).map((p) => p.id), [b.sock.id]);
        await until(() => server.log().includes(`[voice] ${old.sock.id} fell back to direct connections (reason: old-client)`), 'the fallback line');
        // Still mode null: it has not said anything, and a newer client must go on treating it as old.
        const c = await enter(tokens[2], room, { mode: 'sfu' });
        try {
          assert.equal(c.peers.find((p) => p.id === old.sock.id).mode, null);
        } finally { c.sock.close(); }
      } finally { old.sock.close(); b.sock.close(); }
    });

    test('joining in mesh mode with a reason is logged as a fallback', async () => {
      const room = freshRoom();
      const a = await enter(tokens[0], room, { mode: 'mesh', reason: 'user-choice' });
      try {
        await until(() => server.log().includes(`[voice] ${a.sock.id} fell back to direct connections (reason: user-choice)`), 'the fallback line');
      } finally { a.sock.close(); }
    });
  });
});

describe('GET /webrtc/diagnostics', () => {
  let server, call, token;

  before(async () => {
    server = await startServer({
      env: { ...(await sfuEnv()), TURN_URLS: 'turn:turn.example.test:3478', TURN_USERNAME: 'relay-user', TURN_CREDENTIAL: 'relay-secret-credential', STUN_URLS: 'stun:stun.example.test:3478, stun:stun2.example.test:3478' },
    });
    call = apiFor(server.base);
    token = await makeUser(call, 'diag');
  });
  after(async () => { await server.stop(); });

  test('needs a signed-in caller', async () => {
    assert.equal((await call('GET', '/webrtc/diagnostics')).status, 401);
    assert.equal((await call('GET', '/webrtc/diagnostics', undefined, 'not-a-token')).status, 401);
  });

  test('says what a connection check needs, and nothing that identifies the network', async () => {
    const res = await call('GET', '/webrtc/diagnostics', undefined, token);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.data).sort(), ['announcedAddressStale', 'sfu', 'stunUrls', 'turnConfigured']);
    assert.deepEqual(Object.keys(res.data.sfu).sort(), ['enabled', 'ports', 'publicAddressAnnounced', 'usable']);
    assert.equal(typeof res.data.sfu.enabled, 'boolean');
    assert.equal(typeof res.data.sfu.usable, 'boolean');
    assert.equal(res.data.sfu.publicAddressAnnounced, false, 'loopback is not a public address');
    assert.ok(Array.isArray(res.data.sfu.ports) && res.data.sfu.ports.length === 1 && Number.isInteger(res.data.sfu.ports[0]));
    assert.equal(res.data.announcedAddressStale, false);
    assert.equal(res.data.turnConfigured, true);
    assert.deepEqual(res.data.stunUrls, ['stun:stun.example.test:3478', 'stun:stun2.example.test:3478']);
    const body = JSON.stringify(res.data);
    for (const secret of ['127.0.0.1', 'relay-user', 'relay-secret-credential', 'turn.example.test']) {
      assert.ok(!body.includes(secret), `${secret} is not in the answer`);
    }
  });

  test('the SFU switched off is reported as such, and TURN as not configured when it is not', async () => {
    const off = await startServer({ env: { SFU_DISABLED: '1', TURN_URLS: '' } });
    try {
      const c = apiFor(off.base);
      const t = await makeUser(c, 'diagoff');
      const res = await c('GET', '/webrtc/diagnostics', undefined, t);
      assert.equal(res.data.sfu.enabled, false);
      assert.equal(res.data.sfu.usable, false);
      assert.equal(res.data.turnConfigured, false);
    } finally { await off.stop(); }
  });
});

describe('announced public address check', () => {
  const quiet = () => {
    const lines = [];
    return { lines, warn: (m) => lines.push(m), info: (m) => lines.push(m) };
  };

  test('what counts as a public address', () => {
    for (const a of ['203.0.113.7', '8.8.8.8', '2001:db8::1', 'voice.example.test']) assert.equal(isPublicAddress(a), true, a);
    for (const a of ['10.0.0.5', '192.168.1.33', '172.16.4.1', '172.31.255.1', '127.0.0.1', '169.254.3.3', '100.64.0.1', '::1', 'fe80::1', 'fd00::5', '']) assert.equal(isPublicAddress(a), false, a);
    assert.equal(isPublicAddress('172.32.0.1'), true);
  });

  test('reads the address out of a trace', () => {
    assert.equal(parseTrace('fl=1\nh=cloudflare.com\nip=203.0.113.9\nts=1.5\n'), '203.0.113.9');
    assert.equal(parseTrace('ip=2001:db8::9\r\nts=1\r\n'), '2001:db8::9');
    assert.equal(parseTrace('ip=not-an-address\n'), null);
    assert.equal(parseTrace('<html>captive portal</html>'), null);
  });

  test('a different public address: stale, and ONE warning however often it is checked', async () => {
    const log = quiet();
    const asked = [];
    const monitor = createAddressMonitor({ announced: ['203.0.113.7', '192.168.1.33'], fetchAddress: async (family) => { asked.push(family); return '203.0.113.99'; }, ...log });
    assert.equal(monitor.watching, true);
    assert.equal(monitor.isStale(), false, 'nothing is claimed before the first check');
    assert.equal(await monitor.check(), true);
    assert.equal(await monitor.check(), true);
    assert.equal(await monitor.check(), true);
    assert.equal(monitor.isStale(), true);
    assert.deepEqual(log.lines, [STALE_WARNING]);
    assert.deepEqual(asked, [4, 4, 4], 'asked over the announced address family');
    assert.match(STALE_WARNING, /^\[sfu\] the announced public address no longer matches/);
    assert.ok(!log.lines.join('\n').includes('203.0.113'), 'the warning does not print the addresses');
  });

  test('the same address: not stale, nothing logged', async () => {
    const log = quiet();
    const monitor = createAddressMonitor({ announced: ['203.0.113.7'], fetchAddress: async () => '203.0.113.7', ...log });
    assert.equal(await monitor.check(), false);
    assert.deepEqual(log.lines, []);
  });

  test('unreachable, empty, or an answer in the other address family: skipped silently, last state kept', async () => {
    const log = quiet();
    let answer = async () => { throw new Error('ENOTFOUND'); };
    const monitor = createAddressMonitor({ announced: ['203.0.113.7'], fetchAddress: () => answer(), ...log });
    assert.equal(await monitor.check(), false);
    answer = async () => null;
    assert.equal(await monitor.check(), false);
    answer = async () => '2001:db8::9';
    assert.equal(await monitor.check(), false);
    assert.deepEqual(log.lines, []);
    answer = async () => '203.0.113.99';
    assert.equal(await monitor.check(), true);
    answer = async () => { throw new Error('offline'); };
    assert.equal(await monitor.check(), true, 'being offline does not un-stale it');
    assert.deepEqual(log.lines, [STALE_WARNING]);
  });

  test('fixed (or the old address came back): no longer stale, and a later change warns again', async () => {
    const log = quiet();
    let current = '203.0.113.99';
    const monitor = createAddressMonitor({ announced: ['203.0.113.7'], fetchAddress: async () => current, ...log });
    assert.equal(await monitor.check(), true);
    current = '203.0.113.7';
    assert.equal(await monitor.check(), false);
    current = '203.0.113.50';
    assert.equal(await monitor.check(), true);
    assert.equal(log.lines.filter((l) => l === STALE_WARNING).length, 2);
  });

  test('no public address announced: nothing is asked of anyone', async () => {
    let asked = 0;
    for (const announced of [[], ['192.168.1.33', '10.0.0.2'], ['voice.example.test']]) {
      const monitor = createAddressMonitor({ announced, fetchAddress: async () => { asked++; return '203.0.113.99'; }, ...quiet() });
      assert.equal(monitor.watching, false);
      monitor.start(); // a no-op: no timer is left behind to keep the test alive
      assert.equal(await monitor.check(), false);
    }
    assert.equal(asked, 0);
  });

  test('a public address that is not first is still the one compared', async () => {
    const monitor = createAddressMonitor({ announced: ['192.168.1.33', '203.0.113.7'], fetchAddress: async () => '203.0.113.99', ...quiet() });
    assert.equal(await monitor.check(), true);
  });

  // The whole path, in a running server, against a local stand-in for the trace service.
  test('a server announcing an address that is no longer its own says so: log line and diagnostics', async () => {
    let hits = 0;
    const trace = http.createServer((_req, res) => { hits++; res.end('fl=1\nip=203.0.113.99\nts=1\n'); });
    await new Promise((resolve) => trace.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (trace.address());
    const env = await sfuEnv();
    const server = await startServer({
      env: { ...env, SFU_ANNOUNCED_IPS: '203.0.113.7', SFU_ADDRESS_CHECK: '1', SFU_ADDRESS_CHECK_URL: `http://127.0.0.1:${port}/cdn-cgi/trace` },
    });
    try {
      const call = apiFor(server.base);
      const token = await makeUser(call, 'moved');
      const res = await until(async () => {
        const r = await call('GET', '/webrtc/diagnostics', undefined, token);
        return r.data && r.data.announcedAddressStale ? r : null;
      }, 'announcedAddressStale');
      assert.equal(res.data.sfu.publicAddressAnnounced, true);
      assert.ok(!JSON.stringify(res.data).includes('203.0.113'), 'neither address is in the answer');
      assert.equal(server.log().split(STALE_WARNING).length - 1, 1);
      assert.ok(hits >= 1);
    } finally { await server.stop(); trace.close(); }
  });

  test('switched off (as the test harness does), a server asks nobody', async () => {
    let hits = 0;
    const trace = http.createServer((_req, res) => { hits++; res.end('ip=203.0.113.99\n'); });
    await new Promise((resolve) => trace.listen(0, '127.0.0.1', () => resolve(undefined)));
    const { port } = /** @type {import('node:net').AddressInfo} */ (trace.address());
    const server = await startServer({
      env: { ...(await sfuEnv()), SFU_ANNOUNCED_IPS: '203.0.113.7', SFU_ADDRESS_CHECK_URL: `http://127.0.0.1:${port}/cdn-cgi/trace` },
    });
    try {
      const call = apiFor(server.base);
      const token = await makeUser(call, 'unasked');
      await new Promise((r) => setTimeout(r, 300));
      const res = await call('GET', '/webrtc/diagnostics', undefined, token);
      assert.equal(res.data.announcedAddressStale, false);
      assert.equal(hits, 0);
    } finally { await server.stop(); trace.close(); }
  });
});
