// Revocable app room keys. An app's backend files a voice channel's data under the room key it is
// given, and everyone who joined the app there holds that key. So the key is bound to a per-server
// counter, the app room epoch, which moves whenever someone stops being entitled to the server's
// rooms (kicked, left, taken off a private channel, account deleted) or staff reset it by hand:
// every channel of that server then has a new key for every app, and the old one is not handed out
// again, to anyone.
//
// Layers: the key and the epoch service on their own, the migration, then the real server.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');
const { migrate, MIGRATIONS } = require('../db/schema');
const { runMigrations } = require('../db/migrate');
const { createAppRoomKeys, deriveKey } = require('../services/hostedApps');
const { createAppRooms } = require('../services/appRooms');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
const SITE = 'https://music.example.test';

// ---------------------------------------------------------------------------------------------
describe('room keys and the epoch (services/hostedApps.js)', () => {
  const key = createAppRoomKeys('a-server-secret');

  test('stable within an epoch, different in every other one', () => {
    const at = (epoch) => key(7, SITE, 'srv-1', 'ch-1', epoch);
    assert.match(at(0), /^[0-9a-f]{32}$/);
    assert.equal(at(0), at(0));
    assert.equal(at(3), at(3));
    assert.equal(createAppRoomKeys('a-server-secret')(7, SITE, 'srv-1', 'ch-1', 3), at(3), 'and after a restart');
    const many = Array.from({ length: 50 }, (_, epoch) => at(epoch));
    assert.equal(new Set(many).size, 50, 'no epoch shares a key with another');
    // The epoch of one server says nothing about another's: each is its own text.
    assert.notEqual(key(7, SITE, 'srv-2', 'ch-1', 3), at(3));
  });

  test('epoch 0 is signed like any other: the 0 is in the text, and the four-part text is not a key', () => {
    const derived = deriveKey('a-server-secret', 'lanparty:app-room-key:v1');
    const sign = (parts) => crypto.createHmac('sha256', derived).update(JSON.stringify(parts)).digest('hex').slice(0, 32);
    assert.equal(key(7, SITE, 'demo', 'voice1', 0), sign([7, SITE, 'demo', 'voice1', 0]));
    assert.equal(key(7, SITE, 'demo', 'voice1', 12), sign([7, SITE, 'demo', 'voice1', 12]));
    assert.notEqual(key(7, SITE, 'demo', 'voice1', 0), sign([7, SITE, 'demo', 'voice1']), 'no compatibility form');
    // A number, not its text: '1' and 1 must not be two spellings of one epoch.
    assert.notEqual(key(7, SITE, 'demo', 'voice1', 1), sign([7, SITE, 'demo', 'voice1', '1']));
  });

  test('a key is never made without an epoch', () => {
    for (const bad of [undefined, null, '0', '1', -1, 1.5, NaN, Infinity, {}, [], true]) {
      assert.throws(() => key(7, SITE, 'demo', 'voice1', /** @type {any} */ (bad)), TypeError, String(bad));
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the epoch service (services/appRooms.js)', () => {
  const setup = async () => {
    const db = await freshDb();
    await migrate(db);
    await db.run("INSERT INTO servers (id, name, owner) VALUES ('srv-a', 'A', 'ann'), ('srv-b', 'B', 'ann')");
    /** @type {any[]} */
    const ended = [];
    const rooms = createAppRooms({ db, commonsId: 'demo', endAppActivitiesInServer: (serverId, reason) => ended.push([serverId, reason]) });
    return { db, ended, rooms };
  };

  test('0 to begin with; a rotation moves that server and no other, and ends its apps', async () => {
    const { db, ended, rooms } = await setup();
    assert.deepEqual([await rooms.epochOf('srv-a'), await rooms.epochOf('srv-b'), await rooms.epochOf('demo')], [0, 0, 0]);
    assert.equal(await rooms.epochOf('no-such-server'), null);

    assert.equal(await rooms.rotate('srv-a'), 1);
    assert.equal(await rooms.rotate('srv-a'), 2);
    assert.deepEqual([await rooms.epochOf('srv-a'), await rooms.epochOf('srv-b'), await rooms.epochOf('demo')], [2, 0, 0]);
    assert.deepEqual(ended, [['srv-a', 'rooms-reset'], ['srv-a', 'rooms-reset']]);
    await db.close();
  });

  test('the commons is never rotated, whoever asks', async () => {
    const { db, ended, rooms } = await setup();
    assert.equal(await rooms.rotate('demo'), null);
    assert.equal(await rooms.epochOf('demo'), 0);
    assert.deepEqual(ended, []);
    assert.equal(rooms.generation('demo'), 0);
    await db.close();
  });

  test('a start that began before a rotation can tell: the generation moves when one begins and when it ends', async () => {
    const { db, rooms } = await setup();
    const noted = rooms.generation('srv-a');
    const rotating = rooms.rotate('srv-a');
    assert.notEqual(rooms.generation('srv-a'), noted, 'already moved, before the write has landed');
    const during = rooms.generation('srv-a');
    await rotating;
    assert.notEqual(rooms.generation('srv-a'), during, 'and again once the apps were ended');
    assert.equal(rooms.generation('srv-b'), 0, 'another server\'s starts are not held up');
    await db.close();
  });

  test('a rotation whose write fails still ends the apps and still stops a waiting start', async () => {
    /** @type {any[]} */
    const ended = [];
    const failing = { run: async () => { throw new Error('disk full'); }, get: async () => ({ epoch: 4 }), all: async () => [], exec: async () => {} };
    const rooms = createAppRooms({ db: failing, commonsId: 'demo', endAppActivitiesInServer: (serverId, reason) => ended.push([serverId, reason]) });
    const noted = rooms.generation('srv-a');
    await assert.rejects(() => rooms.rotate('srv-a'), /disk full/);
    assert.deepEqual(ended, [['srv-a', 'rooms-reset']]);
    assert.notEqual(rooms.generation('srv-a'), noted);
  });
});

// ---------------------------------------------------------------------------------------------
describe('migration 0013_app_room_epoch', () => {
  const before0013 = MIGRATIONS.filter((m) => m.name < '0013');

  test('it is the next one after 0012', () => {
    assert.equal(before0013.length, 12);
    assert.equal(MIGRATIONS[12].name, '0013_app_room_epoch');
  });

  test('every server that already exists is at epoch 0, with everything else about it untouched', async () => {
    const db = await freshDb();
    await runMigrations(db, before0013);
    await db.run("INSERT INTO servers (id, name, owner, icon_url) VALUES ('demo', 'LAN Party', NULL, NULL)");
    await db.run("INSERT INTO servers (id, name, owner, icon_url) VALUES ('srv-old', 'Game Night', 'ann', '/tile-icons/a.webp')");
    await db.run("INSERT INTO server_members (server_id, username, role) VALUES ('srv-old', 'ann', 'owner'), ('srv-old', 'ben', 'member')");
    assert.ok(!(await db.all('PRAGMA table_info(servers)')).some((c) => c.name === 'app_room_epoch'));
    await migrate(db);
    assert.deepEqual(await db.all('SELECT id, name, owner, icon_url, app_room_epoch FROM servers ORDER BY id'), [
      { id: 'demo', name: 'LAN Party', owner: null, icon_url: null, app_room_epoch: 0 },
      { id: 'srv-old', name: 'Game Night', owner: 'ann', icon_url: '/tile-icons/a.webp', app_room_epoch: 0 },
    ]);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM server_members WHERE server_id = 'srv-old'")).n, 2);
    // A server made afterwards starts at 0 as well, without saying so.
    await db.run("INSERT INTO servers (id, name, owner) VALUES ('srv-new', 'New', 'ben')");
    assert.equal((await db.get("SELECT app_room_epoch FROM servers WHERE id = 'srv-new'")).app_room_epoch, 0);
    // Run again on a database that lost its migration record: an epoch that has moved stays moved.
    // Falling back to 0 would bring back keys that were revoked.
    await db.run("UPDATE servers SET app_room_epoch = 5 WHERE id = 'srv-old'");
    await db.exec('DROP TABLE schema_migrations');
    await migrate(db);
    assert.equal((await db.get("SELECT app_room_epoch FROM servers WHERE id = 'srv-old'")).app_room_epoch, 5);
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------
// One server process. 'root' registers first, so it is the instance owner and its app is published
// at once. 'ann' owns the LAN Party servers the tests make; everyone else is a member of some.
// `control` is a server nothing here ever touches: its epoch, and the commons', must never move.
describe('app room epochs (server)', () => {
  let server, call, base, tokens, app, control;
  /** @type {any[]} */
  const openSockets = [];
  let serial = 0;

  const epochOf = async (serverId) => (await dbAll(server.dataDir, 'SELECT app_room_epoch AS epoch FROM servers WHERE id = ?', [serverId]))[0]?.epoch;
  const untouched = async () => {
    assert.equal(await epochOf(control.id), 0, 'another server\'s epoch moved');
    assert.equal(await epochOf('demo'), 0, 'the commons\' epoch moved');
  };
  // What the server must have handed out, worked out here from the same parts.
  const expectedKey = (serverId, channelId, epoch) => createAppRoomKeys('test-secret')(app.id, SITE, serverId, channelId, epoch);

  const ok = (res, what) => { assert.equal(res.status, 200, `${what}: ${JSON.stringify(res.data)}`); return res; };
  // A server of ann's (or `owner`'s) with these members, and the id of its voice channel.
  async function makeServer(members = [], owner = 'ann') {
    const made = ok(await call('POST', '/servers', { name: `Server ${++serial}` }, tokens[owner]), 'create server');
    const id = made.data.server.id;
    for (const username of members) ok(await call('POST', `/servers/${id}/invite`, { username }, tokens[owner]), `invite ${username}`);
    const [voice] = await dbAll(server.dataDir, "SELECT id FROM channels WHERE server_id = ? AND type = 'voice'", [id]);
    return { id, voice: voice.id, owner };
  }
  const addChannel = async (srv, body) => ok(await call('POST', `/servers/${srv.id}/channels`, { name: `ch ${++serial}`, type: 'voice', ...body }, tokens[srv.owner]), 'create channel').data.channel.id;
  const setRole = (srv, username, role) => call('PATCH', `/servers/${srv.id}/members/${username}`, { role }, tokens[srv.owner]);
  const reset = (serverId, who) => call('POST', `/servers/${serverId}/app-rooms/reset`, undefined, tokens[who]);

  // --- sockets ---
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
  const isApp = (v) => v != null && v.type === 'app';
  // Connected, looking at the server, and in that voice channel's room.
  async function enter(name, serverId, channelId) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[name] } });
    openSockets.push(socket);
    await once(socket, 'connect');
    socket.userName = name;
    socket.where = { serverId, channelId };
    socket.updates = [];
    socket.ended = [];
    socket.removed = []; // every time the server took this socket out of a voice room, or refused it one
    socket.on('activity:update', (a) => { socket.updates.push(a); socket.act = a; });
    socket.on('activity:app-ended', (m) => socket.ended.push(m));
    socket.on('voice:removed', (m) => socket.removed.push(m));
    const joined = once(socket, 'channel:joined');
    socket.emit('join', { serverId, name });
    await joined;
    await rejoinVoice(socket);
    return socket;
  }
  // (Back) into the voice room this socket belongs in.
  async function rejoinVoice(socket) {
    const peers = once(socket, 'voice:peers');
    socket.emit('voice:join', socket.where);
    await peers;
  }
  // Connected and looking at the server, but turned away at the door of that voice room.
  async function knock(name, serverId, channelId) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[name] } });
    openSockets.push(socket);
    await once(socket, 'connect');
    Object.assign(socket, { userName: name, where: { serverId, channelId }, updates: [], ended: [], removed: [] });
    socket.on('activity:update', (a) => { socket.updates.push(a); socket.act = a; });
    const joined = once(socket, 'channel:joined');
    socket.emit('join', { serverId, name });
    await joined;
    const refused = once(socket, 'voice:removed');
    socket.emit('voice:join', { serverId, channelId });
    assert.deepEqual(await refused, { serverId, channelId });
    return socket;
  }
  const settled = async (condition) => { for (let i = 0; i < 60 && !condition(); i++) await sleep(50); };
  // Resolves with the starter's own view of the new run (they are joined from the first update).
  const startApp = (socket) => {
    const last = isApp(socket.act) ? socket.act.state.run : null;
    const started = once(socket, 'activity:update', (v) => isApp(v) && v.by === socket.userName && v.state.run !== last);
    socket.emit('activity:start', { ...socket.where, type: 'app', appId: app.id });
    return started;
  };
  // A start the server must ignore: nobody in the room, the sender included, hears of a new run.
  const startRefused = async (socket, others = []) => {
    const watching = [socket, ...others];
    const seen = watching.map((s) => s.updates.length);
    socket.emit('activity:start', { ...socket.where, type: 'app', appId: app.id });
    await sleep(300);
    watching.forEach((s, i) => {
      assert.ok(!s.updates.slice(seen[i]).some((v) => isApp(v) && v.by === socket.userName), `${socket.userName}'s start must have been ignored`);
    });
  };
  const appEvent = (socket, event, run) => new Promise((resolve) => {
    socket.emit('activity:event', { ...socket.where, app: run || socket.act.state.run, event }, resolve);
  });
  const endedFor = (socket) => once(socket, 'activity:update', (v) => v === null);
  // Waits until this socket has been shown that run (its card, or the app itself).
  const sees = async (socket, run) => {
    if (!(isApp(socket.act) && socket.act.state.run === run)) await once(socket, 'activity:update', (v) => isApp(v) && v.state.run === run);
  };
  // Every room key this socket was ever sent, in any update.
  const keysSeen = (socket) => new Set(socket.updates.filter(isApp).map((v) => v.state.roomKey).filter(Boolean));

  const deleteAccount = async (name) => {
    const [user] = await dbAll(server.dataDir, 'SELECT id FROM users WHERE username = ?', [name]);
    ok(await call('POST', '/account/deactivate', {}, tokens[name]), 'request deactivation');
    const [pending] = await dbAll(server.dataDir, "SELECT token FROM auth_tokens WHERE purpose = 'deactivate' AND user_id = ?", [user.id]);
    ok(await call('POST', '/account/deactivate/confirm', { token: pending.token }), 'confirm deactivation');
  };

  before(async () => {
    server = await startServer({ env: { INSTANCE_OWNERS: '' } });
    base = server.base;
    call = apiFor(base);
    tokens = {};
    for (const name of ['root', 'ann', 'ben', 'cara', 'dan', 'eve', 'finn', 'gus']) tokens[name] = await makeUser(call, name);
    const added = ok(await call('POST', '/apps', { name: 'Music DJ', url: `${SITE}/`, embed: true }, tokens.root), 'add the app');
    app = added.data.app;
    assert.equal(app.status, 'published');
    control = await makeServer(['dan']);
  });
  after(async () => {
    for (const s of openSockets) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('a new server starts at epoch 0, and its room key is the epoch-0 key', async () => {
    const srv = await makeServer(['ben']);
    assert.equal(await epochOf(srv.id), 0);
    assert.equal(await epochOf('demo'), 0);
    const ann = await enter('ann', srv.id, srv.voice);
    const first = await startApp(ann);
    assert.equal(first.state.roomKey, expectedKey(srv.id, srv.voice, 0));
    // Starting it again, and someone else starting it: the same epoch, the same room.
    assert.equal((await startApp(ann)).state.roomKey, first.state.roomKey);
    const ben = await enter('ben', srv.id, srv.voice);
    assert.equal((await startApp(ben)).state.roomKey, first.state.roomKey);
    assert.equal(await epochOf(srv.id), 0, 'starting and joining apps never moves it');
    await untouched();
  });

  test('a kick moves that server\'s epoch: the same app in the same channel gets a new key, and the kicked member is not given it', async () => {
    const srv = await makeServer(['ben', 'cara']);
    const ann = await enter('ann', srv.id, srv.voice);
    const ben = await enter('ben', srv.id, srv.voice);
    const before = await startApp(ben);
    assert.equal((await appEvent(ann, { kind: 'join' })).ok, true);
    assert.equal(ann.act.state.roomKey, before.state.roomKey);

    const [annOut, benOut] = [endedFor(ann), endedFor(ben)];
    ok(await call('DELETE', `/servers/${srv.id}/members/ben`, undefined, tokens.ann), 'kick');
    await Promise.all([annOut, benOut]);
    assert.equal(await epochOf(srv.id), 1);
    await untouched();
    // The people who were in the app are told why it went.
    assert.deepEqual(ann.ended, [{ run: before.state.run, reason: 'rooms-reset' }]);
    assert.deepEqual(ben.ended, [{ run: before.state.run, reason: 'rooms-reset' }]);

    const after = await startApp(ann);
    assert.notEqual(after.state.roomKey, before.state.roomKey);
    assert.equal(after.state.roomKey, expectedKey(srv.id, srv.voice, 1));

    // Out of the server is out of its call: the server took ben's socket out of the voice room
    // and told it so (a hand-written client that ignores that is still out). From outside he is
    // shown nothing more, can start nothing and can join nothing.
    await settled(() => ben.removed.length > 0);
    assert.deepEqual(ben.removed, [{ serverId: srv.id, channelId: srv.voice }]);
    await startRefused(ben, [ann]);
    assert.equal((await appEvent(ben, { kind: 'join' }, after.state.run)).ok, false);
    assert.ok(!ben.updates.some((v) => isApp(v) && v.state.run === after.state.run), 'ben is never shown the new run');
    assert.equal(ann.act.state.run, after.state.run, 'still ann\'s run');
    assert.deepEqual(ann.act.state.joined, ['ann']);
    assert.deepEqual([...keysSeen(ben)], [before.state.roomKey], 'the only key ben ever held is the revoked one');

    // Someone who is still a member joins and gets the new key.
    const cara = await enter('cara', srv.id, srv.voice);
    await sees(cara, after.state.run);
    assert.equal((await appEvent(cara, { kind: 'join' })).ok, true);
    assert.equal(cara.act.state.roomKey, after.state.roomKey);
    // Invited back, ben gets the current key too: it is the rooms that were revoked, not him.
    ok(await call('POST', `/servers/${srv.id}/invite`, { username: 'ben' }, tokens.ann), 'invite again');
    await rejoinVoice(ben);
    await sees(ben, after.state.run);
    assert.equal((await appEvent(ben, { kind: 'join' }, after.state.run)).ok, true);
    assert.equal(ben.act.state.roomKey, after.state.roomKey);
    assert.equal(await epochOf(srv.id), 1, 'coming back moves nothing');
  });

  test('a member leaving moves the epoch too', async () => {
    const srv = await makeServer(['ben', 'cara']);
    const ann = await enter('ann', srv.id, srv.voice);
    const before = await startApp(ann);
    const out = endedFor(ann);
    ok(await call('POST', `/servers/${srv.id}/leave`, undefined, tokens.cara), 'leave');
    await out;
    assert.equal(await epochOf(srv.id), 1);
    assert.notEqual((await startApp(ann)).state.roomKey, before.state.roomKey);
    // Refused requests change nothing: not a member, and the owner cannot leave.
    assert.equal((await call('POST', `/servers/${srv.id}/leave`, undefined, tokens.dan)).status, 400);
    assert.equal((await call('POST', `/servers/${srv.id}/leave`, undefined, tokens.ann)).status, 400);
    assert.equal((await call('DELETE', `/servers/${srv.id}/members/nobody`, undefined, tokens.ann)).status, 404);
    assert.equal((await call('DELETE', `/servers/${srv.id}/members/ann`, undefined, tokens.ann)).status, 400);
    assert.equal((await call('DELETE', `/servers/${srv.id}/members/ben`, undefined, tokens.ben)).status, 403);
    assert.equal(await epochOf(srv.id), 1);
    await untouched();
  });

  test('taking a member off a private channel\'s list moves the epoch; a name that was not on it, or an admin\'s row, does not', async () => {
    const srv = await makeServer(['ben', 'cara', 'dan']);
    ok(await setRole(srv, 'cara', 'admin'), 'promote');
    const priv = await addChannel(srv, { privacy: 'private', members: ['ben', 'cara'] });
    const off = (username) => call('DELETE', `/servers/${srv.id}/channels/${priv}/members/${username}`, undefined, tokens.ann);

    const ben = await enter('ben', srv.id, priv);
    const before = await startApp(ben);
    assert.equal(before.state.roomKey, expectedKey(srv.id, priv, 0));

    // dan was never on the list; cara is an admin, who opens every channel with or without a row.
    ok(await off('dan'), 'remove dan');
    ok(await off('cara'), 'remove cara');
    // And a member cannot take anyone off it at all.
    assert.equal((await call('DELETE', `/servers/${srv.id}/channels/${priv}/members/ben`, undefined, tokens.dan)).status, 403);
    assert.equal(await epochOf(srv.id), 0);
    assert.equal(ben.act.state.run, before.state.run, 'the app is still running');

    const out = endedFor(ben);
    ok(await off('ben'), 'remove ben');
    await out;
    assert.equal(await epochOf(srv.id), 1);
    assert.deepEqual(ben.ended, [{ run: before.state.run, reason: 'rooms-reset' }]);
    // Removing him again takes nothing away, so nothing moves.
    ok(await off('ben'), 'remove ben again');
    assert.equal(await epochOf(srv.id), 1);

    // Off the list, ben was taken out of that channel's voice room there and then (once: the
    // second removal took nothing away).
    await settled(() => ben.removed.length > 0);
    assert.deepEqual(ben.removed, [{ serverId: srv.id, channelId: priv }]);
    // Staff start it there again: a new key, which ben is never shown.
    const ann = await enter('ann', srv.id, priv);
    const after = await startApp(ann);
    assert.equal(after.state.roomKey, expectedKey(srv.id, priv, 1));
    assert.notEqual(after.state.roomKey, before.state.roomKey);
    await startRefused(ben, [ann]);
    assert.equal((await appEvent(ben, { kind: 'join' }, after.state.run)).ok, false);
    // A member who never had the channel is turned away at the door of its voice room: knowing a
    // private channel's id used to be enough to walk in and listen.
    const dan = await knock('dan', srv.id, priv);
    await startRefused(dan, [ann]);
    assert.equal((await appEvent(dan, { kind: 'join' }, after.state.run)).ok, false);
    assert.equal(keysSeen(dan).size, 0);
    assert.equal(keysSeen(ben).size, 1, 'ben only ever held the revoked key');
    // Put back on the list, ben comes back in, joins, and gets the current key.
    ok(await call('POST', `/servers/${srv.id}/channels/${priv}/members`, { username: 'ben' }, tokens.ann), 'grant again');
    await rejoinVoice(ben);
    await sees(ben, after.state.run);
    assert.equal((await appEvent(ben, { kind: 'join' }, after.state.run)).ok, true);
    assert.equal(ben.act.state.roomKey, after.state.roomKey);
    assert.equal(await epochOf(srv.id), 1, 'granting access moves nothing');
    await untouched();
  });

  test('demoting an admin moves the epoch only when a private channel goes with the role', async () => {
    const srv = await makeServer(['cara']);
    // No private channels: a role change takes no room away.
    ok(await setRole(srv, 'cara', 'admin'), 'promote');
    ok(await setRole(srv, 'cara', 'member'), 'demote');
    assert.equal(await epochOf(srv.id), 0);

    // A private channel cara is not listed on: as an admin she could open it, as a member not.
    const priv = await addChannel(srv, { privacy: 'private', members: [] });
    ok(await setRole(srv, 'cara', 'admin'), 'promote');
    assert.equal(await epochOf(srv.id), 0, 'gaining access moves nothing');
    const cara = await enter('cara', srv.id, priv);
    const before = await startApp(cara);
    const out = endedFor(cara);
    ok(await setRole(srv, 'cara', 'member'), 'demote');
    await out;
    assert.equal(await epochOf(srv.id), 1);
    await startRefused(cara);
    const ann = await enter('ann', srv.id, priv);
    assert.notEqual((await startApp(ann)).state.roomKey, before.state.roomKey);

    // Listed on every private channel: the demotion takes nothing away.
    ok(await call('POST', `/servers/${srv.id}/channels/${priv}/members`, { username: 'cara' }, tokens.ann), 'grant');
    ok(await setRole(srv, 'cara', 'admin'), 'promote');
    ok(await setRole(srv, 'cara', 'member'), 'demote');
    // Member to member, and admin to admin, are not demotions.
    ok(await setRole(srv, 'cara', 'member'), 'member again');
    assert.equal(await epochOf(srv.id), 1);
    await untouched();
  });

  test('deleting an account moves the epoch of every server it was in, and ends the apps in the servers it owned', async () => {
    const one = await makeServer(['eve', 'ben']);
    const two = await makeServer(['eve']);
    const without = await makeServer(['ben']);
    const hers = await makeServer(['finn'], 'eve');

    const ann = await enter('ann', one.id, one.voice);
    const before = await startApp(ann);
    const finn = await enter('finn', hers.id, hers.voice);
    const inHers = await startApp(finn);
    const [annOut, finnOut] = [endedFor(ann), endedFor(finn)];

    await deleteAccount('eve');
    await Promise.all([annOut, finnOut]);
    assert.deepEqual([await epochOf(one.id), await epochOf(two.id), await epochOf(without.id)], [1, 1, 0]);
    await untouched();
    assert.notEqual((await startApp(ann)).state.roomKey, before.state.roomKey);
    // Her own server is gone with her: its app was ended, and nothing starts there again.
    assert.equal(await epochOf(hers.id), undefined);
    assert.deepEqual(finn.ended, [{ run: inHers.state.run, reason: 'rooms-reset' }]);
    await startRefused(finn);
  });

  test('deleting a server ends the apps running in it', async () => {
    const srv = await makeServer(['ben'], 'gus');
    const ben = await enter('ben', srv.id, srv.voice);
    const running = await startApp(ben);
    const out = endedFor(ben);
    ok(await call('DELETE', `/servers/${srv.id}`, undefined, tokens.gus), 'delete server');
    await out;
    assert.deepEqual(ben.ended, [{ run: running.state.run, reason: 'rooms-reset' }]);
    await startRefused(ben);
    await untouched();
  });

  test('a rotation ends the apps in that server\'s voice rooms, and nothing else', async () => {
    const srv = await makeServer(['ben', 'cara']);
    const second = await addChannel(srv, {});
    // In the server: an app in one voice channel, a built-in activity in the other.
    const ann = await enter('ann', srv.id, srv.voice);
    const ben = await enter('ben', srv.id, srv.voice);
    const cara = await enter('cara', srv.id, second);
    const running = await startApp(ann);
    const card = isApp(ben.act) ? ben.act : await once(ben, 'activity:update', isApp);
    assert.equal(card.state.roomKey, null, 'ben is in the room but has not joined the app');
    const tttUp = once(cara, 'activity:update', (v) => v != null && v.type === 'ttt');
    cara.emit('activity:start', { ...cara.where, type: 'ttt' });
    await tttUp;
    // Elsewhere: the same app in another server, and in the commons.
    const dan = await enter('dan', control.id, control.voice);
    const gus = await enter('gus', 'demo', 'commons-room');
    const inControl = await startApp(dan);
    const inCommons = await startApp(gus);

    const [annOut, benOut] = [endedFor(ann), endedFor(ben)];
    const res = ok(await reset(srv.id, 'ann'), 'reset');
    assert.deepEqual(res.data, { success: true, epoch: 1 });
    await Promise.all([annOut, benOut]);
    assert.equal(await epochOf(srv.id), 1);
    await untouched();
    // Told why, if they were in it; the card just goes for someone who was not.
    assert.deepEqual(ann.ended, [{ run: running.state.run, reason: 'rooms-reset' }]);
    assert.deepEqual(ben.ended, []);

    await sleep(200);
    assert.equal(cara.act.type, 'ttt', 'a built-in activity has no room key and is left alone');
    assert.deepEqual(cara.ended, []);
    for (const [socket, started] of [[dan, inControl], [gus, inCommons]]) {
      assert.equal(socket.act.state.run, started.state.run, `${socket.userName}'s app is still running`);
      assert.equal((await appEvent(socket, { kind: 'set', patch: { still: 'here' } })).ok, true);
      assert.deepEqual(socket.ended, []);
      // And started again, it is in the room it was in before.
      assert.equal((await startApp(socket)).state.roomKey, started.state.roomKey);
    }
    // In the server that was reset, the next start is in a new room.
    assert.notEqual((await startApp(ann)).state.roomKey, running.state.roomKey);
  });

  test('manual reset: owner and admins only, per server, and it says what the epoch is now', async () => {
    const srv = await makeServer(['ben', 'cara']);
    ok(await setRole(srv, 'cara', 'admin'), 'promote');
    assert.equal((await reset(srv.id, 'ben')).status, 403, 'a member');
    assert.equal((await reset(srv.id, 'dan')).status, 403, 'not in the server');
    assert.equal((await reset(srv.id, 'root')).status, 403, 'running the instance is not running this server');
    assert.equal((await call('POST', `/servers/${srv.id}/app-rooms/reset`)).status, 401, 'nobody at all');
    assert.equal((await reset('srv-no-such-server', 'ann')).status, 404);
    assert.equal(await epochOf(srv.id), 0, 'a refused reset moves nothing');

    assert.deepEqual(ok(await reset(srv.id, 'ann'), 'owner').data, { success: true, epoch: 1 });
    assert.deepEqual(ok(await reset(srv.id, 'cara'), 'admin').data, { success: true, epoch: 2 });
    assert.equal(await epochOf(srv.id), 2);
    await untouched();
  });

  test('the commons never rotates: no reset for anyone, nobody to remove, and its keys stay what they were', async () => {
    const gus = await enter('gus', 'demo', 'commons-keys');
    const before = await startApp(gus);
    assert.equal(before.state.roomKey, expectedKey('demo', 'commons-keys', 0));

    for (const who of ['root', 'ann', 'gus']) {
      const res = await reset('demo', who);
      assert.equal(res.status, 400, who);
      assert.match(res.data.error, /public server/);
    }
    // The ways out of a server do not exist here, so nothing is ever revoked from anyone.
    assert.equal((await call('POST', '/servers/demo/leave', undefined, tokens.gus)).status, 400);
    assert.equal((await call('DELETE', '/servers/demo/members/gus', undefined, tokens.root)).status, 400);
    assert.equal((await call('PATCH', '/servers/demo/members/gus', { role: 'member' }, tokens.root)).status, 400);
    assert.equal(await epochOf('demo'), 0);
    assert.equal(gus.act.state.run, before.state.run, 'and the app there was never ended');
    assert.equal((await startApp(gus)).state.roomKey, before.state.roomKey);
  });

  test('a room key is only made for a channel that exists and that the starter can open', async () => {
    const srv = await makeServer(['ben']);
    // Outside the commons a voice room is a channel: a name that is no channel of the server is
    // not a room anyone can be in, so there is nothing to start an app in.
    const ann = await knock('ann', srv.id, 'ch-no-such-channel');
    await startRefused(ann);
    // A private channel, deleted: its id must not become a room anyone in the server can claim.
    const priv = await addChannel(srv, { privacy: 'private', members: [] });
    const inPriv = await enter('ann', srv.id, priv);
    const before = await startApp(inPriv);
    assert.match(before.state.roomKey, /^[0-9a-f]{32}$/);
    ok(await call('DELETE', `/servers/${srv.id}/channels/${priv}`, undefined, tokens.ann), 'delete channel');
    const ben = await knock('ben', srv.id, priv);
    await startRefused(ben, [inPriv]);
    assert.equal((await appEvent(ben, { kind: 'join' }, before.state.run)).ok, false);
    assert.equal(keysSeen(ben).size, 0);
    await startRefused(inPriv);
    await untouched();
  });

  test('resets are rate limited per account', async () => {
    const srv = await makeServer([], 'finn');
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await reset(srv.id, 'finn')).status);
    assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
    assert.deepEqual(statuses.slice(10), [429, 429]);
    assert.equal(await epochOf(srv.id), 10, 'a refused reset moves nothing');
    // One person's limit is not another's.
    const other = await makeServer([], 'gus');
    assert.equal((await reset(other.id, 'gus')).status, 200);
  });
});
