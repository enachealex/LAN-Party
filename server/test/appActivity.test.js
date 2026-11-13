// The app bridge: an uploaded bundle app running as a voice room's activity, plus the SDK shim it
// talks through. Everything an app sends is untrusted (anyone can upload one), so most of this file
// is about what the server REFUSES — and that a refusal leaves the room's state exactly as it was.
//
// Three layers: the reducer on its own (every limit, no rate limiter in the way), the real server
// over sockets (who may do what, who hears what), and the shim loaded into a vm with a fake window.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { io } = require('socket.io-client');
const { strToU8 } = require('fflate');
const { startServer, apiFor, makeUser } = require('./helpers');
const { createActivities } = require('../services/activities');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
describe('app activity reducer', () => {
  const fakeIo = () => ({ to: () => ({ emit() {} }), sockets: { adapter: { rooms: new Map() } }, emit() {} });
  const a = createActivities({ io: fakeIo(), clients: {} });
  const row = { id: 7, name: 'Buzzer', bundle_dir: 'abc-123', icon_url: null, created_by: 'uploader' };
  // A fresh activity with 'ann' (socket s1) already joined, the way activity:start leaves it.
  const fresh = () => {
    const act = { type: a.APP_ACTIVITY, state: a.appActivityInit(row), by: 'ann' };
    a.applyAppEvent(act, { kind: 'join' }, 'ann', 's1');
    return act;
  };
  const set = (act, patch, who = 'ann', sock = 's1') => a.applyAppEvent(act, { kind: 'set', patch }, who, sock);
  // JSON.parse is how a hostile key really arrives: it creates an OWN property called __proto__,
  // which an object literal in this file would not.
  const hostile = (json) => JSON.parse(json);

  test('app is not one of the built-in types, and starts from the database row', () => {
    assert.ok(!a.ACTIVITY_TYPES.includes('app'), 'an app cannot be started through activityInit(type)');
    const { run, ...rest } = a.appActivityInit(row);
    assert.deepEqual(rest, {
      appId: 7, name: 'Buzzer', url: '/app-bundles/abc-123/', hosted: false, iconUrl: '', createdBy: 'uploader', approved: false,
      roomKey: null, shared: {}, rev: 0, lastBy: null, joined: [],
    });
    // Approved only when the row says published, and for no other status (or none at all).
    assert.equal(a.appActivityInit({ ...row, status: 'published' }).approved, true);
    for (const status of ['draft', 'pending', 'rejected', undefined]) assert.equal(a.appActivityInit({ ...row, status }).approved, false);
    // Every start is its own run, so events meant for an earlier one can be told apart.
    assert.match(run, /^[0-9a-f]{16}$/);
    assert.notEqual(a.appActivityInit(row).run, run);
  });

  test('set merges shallowly, null deletes, and each change bumps rev and records who made it', () => {
    const act = fresh();
    a.applyAppEvent(act, { kind: 'join' }, 'ben', 's2');
    assert.deepEqual(set(act, { a: 1, b: { x: 1 } }), { ok: true, audience: 'joined' });
    assert.deepEqual(act.state.shared, { a: 1, b: { x: 1 } });
    assert.equal(act.state.rev, 1);
    assert.equal(act.state.lastBy, 'ann');
    set(act, { b: null, c: 'z' }, 'ben', 's2');
    assert.deepEqual(act.state.shared, { a: 1, c: 'z' }, 'b deleted, a untouched, c added');
    assert.equal(act.state.rev, 2);
    assert.equal(act.state.lastBy, 'ben');
    // Shallow: a nested object is replaced, not merged into.
    set(act, { n: { one: 1 } });
    set(act, { n: { two: 2 } });
    assert.deepEqual(act.state.shared.n, { two: 2 });
  });

  test('replace swaps the whole object', () => {
    const act = fresh();
    set(act, { a: 1, b: 2 });
    assert.equal(a.applyAppEvent(act, { kind: 'replace', shared: { only: true } }, 'ann', 's1').ok, true);
    assert.deepEqual(act.state.shared, { only: true });
    assert.equal(act.state.rev, 2);
  });

  test('the identity recorded is the one passed by the transport, never one in the event', () => {
    const act = fresh();
    a.applyAppEvent(act, { kind: 'set', patch: { a: 1 }, from: 'admin', user: 'admin', lastBy: 'admin' }, 'ann', 's1');
    assert.equal(act.state.lastBy, 'ann');
    const out = a.applyAppEvent(act, { kind: 'emit', data: 1, from: 'admin' }, 'ann', 's1');
    assert.equal(out.relay.from, 'ann');
  });

  test('only someone who joined can change state or send messages', () => {
    const act = fresh();
    assert.deepEqual(set(act, { a: 1 }, 'ben', 's2'), { ok: false, reason: 'not-joined' });
    assert.deepEqual(a.applyAppEvent(act, { kind: 'emit', data: 1 }, 'ben', 's2'), { ok: false, reason: 'not-joined' });
    assert.deepEqual(act.state.shared, {});
    assert.equal(act.state.rev, 0);
  });

  test('at most 200 keys, counted on the result of the merge', () => {
    const many = (n, prefix) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, i]));
    const act = fresh();
    assert.equal(set(act, many(200, 'k')).ok, true, 'exactly 200 fits');
    assert.deepEqual(set(act, { onemore: 1 }), { ok: false, reason: 'too-many-keys' });
    assert.equal(Object.keys(act.state.shared).length, 200);
    assert.equal(act.state.rev, 1, 'a rejected event does not bump rev');
    // Swapping one key for another keeps it at 200, so that is fine.
    assert.equal(set(act, { k0: null, onemore: 1 }).ok, true);
    // A patch that alone names more keys than could ever fit.
    assert.deepEqual(set(fresh(), many(201, 'k')), { ok: false, reason: 'too-many-keys' });
    assert.deepEqual(a.applyAppEvent(fresh(), { kind: 'replace', shared: many(201, 'k') }, 'ann', 's1'), { ok: false, reason: 'too-many-keys' });
  });

  test('key names must be 1 to 64 characters', () => {
    const act = fresh();
    assert.deepEqual(set(act, { '': 1 }), { ok: false, reason: 'bad-key' });
    assert.deepEqual(set(act, { ['k'.repeat(65)]: 1 }), { ok: false, reason: 'bad-key' });
    assert.equal(set(act, { ['k'.repeat(64)]: 1 }).ok, true);
  });

  test('serialised state is capped at 64 KB, in bytes, and an over-size event changes nothing', () => {
    const act = fresh();
    set(act, { keep: 'me' });
    // One good key and one that blows the limit: the WHOLE event goes, including the good key.
    assert.deepEqual(set(act, { good: 1, big: 'x'.repeat(70_000) }), { ok: false, reason: 'too-large' });
    assert.deepEqual(act.state.shared, { keep: 'me' });
    assert.equal(act.state.rev, 1);
    assert.equal(act.state.lastBy, 'ann');
    // Bytes, not characters: 22 000 euro signs are 66 000 bytes.
    assert.deepEqual(set(act, { big: '€'.repeat(22_000) }), { ok: false, reason: 'too-large' });
    // The limit is on the total, so two values that each fit can still be refused together.
    assert.equal(set(act, { one: 'x'.repeat(40_000) }).ok, true);
    assert.deepEqual(set(act, { two: 'x'.repeat(40_000) }), { ok: false, reason: 'too-large' });
    assert.deepEqual(Object.keys(act.state.shared), ['keep', 'one']);
    assert.deepEqual(a.applyAppEvent(act, { kind: 'replace', shared: { big: 'x'.repeat(70_000) } }, 'ann', 's1'), { ok: false, reason: 'too-large' });
    assert.deepEqual(Object.keys(act.state.shared), ['keep', 'one'], 'a refused replace keeps the old object');
  });

  test('prototype-pollution keys are refused at the top level and at any depth', () => {
    const act = fresh();
    set(act, { safe: 1 });
    const attempts = [
      [hostile('{"__proto__":{"polluted":1}}'), 'bad-key'],
      [{ constructor: { prototype: { polluted: 1 } } }, 'bad-key'],
      [{ prototype: { polluted: 1 } }, 'bad-key'],
      [{ ok: 1, nested: hostile('{"__proto__":{"polluted":1}}') }, 'invalid'],
      [{ deep: { list: [{ fine: true }, hostile('{"a":{"__proto__":{"polluted":1}}}')] } }, 'invalid'],
      [{ nested: { constructor: { prototype: { polluted: 1 } } } }, 'invalid'],
      [{ nested: { prototype: 1 } }, 'invalid'],
    ];
    for (const [patch, reason] of attempts) {
      assert.deepEqual(set(act, patch), { ok: false, reason });
      assert.deepEqual(a.applyAppEvent(act, { kind: 'replace', shared: patch }, 'ann', 's1'), { ok: false, reason });
      assert.equal(a.applyAppEvent(act, { kind: 'emit', data: patch }, 'ann', 's1').ok, false, 'not relayed to other clients either');
    }
    assert.deepEqual(act.state.shared, { safe: 1 }, 'none of it was stored');
    assert.equal(act.state.rev, 1);
    // The point of all of the above.
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
    assert.equal(Object.getPrototypeOf(act.state.shared), Object.prototype, 'shared is still an ordinary object');
  });

  test('only plain JSON is stored', () => {
    const act = fresh();
    let deep = 1;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    for (const bad of [{ when: new Date() }, { fn: () => 1 }, { n: NaN }, { n: Infinity }, { u: undefined }, { buf: Buffer.from('x') }, { deep }]) {
      assert.deepEqual(set(act, bad), { ok: false, reason: 'invalid' });
    }
    for (const notAnObject of [null, 'str', 5, [1, 2], undefined]) {
      assert.deepEqual(set(act, notAnObject), { ok: false, reason: 'invalid' });
      assert.deepEqual(a.applyAppEvent(act, { kind: 'replace', shared: notAnObject }, 'ann', 's1'), { ok: false, reason: 'invalid' });
    }
    assert.deepEqual(a.applyAppEvent(act, { kind: 'nonsense' }, 'ann', 's1'), { ok: false, reason: 'invalid' });
    assert.deepEqual(a.applyAppEvent(act, null, 'ann', 's1'), { ok: false, reason: 'invalid' });
    assert.deepEqual(act.state.shared, {});
    // Stored values are copies: mutating what was sent afterwards cannot reach the room's state.
    const mine = { list: [1, 2] };
    set(act, { mine });
    mine.list.push(3);
    assert.deepEqual(act.state.shared.mine, { list: [1, 2] });
  });

  test('a transient message is capped at 8 KB and never stored', () => {
    const act = fresh();
    const out = a.applyAppEvent(act, { kind: 'emit', data: { buzz: true } }, 'ann', 's1');
    assert.deepEqual(out, { ok: true, relay: { from: 'ann', data: { buzz: true } } });
    assert.deepEqual(act.state.shared, {});
    assert.equal(act.state.rev, 0, 'a message is not a state change');
    assert.deepEqual(a.applyAppEvent(act, { kind: 'emit', data: 'x'.repeat(9000) }, 'ann', 's1'), { ok: false, reason: 'too-large' });
    assert.equal(a.applyAppEvent(act, { kind: 'emit', data: 'x'.repeat(8000) }, 'ann', 's1').ok, true);
    assert.deepEqual(a.applyAppEvent(act, { kind: 'emit' }, 'ann', 's1'), { ok: false, reason: 'invalid' });
  });

  test('joined is a list of names: one entry per person however many devices they use', () => {
    const act = fresh();
    assert.deepEqual(act.state.joined, ['ann']);
    assert.deepEqual(a.applyAppEvent(act, { kind: 'join' }, 'ben', 's2'), { ok: true, audience: 'room' });
    a.applyAppEvent(act, { kind: 'join' }, 'ann', 's3'); // ann's second device
    assert.deepEqual(act.state.joined, ['ann', 'ben']);
    assert.deepEqual(a.applyAppEvent(act, { kind: 'join' }, 'ben', 's2'), { ok: true }, 'joining twice is a no-op');
    assert.equal(a.appLeave(act, 's1'), true);
    assert.deepEqual(act.state.joined, ['ben', 'ann'], 'ann is still in on her other device');
    a.applyAppEvent(act, { kind: 'leave' }, 'ann', 's3');
    assert.deepEqual(act.state.joined, ['ben']);
    assert.equal(a.appLeave(act, 's1'), false, 'leaving twice changes nothing');
    assert.deepEqual(a.appJoinedSockets(act), ['s2']);
    assert.equal(a.appLeave({ type: 'ttt', state: {} }, 's2'), false, 'other activities are not touched');
  });

  test('shared state is only shown to people who joined', () => {
    const act = fresh();
    set(act, { secretRound: 3 });
    assert.equal(a.activityViewFor(act, 's1'), act);
    const outside = a.activityViewFor(act, 'someone-else');
    assert.deepEqual(outside.state.shared, {});
    // The room key goes the same way: it is for the people running the app, nobody else.
    const keyed = { type: a.APP_ACTIVITY, state: a.appActivityInit(row, 'f'.repeat(32)), by: 'ann' };
    a.applyAppEvent(keyed, { kind: 'join' }, 'ann', 's1');
    assert.equal(a.activityViewFor(keyed, 's1').state.roomKey, 'f'.repeat(32));
    assert.equal(a.activityViewFor(keyed, 'someone-else').state.roomKey, null);
    assert.equal(keyed.state.roomKey, 'f'.repeat(32), 'withheld from the copy, not wiped from the room');
    assert.equal(outside.state.name, 'Buzzer', 'they still get what the Join card shows');
    assert.deepEqual(outside.state.joined, ['ann']);
    assert.deepEqual(act.state.shared, { secretRound: 3 }, 'the redacted view is a copy');
  });

  // Every accepted change re-sends the whole object to everyone joined, so the event rate alone
  // would let a 60 KB state go out 15 times a second per participant.
  test('the room has a byte budget: a large state can only change slowly', () => {
    const t0 = 2_000_000;
    const at = (act, patch, now, who = 'ann', sock = 's1') => a.applyAppEvent(act, { kind: 'set', patch }, who, sock, now);
    const act = fresh();
    a.applyAppEvent(act, { kind: 'join' }, 'ben', 's2');
    assert.equal(at(act, { big: 'x'.repeat(60_000) }, t0).ok, true);
    let accepted = 1;
    let refusal = null;
    for (let i = 0; i < 100; i++) {
      const out = at(act, { n: i }, t0, i % 2 ? 'ben' : 'ann', i % 2 ? 's2' : 's1');
      if (out.ok) accepted += 1; else refusal = refusal || out;
    }
    // 512 KB of burst pays for eight sends of a 60 KB object, whoever in the room makes them.
    assert.equal(accepted, 8);
    assert.deepEqual(refusal, { ok: false, reason: 'rate-limited' });
    assert.equal(act.state.rev, 8, 'a change over the budget is refused whole');
    assert.equal(act.state.shared.n, 6, 'and leaves the state as it was');
    // One second buys 256 KB. With the 44 KB the burst left over, that is five more.
    accepted = 0;
    for (let i = 0; i < 100; i++) if (at(act, { n: i }, t0 + 1000).ok) accepted += 1;
    assert.equal(accepted, 5);
    // Messages are not state and are not charged to it.
    assert.equal(a.applyAppEvent(act, { kind: 'emit', data: 1 }, 'ann', 's1', t0 + 1000).ok, true);
    // Shrinking the state is what makes room: a small object costs next to nothing.
    assert.equal(a.applyAppEvent(act, { kind: 'replace', shared: { n: 0 } }, 'ann', 's1', t0 + 1100).ok, true);
    accepted = 0;
    for (let i = 0; i < 100; i++) if (at(act, { n: i }, t0 + 1100).ok) accepted += 1;
    assert.equal(accepted, 100);
    // The budget belongs to the run, so another room's app is not slowed by this one.
    assert.equal(at(fresh(), { big: 'x'.repeat(60_000) }, t0).ok, true);
  });

  test('token bucket: a burst of 30, refilled at 15 a second', () => {
    const t0 = 1_000_000;
    let allowed = 0;
    for (let i = 0; i < 100; i++) if (a.appEventAllowed('flood', t0)) allowed += 1;
    assert.equal(allowed, 30);
    assert.equal(a.appEventAllowed('flood', t0 + 10), false, 'still empty a moment later');
    allowed = 0;
    for (let i = 0; i < 100; i++) if (a.appEventAllowed('flood', t0 + 1010)) allowed += 1;
    assert.equal(allowed, 15, 'one second buys fifteen more');
    allowed = 0;
    for (let i = 0; i < 100; i++) if (a.appEventAllowed('flood', t0 + 60_000)) allowed += 1;
    assert.equal(allowed, 30, 'a long quiet spell never banks more than the burst');
    assert.equal(a.appEventAllowed('someone-else', t0), true, 'one socket flooding does not spend another socket\'s allowance');
    a.forgetAppSocket('flood');
    assert.equal(a.appEventAllowed('flood', t0 + 60_000), true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('app activity (sockets)', () => {
  let server, call, base, tokens, bundleApp, secondApp, linkApp;
  /** channelId -> the run id of the app last started there; app events have to carry it. */
  const runs = {};
  /** @type {any[]} */
  const open = [];

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
  const isApp = (v) => v != null && v.type === 'app';

  // A connected socket that has joined the demo server and, unless told otherwise, a voice room.
  // It remembers the last activity it was told about and every app message it received.
  async function enter(name, channelId) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[name] } });
    open.push(socket);
    await once(socket, 'connect');
    socket.updates = [];
    socket.messages = [];
    socket.lists = [];
    socket.on('activity:update', (act) => { socket.updates.push(act); socket.act = act; });
    // The joined list travels on its own; fold it into the activity the way the client does.
    socket.on('activity:app-joined', (m) => {
      socket.lists.push(m);
      if (socket.act && socket.act.type === 'app' && socket.act.state.run === m.run) socket.act = { ...socket.act, state: { ...socket.act.state, joined: m.joined } };
    });
    socket.on('activity:app-message', (m) => socket.messages.push(m));
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
  // An app event, resolved with the server's ack. Events on one socket are handled in order, and a
  // joined sender gets the resulting state BEFORE the ack, so after `await send(...)` its
  // `socket.act` is current.
  // Tagged with the run of the app in that channel, as the client's app panel does. UNTAGGED sends
  // it the way a built-in activity's own UI would.
  const UNTAGGED = Symbol('untagged');
  const send = (socket, channelId, event, run = runs[channelId]) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no ack for ' + JSON.stringify(event).slice(0, 80))), 5000);
    const payload = run === UNTAGGED ? { serverId: 'demo', channelId, event } : { serverId: 'demo', channelId, app: run, event };
    socket.emit('activity:event', payload, (answer) => { clearTimeout(timer); resolve(answer); });
  });
  const startApp = async (socket, channelId, appId = bundleApp.id) => {
    const started = once(socket, 'activity:update', (v) => isApp(v) && v.state.run !== runs[channelId]);
    socket.emit('activity:start', { serverId: 'demo', channelId, type: 'app', appId });
    const act = await started;
    runs[channelId] = act.state.run;
    return act;
  };
  const listIs = (names) => (m) => JSON.stringify(m.joined) === JSON.stringify(names);
  const uploadBundle = async (name, token) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('description', 'a test app');
    fd.append('bundle', new Blob([strToU8('<script src="/sdk/lanparty.js"></script>')], { type: 'text/html' }), 'index.html');
    const res = await call('POST', '/apps/bundle', fd, token);
    assert.equal(res.status, 200);
    return res.data.apps.find((x) => x.name === name);
  };

  before(async () => {
    server = await startServer();
    base = server.base;
    call = apiFor(base);
    tokens = {};
    for (const name of ['ann', 'ben', 'cara', 'dana']) tokens[name] = await makeUser(call, name);
    bundleApp = await uploadBundle('Bridge App', tokens.ann);
    secondApp = await uploadBundle('Doomed App', tokens.ann);
    const link = await call('POST', '/apps', { name: 'Link App', url: 'https://example.com/' }, tokens.ann);
    linkApp = link.data.apps.find((x) => x.name === 'Link App');
  });
  after(async () => {
    for (const s of open) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('starting needs a real bundle app', async () => {
    const ann = await enter('ann', 'v-start');
    const starts = [
      { type: 'app' },                                   // no appId
      { type: 'app', appId: 999_999 },                   // nothing with that id
      { type: 'app', appId: linkApp.id },                // a plain link: it opens in a tab, it does not run in a room
      { type: 'app', appId: String(bundleApp.id) },      // ids are numbers
      { type: 'app', appId: { id: bundleApp.id } },
      { type: 'app', appId: null },
    ];
    for (const s of starts) ann.emit('activity:start', { serverId: 'demo', channelId: 'v-start', ...s });
    // A built-in start after them proves the server worked through (and ignored) every one above.
    const ttt = once(ann, 'activity:update', (v) => v != null && v.type === 'ttt');
    ann.emit('activity:start', { serverId: 'demo', channelId: 'v-start', type: 'ttt' });
    await ttt;
    assert.ok(!ann.updates.some(isApp), 'no app activity was ever started');
  });

  test('name, url and icon come from the database, not from whoever starts it', async () => {
    const ann = await enter('ann', 'v-db');
    const started = once(ann, 'activity:update', isApp);
    ann.emit('activity:start', {
      serverId: 'demo', channelId: 'v-db', type: 'app', appId: bundleApp.id,
      name: 'Totally Official', url: 'https://evil.example/', iconUrl: 'https://evil.example/x.png',
      createdBy: 'admin', state: { url: 'https://evil.example/', shared: { preloaded: true }, rev: 99 },
    });
    const act = await started;
    assert.equal(act.by, 'ann');
    const { run, roomKey, ...rest } = act.state;
    assert.match(run, /^[0-9a-f]{16}$/);
    // The starter is joined, so she is given the app's id for this channel (hostedApps.test.js).
    assert.match(roomKey, /^[0-9a-f]{32}$/);
    assert.deepEqual(rest, {
      // ann registered first, so she is the instance owner and her uploads are published at once.
      appId: bundleApp.id, name: 'Bridge App', url: bundleApp.url, hosted: false, iconUrl: '', createdBy: 'ann', approved: true,
      shared: {}, rev: 0, lastBy: null, joined: ['ann'],
    });
    assert.match(act.state.url, /^\/app-bundles\/[^/]+\/$/);
  });

  test('state changes sync to everyone who joined; rejected ones change nothing', async () => {
    const ann = await enter('ann', 'v-sync');
    const ben = await enter('ben', 'v-sync');
    await startApp(ann, 'v-sync');
    assert.deepEqual(await send(ben, 'v-sync', { kind: 'join' }), { ok: true, rev: 0 });

    assert.deepEqual(await send(ann, 'v-sync', { kind: 'set', patch: { a: 1, b: { x: 1 } } }), { ok: true, rev: 1 });
    const seen = once(ann, 'activity:update', (v) => isApp(v) && v.state.rev === 2);
    assert.deepEqual(await send(ben, 'v-sync', { kind: 'set', patch: { b: null, c: 'z' }, from: 'ann' }), { ok: true, rev: 2 });
    const act = await seen;
    assert.deepEqual(act.state.shared, { a: 1, c: 'z' });
    assert.equal(act.state.lastBy, 'ben', 'the sender is whoever the socket belongs to');
    assert.deepEqual(ben.act.state.shared, { a: 1, c: 'z' }, 'the sender had the new state before its ack');

    // Over a limit: refused whole, told why, and nobody's state moves.
    assert.deepEqual(await send(ann, 'v-sync', { kind: 'set', patch: { good: 1, big: 'x'.repeat(70_000) } }), { ok: false, reason: 'too-large' });
    assert.deepEqual(await send(ann, 'v-sync', { kind: 'set', patch: JSON.parse('{"__proto__":{"polluted":1}}') }), { ok: false, reason: 'bad-key' });
    assert.deepEqual(await send(ann, 'v-sync', { kind: 'set', patch: { n: JSON.parse('{"__proto__":{"polluted":1}}') } }), { ok: false, reason: 'invalid' });
    assert.deepEqual(await send(ann, 'v-sync', { kind: 'replace', shared: 'nope' }), { ok: false, reason: 'invalid' });
    assert.deepEqual(ann.act.state.shared, { a: 1, c: 'z' });
    assert.equal(ann.act.state.rev, 2);

    assert.deepEqual(await send(ann, 'v-sync', { kind: 'replace', shared: { only: true } }), { ok: true, rev: 3 });
    assert.deepEqual(ann.act.state.shared, { only: true });
    assert.equal(ann.act.state.lastBy, 'ann');
    // The server is still standing and still sane after the hostile patches.
    const health = await call('GET', '/apps', undefined, tokens.ann);
    assert.equal(health.status, 200);
  });

  test('uploaded code reaches nobody who has not chosen to join', async () => {
    const ann = await enter('ann', 'v-optin');
    const ben = await enter('ben', 'v-optin');
    const benSees = once(ben, 'activity:update', isApp);
    await startApp(ann, 'v-optin');
    // Ben is in the room, so he is told it is running — which is all the Join card needs.
    const card = await benSees;
    assert.equal(card.state.name, 'Bridge App');
    assert.equal(card.by, 'ann');
    assert.deepEqual(card.state.joined, ['ann']);

    await send(ann, 'v-optin', { kind: 'set', patch: { round: 1 } });
    await send(ann, 'v-optin', { kind: 'emit', data: 'hello?' });
    // He cannot drive it without joining either.
    assert.deepEqual(await send(ben, 'v-optin', { kind: 'set', patch: { cheat: true } }), { ok: false, reason: 'not-joined' });
    assert.deepEqual(await send(ben, 'v-optin', { kind: 'emit', data: 'boo' }), { ok: false, reason: 'not-joined' });
    await sleep(250);
    assert.ok(ben.updates.filter(isApp).every((u) => Object.keys(u.state.shared).length === 0), 'no shared state before joining');
    assert.equal(ben.updates.filter(isApp).length, 1, 'and no update per state change either');
    assert.deepEqual(ben.messages, []);
    assert.deepEqual(ann.messages, []);

    // Joining hands him the state as it stands.
    assert.equal((await send(ben, 'v-optin', { kind: 'join' })).ok, true);
    assert.deepEqual(ben.act.state.shared, { round: 1 });
    assert.deepEqual(ben.act.state.joined, ['ann', 'ben']);

    // Someone arriving in the voice room later gets the card, not the state.
    const cara = await enter('cara');
    const late = once(cara, 'activity:update', isApp);
    cara.emit('voice:join', { serverId: 'demo', channelId: 'v-optin' });
    const lateCard = await late;
    assert.deepEqual(lateCard.state.shared, {});
    assert.deepEqual(lateCard.state.joined, ['ann', 'ben']);
  });

  test('a message reaches the others who joined: not the sender, not the room next door, and is not stored', async () => {
    const ann = await enter('ann', 'v-emit');
    const ben = await enter('ben', 'v-emit');
    const cara = await enter('cara', 'v-emit');     // in the room, has not joined the app
    const dana = await enter('dana', 'v-elsewhere'); // a member of the server, in another voice room
    await startApp(ann, 'v-emit');
    await send(ben, 'v-emit', { kind: 'join' });

    const got = once(ben, 'activity:app-message');
    assert.deepEqual(await send(ann, 'v-emit', { kind: 'emit', data: { buzz: 1 }, from: 'dana' }), { ok: true, rev: 0 });
    assert.deepEqual(await got, { from: 'ann', data: { buzz: 1 } });
    await sleep(250);
    assert.deepEqual(ben.messages, [{ from: 'ann', data: { buzz: 1 } }]);
    assert.deepEqual(ann.messages, [], 'the sender does not hear its own message');
    assert.deepEqual(cara.messages, [], 'in the room but not in the app');
    assert.deepEqual(dana.messages, [], 'another room');
    assert.deepEqual(ann.act.state.shared, {}, 'nothing was stored');
    assert.equal(ann.act.state.rev, 0);
    assert.ok(!JSON.stringify(ann.act).includes('buzz'));

    assert.deepEqual(await send(ann, 'v-emit', { kind: 'emit', data: 'x'.repeat(9000) }), { ok: false, reason: 'too-large' });
    await sleep(150);
    assert.equal(ben.messages.length, 1);
  });

  test('a flooding app is cut off at the rate limit', async () => {
    const ann = await enter('ann', 'v-flood');
    const ben = await enter('ben', 'v-flood');
    await startApp(ann, 'v-flood');
    await send(ben, 'v-flood', { kind: 'join' });
    const answers = await Promise.all(Array.from({ length: 300 }, (_, i) => send(ann, 'v-flood', i % 2 ? { kind: 'emit', data: i } : { kind: 'set', patch: { i } })));
    await sleep(300);
    const accepted = answers.filter((x) => x.ok).length;
    // Ann's start already spent one token, and a few trickle back in while the flood is in flight.
    assert.ok(accepted >= 25 && accepted <= 45, `expected roughly a burst of 30 to get through, got ${accepted}`);
    assert.ok(answers.filter((x) => !x.ok).every((x) => x.reason === 'rate-limited'));
    assert.ok(ben.messages.length <= accepted, 'nothing over the limit was relayed');
    assert.ok(ben.messages.length + ben.act.state.rev === accepted, 'every accepted event is accounted for, and no others');
    // One socket's flood is its own problem: Ben is not throttled by it.
    assert.equal((await send(ben, 'v-flood', { kind: 'set', patch: { fine: true } })).ok, true);
  });

  test('a server member who is not in the voice room cannot start, drive or stop an app', async () => {
    const ann = await enter('ann', 'v-gate');
    const cara = await enter('cara'); // joined the demo server; never joined this voice room
    cara.emit('activity:start', { serverId: 'demo', channelId: 'v-gate', type: 'app', appId: bundleApp.id });
    await sleep(400);
    assert.ok(!ann.updates.some(isApp), 'nothing was started');

    await startApp(ann, 'v-gate');
    await send(ann, 'v-gate', { kind: 'set', patch: { score: 1 } });
    for (const event of [{ kind: 'join' }, { kind: 'set', patch: { score: 999 } }, { kind: 'replace', shared: {} }, { kind: 'emit', data: 'hi' }, { kind: 'leave' }]) {
      assert.deepEqual(await send(cara, 'v-gate', event), { ok: false, reason: 'not-in-room' });
    }
    cara.emit('activity:stop', { serverId: 'demo', channelId: 'v-gate' });
    // Replacing it with a built-in would be stopping it by another name.
    cara.emit('activity:start', { serverId: 'demo', channelId: 'v-gate', type: 'ttt' });
    cara.emit('activity:start', { serverId: 'demo', channelId: 'v-gate', type: 'app', appId: secondApp.id });
    await sleep(400);
    assert.deepEqual(await send(ann, 'v-gate', { kind: 'set', patch: { still: 'here' } }), { ok: true, rev: 2 });
    assert.deepEqual(ann.act.state.shared, { score: 1, still: 'here' });
    assert.equal(ann.act.state.appId, bundleApp.id);
    assert.deepEqual(ann.act.state.joined, ['ann']);
    assert.ok(ann.updates.every((u) => u === null || u.type === 'app'), 'the room never saw it end or change');
    assert.deepEqual(cara.updates.filter(Boolean), [], 'and the outsider was told nothing about it');

    // Someone in the room can still end it, as with any activity.
    const ended = once(ann, 'activity:update', (v) => v === null);
    ann.emit('activity:stop', { serverId: 'demo', channelId: 'v-gate' });
    await ended;
  });

  test('the joined list follows people as they leave the app, leave voice, or disconnect', async () => {
    const ann = await enter('ann', 'v-joined');
    const ben = await enter('ben', 'v-joined');
    const cara = await enter('cara', 'v-joined');
    await startApp(ann, 'v-joined');
    await send(ann, 'v-joined', { kind: 'set', patch: { big: 'x'.repeat(50_000) } });
    const annUpdates = ann.updates.length;

    let seen = once(ann, 'activity:app-joined', listIs(['ann', 'ben', 'cara']));
    await send(ben, 'v-joined', { kind: 'join' });
    await send(cara, 'v-joined', { kind: 'join' });
    await seen;
    assert.equal(cara.act.state.shared.big.length, 50_000, 'whoever joins is handed the state');
    assert.deepEqual(cara.act.state.joined, ['ann', 'ben', 'cara']);

    // Leaving the app (the Leave button) — still in voice.
    seen = once(ann, 'activity:app-joined', listIs(['ann', 'cara']));
    assert.equal((await send(ben, 'v-joined', { kind: 'leave' })).ok, true);
    await seen;
    assert.deepEqual(ben.act.state.shared, {}, 'whoever leaves is sent the card view, without the state');
    assert.deepEqual(ben.act.state.joined, ['ann', 'cara']);
    assert.deepEqual(await send(ben, 'v-joined', { kind: 'set', patch: { x: 1 } }), { ok: false, reason: 'not-joined' }, 'having left, he no longer drives it');

    // Leaving the voice room.
    seen = once(ann, 'activity:app-joined', listIs(['ann']));
    cara.emit('voice:leave', { serverId: 'demo', channelId: 'v-joined' });
    await seen;

    // Dropping off the network.
    seen = once(ann, 'activity:app-joined', listIs(['ann', 'ben']));
    await send(ben, 'v-joined', { kind: 'join' });
    await seen;
    seen = once(ann, 'activity:app-joined', listIs(['ann']));
    ben.close();
    await seen;

    // None of that coming and going re-sent the 50 KB of state to someone who already had it: a
    // socket toggling join/leave must not be a way to pour the shared object into the room.
    assert.equal(ann.updates.length, annUpdates, 'the list travels alone');
    assert.ok(ann.lists.every((m) => m.run === ann.act.state.run && !('shared' in m)));
    assert.deepEqual(ann.act.state.joined, ['ann']);
    const dana = await enter('dana', 'v-joined');
    for (let i = 0; i < 10; i++) {
      await send(dana, 'v-joined', { kind: 'join' });
      await send(dana, 'v-joined', { kind: 'leave' });
    }
    assert.equal(ann.updates.length, annUpdates);
    assert.ok(JSON.stringify(ann.lists).length < 4000, 'twenty list changes cost a few kilobytes, not a megabyte');
  });

  test('over sockets: small changes on top of a large state are held to the byte budget', async () => {
    const ann = await enter('ann', 'v-bytes');
    const ben = await enter('ben', 'v-bytes');
    await startApp(ann, 'v-bytes');
    await send(ben, 'v-bytes', { kind: 'join' });
    assert.equal((await send(ann, 'v-bytes', { kind: 'set', patch: { big: 'x'.repeat(60_000) } })).ok, true);
    // Well inside the event rate (a burst of 30), so only the byte budget can be what stops these.
    const answers = await Promise.all(Array.from({ length: 24 }, (_, i) => send(ann, 'v-bytes', { kind: 'set', patch: { n: i } })));
    await sleep(200);
    const accepted = answers.filter((x) => x.ok).length;
    assert.ok(accepted >= 7 && accepted <= 9, `expected about 7 of 24 (512 KB of burst less the first send), got ${accepted}`);
    assert.ok(answers.filter((x) => !x.ok).every((x) => x.reason === 'rate-limited'));
    // Counted by rev rather than from "now": Ben's copy of the big change may still be on its way.
    assert.equal(ben.updates.filter((u) => isApp(u) && u.state.rev > 1).length, accepted, 'the other participant was sent one state per accepted change and no more');
    assert.equal(ben.act.state.rev, 1 + accepted);
  });

  test('an event meant for another activity never lands on the one that replaced it', async () => {
    const ann = await enter('ann', 'v-stale');
    const cara = await enter('cara', 'v-stale');
    const first = await startApp(ann, 'v-stale');
    await send(cara, 'v-stale', { kind: 'join' });

    // The same app started again: a set from the previous run's frame, still on the wire, is not
    // written into the new run's state — even though the server has its sender down as joined.
    const second = await startApp(ann, 'v-stale');
    assert.notEqual(second.state.run, first.state.run);
    assert.deepEqual(await send(ann, 'v-stale', { kind: 'set', patch: { fromOldFrame: 1 } }, first.state.run), { ok: false, reason: 'ended' });
    assert.deepEqual(await send(ann, 'v-stale', { kind: 'emit', data: 'old' }, first.state.run), { ok: false, reason: 'ended' });
    // A built-in's event (they carry no tag) that arrives after an app took over: its "join" does
    // not put that person in the app.
    assert.deepEqual(await send(cara, 'v-stale', { kind: 'join' }, UNTAGGED), { ok: false, reason: 'ended' });
    assert.deepEqual(await send(ann, 'v-stale', { kind: 'set', patch: { real: 1 } }), { ok: true, rev: 1 });
    assert.deepEqual(ann.act.state.shared, { real: 1 });
    assert.deepEqual(ann.act.state.joined, ['ann']);
    assert.deepEqual(cara.messages, []);

    // The other way round: the app's Join, landing after Tic-Tac-Toe replaced it, seats nobody —
    // and is answered, so the card does not wait five seconds to say so.
    const ttt = once(ann, 'activity:update', (v) => v != null && v.type === 'ttt');
    ann.emit('activity:start', { serverId: 'demo', channelId: 'v-stale', type: 'ttt' });
    await ttt;
    assert.deepEqual(await send(cara, 'v-stale', { kind: 'join' }), { ok: false, reason: 'ended' });
    // An untagged join after it is the game's own, and shows the tagged one above changed nothing.
    const seated = once(ann, 'activity:update', (v) => v != null && v.type === 'ttt' && !!v.state.players.X);
    ann.emit('activity:event', { serverId: 'demo', channelId: 'v-stale', event: { kind: 'join' } });
    assert.deepEqual((await seated).state.players, { X: 'ann' });

    // And with no activity at all (the room emptied and the app went with it): still answered.
    const ended = once(ann, 'activity:update', (v) => v === null);
    ann.emit('activity:stop', { serverId: 'demo', channelId: 'v-stale' });
    await ended;
    assert.deepEqual(await send(ann, 'v-stale', { kind: 'set', patch: { x: 1 } }), { ok: false, reason: 'ended' });
  });

  test('a null payload does not take the server down', async () => {
    // No token: this needs no account. An explicit null is not covered by a handler's `= {}` default.
    const anon = io(base, { transports: ['websocket'], forceNew: true });
    open.push(anon);
    await once(anon, 'connect');
    for (const event of ['activity:event', 'activity:start', 'activity:stop', 'voice:join', 'voice:leave', 'stream:announce', 'collab:start', 'join']) {
      anon.emit(event, null);
      anon.emit(event, null, () => {});
    }
    await sleep(500);
    assert.equal((await call('GET', '/apps', undefined, tokens.ann)).status, 200, 'still answering');
    // And still doing its job for everyone else.
    const ann = await enter('ann', 'v-null');
    await startApp(ann, 'v-null');
    assert.equal((await send(ann, 'v-null', { kind: 'set', patch: { ok: 1 } })).ok, true);
    // Nulls further in are each handler's own business; the app path must take them too.
    assert.deepEqual(await send(ann, 'v-null', null), { ok: false, reason: 'invalid' });
    assert.deepEqual(await send(ann, 'v-null', { kind: 'set', patch: null }), { ok: false, reason: 'invalid' });
  });

  test('deleting the app ends it wherever it is running', async () => {
    const ann = await enter('ann', 'v-delete');
    const ben = await enter('ben', 'v-delete');
    const other = await enter('cara', 'v-delete-other');
    await startApp(ann, 'v-delete', secondApp.id);
    await startApp(other, 'v-delete-other', bundleApp.id); // a different app, which must survive
    const endedForAnn = once(ann, 'activity:update', (v) => v === null);
    const endedForBen = once(ben, 'activity:update', (v) => v === null);

    // Only the uploader may delete; someone else trying ends nothing.
    assert.equal((await call('DELETE', `/apps/${secondApp.id}`, undefined, tokens.ben)).status, 403);
    assert.equal((await send(ann, 'v-delete', { kind: 'set', patch: { alive: true } })).ok, true);

    assert.equal((await call('DELETE', `/apps/${secondApp.id}`, undefined, tokens.ann)).status, 200);
    await Promise.all([endedForAnn, endedForBen]);
    assert.equal((await send(other, 'v-delete-other', { kind: 'set', patch: { ok: 1 } })).ok, true, 'other apps keep running');
    // And it cannot be started again.
    ann.emit('activity:start', { serverId: 'demo', channelId: 'v-delete', type: 'app', appId: secondApp.id });
    await sleep(300);
    assert.equal(ann.act, null);
  });

  test('built-in activities are unaffected', async () => {
    const ann = await enter('ann', 'v-builtin');
    const started = once(ann, 'activity:update', (v) => v != null && v.type === 'poll');
    ann.emit('activity:start', { serverId: 'demo', channelId: 'v-builtin', type: 'poll' });
    await started;
    const created = once(ann, 'activity:update', (v) => v != null && v.type === 'poll' && v.state.question === 'Pizza?');
    ann.emit('activity:event', { serverId: 'demo', channelId: 'v-builtin', event: { kind: 'create', question: 'Pizza?', options: ['yes', 'no'] } });
    await created;
    // App-style events mean nothing to a built-in, and an app start over one is an ordinary swap.
    ann.emit('activity:event', { serverId: 'demo', channelId: 'v-builtin', event: { kind: 'set', patch: { question: 'hacked' } } });
    const swapped = await startApp(ann, 'v-builtin');
    assert.equal(swapped.state.name, 'Bridge App');
  });

  test('the SDK is served as JavaScript, loadable from an opaque origin, and is not the SPA shell', async () => {
    const res = await fetch(base + '/sdk/lanparty.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /javascript/);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('cache-control') || '', /max-age=\d+/);
    const body = await res.text();
    assert.match(body, /LANParty/);
    assert.doesNotMatch(body, /<!doctype html>/i);
    assert.equal(body, fs.readFileSync(path.join(__dirname, '..', 'sdk', 'lanparty.js'), 'utf8'));
    // No session needed, and none is asked for: it is a public file.
    assert.equal(res.headers.get('set-cookie'), null);

    const miss = await fetch(base + '/sdk/nope.js');
    assert.equal(miss.status, 404);
    assert.doesNotMatch(await miss.text(), /<!doctype html>/i, 'a wrong SDK path must not be the SPA HTML');
  });
});

// ---------------------------------------------------------------------------------------------
describe('SDK shim (server/sdk/lanparty.js)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sdk', 'lanparty.js'), 'utf8');
  // Values made inside the vm belong to another realm, so compare them by content.
  const plain = (v) => JSON.parse(JSON.stringify(v));

  // The shim in a sandbox with just enough of a window: a parent that records what it is sent, and
  // a way to deliver a message event "from" any window we like.
  function load({ framed = true } = {}) {
    const sent = [];
    const targets = [];
    const parent = { postMessage(message, targetOrigin) { sent.push(plain(message)); targets.push(targetOrigin); } };
    const listeners = new Set();
    const warnings = [];
    const window = {
      addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
      removeEventListener(type, fn) { listeners.delete(fn); },
      console: { warn: (...args) => warnings.push(args.join(' ')), error() {} },
    };
    window.parent = framed ? parent : window;
    // The real URL parser, as a page has: hostOrigins entries are normalised with it.
    window.URL = URL;
    vm.runInNewContext(source, { window, setTimeout, clearTimeout, setInterval, clearInterval }, { filename: 'lanparty.js' });
    // `origin` is left off unless a test names one, as it always was: without hostOrigins the shim
    // must not so much as look at it.
    const deliver = (data, from = parent, origin = undefined) => {
      const event = origin === undefined ? { source: from, data } : { source: from, data, origin };
      for (const fn of [...listeners]) fn(event);
    };
    const ofType = (type) => sent.filter((m) => m.type === type);
    return { LANParty: window.LANParty, window, parent, sent, targets, deliver, ofType, warnings, listeners };
  }
  const ann = { username: 'ann', displayName: 'Ann', avatarUrl: '/avatars/a.png' };
  const ben = { username: 'ben', displayName: 'Ben', avatarUrl: '' };
  const welcome = (extra = {}) => ({ lanparty: 1, type: 'welcome', me: ann, participants: [ann, ben], shared: { round: 2 }, rev: 5, ...extra });
  async function connected(extra) {
    const env = load();
    const pending = env.LANParty.connect({ timeoutMs: 2000 });
    env.deliver(welcome(extra));
    const lp = await pending;
    return { ...env, lp };
  }

  test('defines one global with connect()', () => {
    const { LANParty } = load();
    assert.equal(typeof LANParty.connect, 'function');
    assert.equal(LANParty.protocol, 1);
  });

  test('LANParty.limits carries the server\'s numbers, the rate included', () => {
    const { LANParty } = load();
    const server = createActivities({ io: { sockets: { adapter: { rooms: new Map() } } }, clients: {} }).APP_LIMITS;
    assert.deepEqual(plain(LANParty.limits), { sharedBytes: 65536, keys: 200, keyLength: 64, messageBytes: 8192, depth: 32, burst: 30, perSecond: 15 });
    for (const [name, value] of Object.entries(plain(LANParty.limits))) assert.equal(value, server[name], name);
  });

  test('hello / welcome handshake', async () => {
    const env = load();
    const pending = env.LANParty.connect({ timeoutMs: 2000 });
    assert.deepEqual(env.sent[0], { type: 'hello', sdk: 1, lanparty: 1 });
    assert.ok(env.targets.every((t) => t === '*'), 'an opaque-origin frame cannot name its host');
    assert.equal(env.LANParty.connect(), pending, 'connect() is one connection, however often it is called');
    env.deliver(welcome());
    const lp = await pending;
    assert.equal(lp.standalone, false);
    assert.deepEqual(plain(lp.me), ann);
    assert.deepEqual(plain(lp.participants), [ann, ben]);
    assert.deepEqual(plain(lp.state), { round: 2 });
    assert.equal(lp.rev, 5);
    // Once welcomed it stops knocking.
    const hellos = env.ofType('hello').length;
    await sleep(350);
    assert.equal(env.ofType('hello').length, hellos);
    env.deliver({ lanparty: 1, type: 'closed' });
  });

  test('hello is repeated until the host answers', async () => {
    const env = load();
    const pending = env.LANParty.connect({ timeoutMs: 3000 });
    await sleep(600); // the host's listener was not attached yet
    assert.ok(env.ofType('hello').length >= 2);
    env.deliver(welcome());
    assert.equal((await pending).standalone, false);
  });

  test('setState applies at once, and the host\'s answer confirms it', async () => {
    const { lp, deliver, ofType } = await connected();
    const events = [];
    lp.on('state', (state, info) => events.push({ state: plain(state), info: plain(info) }));

    assert.equal(lp.setState({ score: 1 }), true);
    assert.deepEqual(plain(lp.state), { round: 2, score: 1 }, 'visible before the server has seen it');
    const [msg] = ofType('set');
    assert.deepEqual(msg, { type: 'set', id: msg.id, patch: { score: 1 }, lanparty: 1 });
    assert.equal(events[0].info.local, true);

    // Someone else's change lands first: ours stays on top of it until it is answered.
    deliver({ lanparty: 1, type: 'state', shared: { round: 3 }, rev: 6, lastBy: 'ben' });
    assert.deepEqual(plain(lp.state), { round: 3, score: 1 });
    // Then the state that includes ours, then the ack.
    deliver({ lanparty: 1, type: 'state', shared: { round: 3, score: 1 }, rev: 7, lastBy: 'ann' });
    deliver({ lanparty: 1, type: 'ack', id: msg.id, ok: true });
    assert.deepEqual(plain(lp.state), { round: 3, score: 1 });
    assert.equal(lp.rev, 7);
    assert.deepEqual(events.at(-1).info, { rev: 7, by: 'ann', local: false });

    // null deletes; replaceState swaps everything.
    lp.setState({ round: null });
    assert.deepEqual(plain(lp.state), { score: 1 });
    lp.replaceState({ fresh: true });
    assert.deepEqual(plain(lp.state), { fresh: true });
    assert.deepEqual(ofType('replace')[0].shared, { fresh: true });
    deliver({ lanparty: 1, type: 'closed' });
  });

  test('a change the host refuses is rolled back', async () => {
    const { lp, deliver, ofType } = await connected();
    const infos = [];
    lp.on('state', (state, info) => infos.push(plain(info)));
    lp.setState({ cheat: true });
    assert.equal(lp.state.cheat, true);
    deliver({ lanparty: 1, type: 'ack', id: ofType('set')[0].id, ok: false, reason: 'rate-limited' });
    assert.deepEqual(plain(lp.state), { round: 2 });
    assert.equal(infos.at(-1).rejected, true);
    assert.equal(infos.at(-1).reason, 'rate-limited');
  });

  test('lp.state is a copy: writing to it changes nothing', async () => {
    const { lp, deliver, sent } = await connected();
    const before = sent.length;
    lp.state.round = 99;
    lp.state.injected = true;
    assert.equal(sent.length, before, 'nothing is sent');
    deliver({ lanparty: 1, type: 'state', shared: { round: 2 }, rev: 6 });
    assert.deepEqual(plain(lp.state), { round: 2 });
    lp.participants.push({ username: 'ghost' });
    lp.me.username = 'admin';
    assert.equal(lp.participants.length, 2);
    assert.equal(lp.me.username, 'ann');
  });

  // The same wrong code — editing lp.state in place and never calling setState for it — has to do
  // the same thing (nothing) under a host and standalone, or an app developed by opening the file
  // behaves differently once it is in a room.
  test('an in-place edit of lp.state is never kept, hosted or standalone', async () => {
    const hosted = await connected({ shared: { items: [1], round: 2 } });
    const alone = load({ framed: false });
    const lpAlone = await alone.LANParty.connect();
    lpAlone.setState({ items: [1], round: 2 });

    for (const lp of [hosted.lp, lpAlone]) {
      assert.notEqual(lp.state, lp.state, 'a fresh copy on every read');
      lp.state.items.push('never sent');
      assert.deepEqual(plain(lp.state.items), [1], 'gone at once, not at the next update');
      // What a handler is given is a copy too.
      let handed = null;
      const off = lp.on('state', (state) => { handed = state; state.items.push('from a handler'); state.planted = true; });
      assert.equal(lp.setState({ round: 3 }), true, 'an unrelated change');
      off();
      assert.deepEqual(plain(handed.items), [1, 'from a handler'], 'the handler really did write to what it got');
      assert.deepEqual(plain(lp.state), { items: [1], round: 3 }, 'and none of it was baked into the state');
    }
    assert.deepEqual(hosted.ofType('set').map((m) => m.patch), [{ round: 3 }], 'nor sent to anyone');
    hosted.deliver({ lanparty: 1, type: 'closed' });
  });

  test('messages from any window but the parent are ignored', async () => {
    const env = load();
    const stranger = { postMessage() {} };
    let resolved = false;
    const pending = env.LANParty.connect({ timeoutMs: 2000 }).then((lp) => { resolved = true; return lp; });
    // Another frame racing to answer the hello with an identity of its choosing.
    env.deliver(welcome({ me: { username: 'admin', displayName: 'Admin', avatarUrl: '' } }), stranger);
    env.deliver(welcome({ me: { username: 'admin' } }), null);
    await sleep(50);
    assert.equal(resolved, false, 'a welcome from elsewhere does not connect the app');
    env.deliver(welcome());
    const lp = await pending;
    assert.equal(lp.me.username, 'ann');

    const heard = [];
    for (const type of ['state', 'participants', 'message', 'closed']) lp.on(type, () => heard.push(type));
    env.deliver({ lanparty: 1, type: 'state', shared: { round: 999 }, rev: 100 }, stranger);
    env.deliver({ lanparty: 1, type: 'participants', participants: [] }, stranger);
    env.deliver({ lanparty: 1, type: 'message', from: 'ben', data: 'fake' }, stranger);
    env.deliver({ lanparty: 1, type: 'closed' }, stranger);
    assert.deepEqual(heard, []);
    assert.deepEqual(plain(lp.state), { round: 2 });
    assert.equal(lp.participants.length, 2);
    assert.equal(lp.closed, false);

    // From the parent, but not in the protocol's envelope: also ignored.
    env.deliver({ type: 'state', shared: { round: 999 } });
    env.deliver({ lanparty: 2, type: 'state', shared: { round: 999 } });
    env.deliver('state');
    env.deliver(null);
    assert.deepEqual(heard, []);
    env.deliver({ lanparty: 1, type: 'closed' });
  });

  test('participants, messages and closed reach their handlers; unsubscribe works', async () => {
    const { lp, deliver, sent } = await connected();
    const got = { participants: [], message: [], closed: [] };
    const off = lp.on('participants', (list) => got.participants.push(plain(list)));
    lp.on('message', (m) => got.message.push(plain(m)));
    lp.on('closed', (c) => got.closed.push(plain(c)));
    lp.on('message', () => { throw new Error('a broken handler must not break the rest'); });

    deliver({ lanparty: 1, type: 'participants', participants: [ann] });
    assert.deepEqual(got.participants, [[ann]]);
    assert.deepEqual(plain(lp.participants), [ann]);
    off();
    deliver({ lanparty: 1, type: 'participants', participants: [ann, ben] });
    assert.equal(got.participants.length, 1, 'unsubscribed');
    assert.equal(lp.participants.length, 2, 'but the list itself stays live');

    deliver({ lanparty: 1, type: 'message', from: 'ben', data: { buzz: 1 } });
    assert.deepEqual(got.message, [{ from: 'ben', data: { buzz: 1 } }]);

    assert.equal(lp.emit({ buzz: 2 }), true);
    assert.deepEqual(sent.at(-1), { type: 'emit', data: { buzz: 2 }, lanparty: 1 });
    assert.throws(() => lp.on('nonsense', () => {}), /unknown event/);

    deliver({ lanparty: 1, type: 'closed', reason: 'ended' });
    assert.deepEqual(got.closed, [{ reason: 'ended' }]);
    assert.equal(lp.closed, true);
    const count = sent.length;
    assert.equal(lp.setState({ late: true }), false);
    assert.equal(lp.emit('late'), false);
    assert.equal(sent.length, count, 'nothing is sent once closed');
  });

  test('changes that could never be accepted are refused locally and not sent', async () => {
    const { lp, sent, warnings, deliver } = await connected();
    const count = sent.length;
    assert.equal(lp.setState(JSON.parse('{"__proto__":{"polluted":1}}')), false);
    assert.equal(lp.setState({ nested: JSON.parse('{"__proto__":{"polluted":1}}') }), false);
    assert.equal(lp.setState({ ['k'.repeat(65)]: 1 }), false);
    assert.equal(lp.setState({ big: 'x'.repeat(70_000) }), false);
    assert.equal(lp.setState({ fn() {} }), false);
    assert.equal(lp.setState('nope'), false);
    assert.equal(lp.replaceState(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, i]))), false);
    assert.equal(lp.emit('x'.repeat(9000)), false);
    assert.equal(sent.length, count);
    assert.deepEqual(plain(lp.state), { round: 2 });
    assert.ok(warnings.length >= 8, 'each refusal says why in the console');
    assert.equal(({}).polluted, undefined);
    // A hostile welcome/state from the host side cannot plant anything either.
    deliver({ lanparty: 1, type: 'state', shared: JSON.parse('{"__proto__":{"polluted":1},"ok":1}'), rev: 9 });
    assert.equal(({}).polluted, undefined);
    assert.equal(lp.state.polluted, undefined);
  });

  test('standalone when no host answers in time', async () => {
    const env = load();
    const started = Date.now();
    const lp = await env.LANParty.connect({ timeoutMs: 60 });
    assert.ok(Date.now() - started < 1000);
    assert.equal(lp.standalone, true);
    assert.deepEqual(plain(lp.me), { username: 'you', displayName: 'You', avatarUrl: '' });
    assert.deepEqual(plain(lp.participants), [plain(lp.me)]);
    assert.deepEqual(plain(lp.state), {});
    assert.equal(env.listeners.size, 0, 'it stops listening');

    // State is purely local, and behaves the same way.
    const events = [];
    lp.on('state', (state, info) => events.push({ state: plain(state), info: plain(info) }));
    const count = env.sent.length;
    assert.equal(lp.setState({ score: 1, gone: 1 }), true);
    assert.equal(lp.setState({ gone: null }), true);
    assert.deepEqual(plain(lp.state), { score: 1 });
    assert.equal(events.length, 2);
    assert.equal(events[1].info.local, true);
    assert.equal(lp.replaceState({ only: 1 }), true);
    assert.deepEqual(plain(lp.state), { only: 1 });
    assert.equal(lp.emit({ buzz: 1 }), true, 'emit succeeds; there is just nobody to hear it');
    assert.equal(lp.setState({ big: 'x'.repeat(70_000) }), false, 'the limits still apply, so an app is developed against them');
    assert.equal(env.sent.length, count, 'nothing is posted to a host that is not there');
    // A welcome that turns up afterwards does not flip an app that already rendered as standalone.
    env.deliver(welcome());
    assert.equal(lp.standalone, true);
    assert.deepEqual(plain(lp.state), { only: 1 });
  });

  test('standalone immediately when the page is not framed', async () => {
    const env = load({ framed: false });
    const lp = await env.LANParty.connect();
    assert.equal(lp.standalone, true);
    assert.deepEqual(env.sent, [], 'no hello to nobody');
    assert.equal(env.listeners.size, 0);
    assert.equal(lp.setState({ a: 1 }), true);
    assert.deepEqual(plain(lp.state), { a: 1 });
    assert.equal(lp.room, null, 'no host, no room');
  });

  // --- lp.room: the app's opaque id for the voice channel it is running in ---
  const ROOM = 'a3f1'.repeat(8);

  test('lp.room is what the welcome says: an id in a voice room, null without one', async () => {
    const inRoom = await connected({ room: { id: ROOM, serverId: 'demo', channelId: 'voice1', extra: true } });
    assert.deepEqual(plain(inRoom.lp.room), { id: ROOM }, 'the id and nothing else that came with it');
    // A copy, like everything else lp hands out.
    inRoom.lp.room.id = 'somewhere-else';
    assert.equal(inRoom.lp.room.id, ROOM);
    assert.notEqual(inRoom.lp.room, inRoom.lp.room);
    // A later welcome (the host re-attached) carries the room as it is now.
    inRoom.deliver(welcome({ room: null }));
    assert.equal(inRoom.lp.room, null);
    inRoom.deliver(welcome({ room: { id: ROOM } }));
    assert.deepEqual(plain(inRoom.lp.room), { id: ROOM });
    inRoom.deliver({ lanparty: 1, type: 'closed' });

    // The solo viewer says null; a host from before rooms existed says nothing at all.
    for (const extra of [{ room: null }, {}]) {
      const solo = await connected(extra);
      assert.equal(solo.lp.room, null);
      solo.deliver({ lanparty: 1, type: 'closed' });
    }
    // Anything that is not { id: non-empty string } is no room, rather than something to trip over.
    for (const room of ['abc', 7, [], {}, { id: 7 }, { id: '' }, { id: null }, { id: 'x'.repeat(129) }, { id: { toString: () => ROOM } }]) {
      const odd = await connected({ room });
      assert.equal(odd.lp.room, null, JSON.stringify(room));
      odd.deliver({ lanparty: 1, type: 'closed' });
    }
  });

  test('standalone has no room, even if a welcome turns up late', async () => {
    const env = load();
    const lp = await env.LANParty.connect({ timeoutMs: 40 });
    assert.equal(lp.standalone, true);
    assert.equal(lp.room, null);
    env.deliver(welcome({ room: { id: ROOM } }));
    assert.equal(lp.room, null);
  });

  // --- hostOrigins: for an app with an origin of its own, which must not trust whoever frames it ---
  const HOST = 'https://lanparty.example.test';
  const OTHER = 'http://localhost:3000';
  const EVIL = 'https://evil.example';

  test('hostOrigins: hello is posted to each listed origin by name, never to "*"', async () => {
    const env = load();
    const pending = env.LANParty.connect({ hostOrigins: [HOST, OTHER], timeoutMs: 2000 });
    assert.deepEqual(env.sent, [{ type: 'hello', sdk: 1, lanparty: 1 }, { type: 'hello', sdk: 1, lanparty: 1 }]);
    assert.deepEqual(env.targets, [HOST, OTHER], 'one per listed origin');
    await sleep(300); // the repeats go the same way
    assert.ok(env.targets.length >= 4);
    assert.ok(env.targets.every((t) => t === HOST || t === OTHER));
    assert.ok(!env.targets.includes('*'));
    env.deliver(welcome(), env.parent, HOST);
    const lp = await pending;
    assert.equal(lp.standalone, false);
    assert.equal(lp.me.username, 'ann');

    // From the welcome on there is one host, and only it is addressed.
    const before = env.targets.length;
    lp.setState({ score: 1 });
    lp.replaceState({ only: 1 });
    lp.emit('hi');
    assert.deepEqual(env.targets.slice(before), [HOST, HOST, HOST]);
    assert.ok(!env.targets.includes('*'));
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, HOST);
  });

  test('hostOrigins: the parent window on an origin that is not listed is not the host', async () => {
    const env = load();
    let resolved = false;
    const pending = env.LANParty.connect({ hostOrigins: [HOST], timeoutMs: 2000 }).then((lp) => { resolved = true; return lp; });
    // A page that frames the app IS its parent window, so event.source alone cannot tell it from
    // LAN Party. It answers the hello with an identity and a room of its choosing.
    const forged = welcome({ me: { username: 'admin', displayName: 'Admin', avatarUrl: '' }, room: { id: 'f'.repeat(32) } });
    env.deliver(forged, env.parent, EVIL);
    env.deliver(forged, env.parent, 'null');                       // a sandboxed or data: page
    env.deliver(forged, env.parent, HOST + '.evil.example');       // a name that merely starts the same
    env.deliver(forged, env.parent, 'http://lanparty.example.test'); // right host, wrong scheme
    env.deliver(forged, env.parent, HOST + ':8443');
    env.deliver(forged, env.parent);                               // no origin at all
    env.deliver(forged, { postMessage() {} }, HOST);               // right origin, but not the parent
    await sleep(50);
    assert.equal(resolved, false, 'none of those connected the app');

    env.deliver(welcome({ room: { id: ROOM } }), env.parent, HOST);
    const lp = await pending;
    assert.equal(lp.me.username, 'ann');
    assert.deepEqual(plain(lp.room), { id: ROOM });

    // The same holds for everything after the welcome.
    const heard = [];
    for (const type of ['state', 'participants', 'message', 'closed']) lp.on(type, () => heard.push(type));
    for (const origin of [EVIL, 'null', undefined]) {
      env.deliver({ lanparty: 1, type: 'state', shared: { round: 999 }, rev: 100 }, env.parent, origin);
      env.deliver({ lanparty: 1, type: 'participants', participants: [] }, env.parent, origin);
      env.deliver({ lanparty: 1, type: 'message', from: 'ben', data: 'fake' }, env.parent, origin);
      env.deliver(welcome({ me: { username: 'admin' }, room: { id: 'f'.repeat(32) } }), env.parent, origin);
      env.deliver({ lanparty: 1, type: 'closed' }, env.parent, origin);
    }
    assert.deepEqual(heard, []);
    assert.deepEqual(plain(lp.state), { round: 2 });
    assert.equal(lp.me.username, 'ann');
    assert.deepEqual(plain(lp.room), { id: ROOM });
    assert.equal(lp.closed, false);
    // The real host is still heard.
    env.deliver({ lanparty: 1, type: 'state', shared: { round: 3 }, rev: 6 }, env.parent, HOST);
    assert.deepEqual(heard, ['state']);
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, HOST);
    assert.equal(lp.closed, true);
  });

  test('hostOrigins: once welcomed by one listed origin, another listed origin is not the host either', async () => {
    const env = load();
    const pending = env.LANParty.connect({ hostOrigins: [HOST, OTHER], timeoutMs: 2000 });
    env.deliver(welcome(), env.parent, OTHER);
    const lp = await pending;
    env.deliver({ lanparty: 1, type: 'state', shared: { round: 999 }, rev: 100 }, env.parent, HOST);
    env.deliver(welcome({ me: { username: 'admin' } }), env.parent, HOST);
    assert.deepEqual(plain(lp.state), { round: 2 });
    assert.equal(lp.me.username, 'ann');
    lp.setState({ a: 1 });
    assert.equal(env.targets.at(-1), OTHER);
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, OTHER);
  });

  test('hostOrigins: entries are matched the way the browser spells an origin', async () => {
    const env = load();
    const pending = env.LANParty.connect({ hostOrigins: ['  HTTPS://LanParty.Example.TEST:443/ ', HOST, 'http://LOCALHOST:3000'], timeoutMs: 2000 });
    assert.deepEqual(env.targets, [HOST, OTHER], 'case, a trailing slash and a default port are tidied; repeats dropped');
    env.deliver(welcome(), env.parent, HOST);
    assert.equal((await pending).standalone, false);
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, HOST);
  });

  test('hostOrigins: a trailing slash or a path is dropped, so the entry is the origin event.origin will be', async () => {
    const env = load();
    const pending = env.LANParty.connect({ hostOrigins: [HOST + '/', HOST + '/app/room?x=1#top', 'https://LanParty.Example.TEST:443/app/'], timeoutMs: 2000 });
    assert.deepEqual(env.targets, [HOST], 'one origin, however it was written');
    env.deliver(welcome(), env.parent, HOST);
    assert.equal((await pending).standalone, false);
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, HOST);
  });

  test('hostOrigins: an international name is matched in its punycode form, as the browser reports it', async () => {
    const env = load();
    const PUNY = 'https://xn--bcher-kva.example';
    const pending = env.LANParty.connect({ hostOrigins: ['https://bücher.example/'], timeoutMs: 2000 });
    assert.deepEqual(env.targets, [PUNY]);
    // event.origin is always the ASCII form; the Unicode spelling is never what arrives.
    env.deliver(welcome({ me: { username: 'admin' } }), env.parent, 'https://bücher.example');
    env.deliver(welcome(), env.parent, PUNY);
    const lp = await pending;
    assert.equal(lp.me.username, 'ann');
    lp.setState({ a: 1 });
    assert.equal(env.targets.at(-1), PUNY);
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, PUNY);
  });

  test('hostOrigins: invalid entries are skipped with a warning, and a valid one after them still connects', async () => {
    const env = load();
    const pending = env.LANParty.connect({ hostOrigins: ['*', 'not a url', 42, 'https://user:pw@evil.example', HOST], timeoutMs: 2000 });
    assert.deepEqual(env.targets, [HOST]);
    assert.equal(env.warnings.filter((w) => /hostOrigins entry/.test(w)).length, 4, 'each dropped entry is named');
    env.deliver(welcome(), env.parent, HOST);
    assert.equal((await pending).me.username, 'ann');
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, HOST);
  });

  test('hostOrigins: a target the browser refuses to post to does not stop the ones after it', async () => {
    const env = load();
    // What a browser does with a target origin it cannot use: postMessage throws.
    const real = env.parent.postMessage;
    env.parent.postMessage = (message, target) => {
      if (target === OTHER) throw new SyntaxError("Failed to execute 'postMessage': Invalid target origin");
      real(message, target);
    };
    const pending = env.LANParty.connect({ hostOrigins: [OTHER, HOST], timeoutMs: 2000 });
    assert.deepEqual(env.targets, [HOST], 'the second entry was still knocked on');
    await sleep(300); // and on every repeat, with one warning in all for the refused one
    assert.ok(env.targets.length >= 2 && env.targets.every((t) => t === HOST));
    assert.equal(env.warnings.filter((w) => /could not post/.test(w)).length, 1);
    env.deliver(welcome(), env.parent, HOST);
    const lp = await pending;
    assert.equal(lp.standalone, false);
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, HOST);
  });

  test('hostOrigins: at most 20 origins are used, and the rest are named in a warning', async () => {
    const env = load();
    const many = Array.from({ length: 25 }, (_, i) => `https://lp${i}.example.test`);
    const pending = env.LANParty.connect({ hostOrigins: many, timeoutMs: 2000 });
    assert.deepEqual(env.targets, many.slice(0, 20));
    assert.ok(env.warnings.some((w) => /limited to 20/.test(w) && w.includes(many[20])));
    env.deliver(welcome(), env.parent, many[24]);
    env.deliver(welcome(), env.parent, many[19]);
    assert.equal((await pending).me.username, 'ann');
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, many[19]);
  });

  test('connect() never rejects: a host that cannot be posted to at all, or options that cannot be read, end standalone', async () => {
    const throwing = () => { throw new Error('postMessage is broken'); };
    for (const options of [{ hostOrigins: [HOST], timeoutMs: 80 }, { timeoutMs: 80 }]) {
      const env = load();
      env.parent.postMessage = throwing;
      const lp = await env.LANParty.connect(options);
      assert.equal(lp.standalone, true, JSON.stringify(options));
      assert.equal(env.listeners.size, 0, 'the message listener is not left behind');
      assert.ok(env.warnings.some((w) => /could not post/.test(w)));
      assert.equal(lp.setState({ a: 1 }), true, 'and the session works');
    }
    // Options whose getters throw: no host is trusted, and the promise still resolves.
    const env = load();
    const options = { get hostOrigins() { throw new Error('nope'); } };
    const lp = await env.LANParty.connect(options);
    assert.equal(lp.standalone, true);
    assert.deepEqual(env.sent, []);
    assert.equal(env.listeners.size, 0);
    // And when adding the listener itself fails (the SDK looks it up when connect() is called).
    const broken = load();
    broken.window.addEventListener = () => { throw new Error('no listeners here'); };
    const lp2 = await broken.LANParty.connect({ hostOrigins: [HOST], timeoutMs: 2000 });
    assert.equal(lp2.standalone, true);
    assert.deepEqual(broken.sent, [], 'nothing posted once setting up failed');
  });

  test('hostOrigins that name no usable origin accept no host at all, rather than every host', async () => {
    for (const hostOrigins of [[], ['*'], '*', null, 'nonsense', [5, {}, null], ['https://user@lanparty.example.test'], ['javascript:alert(1)'], ['//lanparty.example.test'], ['https:lanparty.example.test'], ['https:///lanparty.example.test'], ['ftp://lanparty.example.test'], ['https://'], ['https://exa mple.test']]) {
      const env = load();
      const lp = await env.LANParty.connect({ hostOrigins, timeoutMs: 2000 });
      const label = JSON.stringify(hostOrigins);
      assert.equal(lp.standalone, true, label);
      assert.deepEqual(env.sent, [], `${label}: nothing was posted, to "*" or anywhere`);
      assert.equal(env.listeners.size, 0, `${label}: and nothing is listened for`);
      assert.ok(env.warnings.some((w) => /hostOrigins/.test(w)), `${label}: the console says why`);
      env.deliver(welcome({ me: { username: 'admin' } }), env.parent, EVIL);
      assert.equal(lp.me.username, 'you');
    }
    // A bad entry next to a good one is dropped on its own.
    const env = load();
    const pending = env.LANParty.connect({ hostOrigins: ['*', HOST], timeoutMs: 2000 });
    assert.deepEqual(env.targets, [HOST]);
    env.deliver(welcome(), env.parent, EVIL);
    env.deliver(welcome(), env.parent, HOST);
    assert.equal((await pending).me.username, 'ann');
    env.deliver({ lanparty: 1, type: 'closed' }, env.parent, HOST);
  });

  test('hostOrigins: with no listed host answering, the app is standalone like any other', async () => {
    const env = load();
    const lp = await env.LANParty.connect({ hostOrigins: [HOST], timeoutMs: 60 });
    assert.equal(lp.standalone, true);
    assert.equal(lp.room, null);
    assert.equal(env.listeners.size, 0);
    assert.ok(env.targets.length >= 1 && env.targets.every((t) => t === HOST));
  });

  // An uploaded bundle has an opaque origin and cannot know its host's, so for it nothing changes.
  test('without hostOrigins nothing changed: "*" out, and the host\'s origin is never looked at', async () => {
    for (const options of [undefined, {}, { timeoutMs: 2000 }, { hostOrigins: undefined }]) {
      const env = load();
      const pending = env.LANParty.connect(options);
      // Whatever the origin, a welcome from the parent window connects it.
      env.deliver(welcome({ room: { id: ROOM } }), env.parent, EVIL);
      const lp = await pending;
      assert.equal(lp.standalone, false);
      assert.deepEqual(plain(lp.room), { id: ROOM });
      env.deliver({ lanparty: 1, type: 'state', shared: { round: 4 }, rev: 6 }, env.parent, 'null');
      assert.deepEqual(plain(lp.state), { round: 4 });
      lp.setState({ a: 1 });
      lp.emit('x');
      assert.ok(env.targets.length >= 3);
      assert.ok(env.targets.every((t) => t === '*'));
      env.deliver({ lanparty: 1, type: 'closed' });
    }
  });
});
