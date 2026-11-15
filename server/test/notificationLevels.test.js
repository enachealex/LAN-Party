// Notification levels: "All messages" / "Only @mentions" / "Nothing" per server and per channel, and
// mute for a DM or a group chat (services/notificationSettings.js, routes/notifications.js).
//
// The server's half is who gets PUSHED, so these boot the real server with the web-push library
// swapped for test/fixtures/fakeWebPush.js (as push.test.js does) and read what it was asked to
// send. Nothing is ever sent to a push service. The other half (which counts feed which badge, and
// the in-page alerts) is the client's, working from what GET /unreads hands it, so that answer is
// checked here too.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUserFromOwnAddress, dbAll } = require('./helpers');
const { createPush, MENTION_PUSHES_PER_WINDOW, CHANNEL_PUSHES_PER_WINDOW, MAX_LEVEL_TARGETS } = require('../services/push');
const { effectiveChannelLevel } = require('../services/notificationSettings');

const FAKE_WEB_PUSH = path.join(__dirname, 'fixtures', 'fakeWebPush.js');
const PUSH_ENV = { WEB_PUSH_MODULE: FAKE_WEB_PUSH, PUSH_EXTRA_HOSTS: 'push.example.com' };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const subscription = (where) => ({
  endpoint: `https://push.example.com/${where}`,
  expirationTime: null,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'),
    auth: crypto.randomBytes(16).toString('base64url'),
  },
});

function sentBy(server) {
  const file = path.join(server.dataDir, 'push-sent.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
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

// Who was pushed: the last path segment of an endpoint is the person's name in these tests.
const pushedTo = (pushes) => pushes.map((p) => p.endpoint.split('/').pop()).sort();

// One server with everything a suite here needs: accounts that each have one browser subscribed for
// push, a socket per sender, and the canary pair that tells a test when the pushes of an action
// have all been through (see push.test.js: sends are fire-and-forget).
async function world(names) {
  const server = await startServer({ env: PUSH_ENV });
  const call = apiFor(server.base);
  const tok = {};
  for (const name of [...names, 'flush', 'canary']) tok[name] = await makeUserFromOwnAddress(server.base, name);
  const ids = Object.fromEntries((await dbAll(server.dataDir, 'SELECT id, username FROM users')).map((r) => [r.username, r.id]));
  const flushServer = (await call('POST', '/servers', { name: 'Flush' }, tok.flush)).data.server.id;
  await call('POST', `/servers/${flushServer}/invite`, { username: 'canary' }, tok.flush);
  for (const name of [...names, 'canary']) {
    assert.equal((await call('POST', '/push/subscribe', subscription(`ok/${name}`), tok[name])).status, 200);
  }

  const sockets = {};
  const at = {};
  let flushCount = 0;
  const sent = () => sentBy(server);

  async function pushedBy(action) {
    const mark = sent().length;
    const result = await action();
    const nonce = `flush ${++flushCount} ${crypto.randomBytes(4).toString('hex')}`;
    assert.equal((await call('POST', '/messages/send', { toUsername: 'canary', text: nonce }, tok.flush)).status, 200);
    await waitFor(() => sent().some((p) => p.payload.body === nonce), 'the canary push');
    await sleep(40);
    return { result, pushes: sent().slice(mark).filter((p) => !p.endpoint.endsWith('/canary')) };
  }

  // A channel message from `from`, over their own socket, the way the client sends one.
  async function say(from, serverId, channelId, text) {
    const socket = sockets[from] || (sockets[from] = await connect(server.base, tok[from]));
    const where = at[from] || (at[from] = {});
    if (where.serverId !== serverId) {
      const joined = once(socket, 'channel:joined', (p) => p.serverId === serverId);
      socket.emit('join', { serverId, name: from });
      at[from] = { serverId, channelId: (await joined).channelId };
    }
    if (at[from].channelId !== channelId) {
      const joined = once(socket, 'channel:joined', (p) => p.channelId === channelId);
      socket.emit('joinChannel', { serverId, channelId });
      await joined;
      at[from].channelId = channelId;
    }
    const echoed = once(socket, 'message', (m) => m.text === text && m.channelId === channelId);
    socket.emit('message', { serverId, channelId, text });
    return echoed;
  }

  const setLevel = (who, body) => call('PUT', '/notifications/settings', body, tok[who]);
  const settingsOf = async (who) => (await call('GET', '/notifications/settings', undefined, tok[who])).data.settings;
  const rows = (sql = 'SELECT * FROM notification_settings ORDER BY user_id, scope, target', params = []) => dbAll(server.dataDir, sql, params);

  async function stop() {
    for (const s of Object.values(sockets)) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  }

  return { server, call, tok, ids, sockets, pushedBy, say, setLevel, settingsOf, rows, stop };
}

// ---------------------------------------------------------------------------------------------
describe('notification levels for servers and channels', () => {
  let w, serverId, general, quiet, misc, officers, voice;
  const channel = (channelId, level) => ({ scope: 'channel', serverId, channelId, level });

  before(async () => {
    // alice owns the server. bob, carol and dave are the people whose levels are under test.
    // s1…s8 only ever send: push allowances are counted per sender per minute, so each test speaks
    // through senders of its own and no test can use up another's.
    w = await world(['alice', 'bob', 'carol', 'dave', 'eve', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']);
    const { call, tok } = w;
    serverId = (await call('POST', '/servers', { name: 'Levels' }, tok.alice)).data.server.id;
    for (const username of ['bob', 'carol', 'dave', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
      assert.equal((await call('POST', `/servers/${serverId}/invite`, { username }, tok.alice)).status, 200);
    }
    const channels = await dbAll(w.server.dataDir, 'SELECT id, type FROM channels WHERE server_id = ?', [serverId]);
    general = channels.find((c) => c.type === 'text').id;
    voice = channels.find((c) => c.type === 'voice').id;
    quiet = (await call('POST', `/servers/${serverId}/channels`, { name: 'quiet' }, tok.alice)).data.channel.id;
    misc = (await call('POST', `/servers/${serverId}/channels`, { name: 'misc' }, tok.alice)).data.channel.id;
    // Private: bob and the senders s5 and s6 are on its list; carol and dave are not.
    officers = (await call('POST', `/servers/${serverId}/channels`, { name: 'officers', privacy: 'private', members: ['bob', 's5', 's6'] }, tok.alice)).data.channel.id;
  });
  after(async () => { await w.stop(); });

  test('settings need a login, and only take what makes sense', async () => {
    const { call, tok, setLevel } = w;
    assert.equal((await call('GET', '/notifications/settings')).status, 401);
    assert.equal((await call('PUT', '/notifications/settings', channel(general, 'all'))).status, 401);

    const bad = [
      ['no scope', { level: 'all' }, 400],
      ['an unknown scope', { scope: 'planet', level: 'all' }, 400],
      ['an unknown level', { scope: 'server', serverId, level: 'loud' }, 400],
      ['a level that is not text', { scope: 'server', serverId, level: 7 }, 400],
      ['no server id', { scope: 'server', level: 'all' }, 400],
      ['no channel id', { scope: 'channel', serverId, level: 'all' }, 400],
      ['a voice channel', channel(voice, 'all'), 404],
      ['a channel that does not exist', channel('ch-nope', 'all'), 404],
      ['a channel of another server', { scope: 'channel', serverId: 'demo', channelId: general, level: 'all' }, 404],
      ['muting yourself', { scope: 'dm', userId: String(w.ids.bob), level: 'none' }, 400],
      ['a person who does not exist', { scope: 'dm', userId: '999999', level: 'none' }, 404],
      ['a DM set to "all"', { scope: 'dm', userId: String(w.ids.alice), level: 'all' }, 400],
      ['a DM with no user id', { scope: 'dm', level: 'none' }, 400],
      ['a group the caller is not in', { scope: 'group', groupId: 'grp-0000000000000000', level: 'none' }, 404],
      ['a group set to "mentions"', { scope: 'group', groupId: 'grp-0000000000000000', level: 'mentions' }, 400],
    ];
    for (const [label, body, status] of bad) assert.equal((await setLevel('bob', body)).status, status, label);

    // eve is not in the server; carol is, but cannot open the private channel. Neither is told
    // anything a stranger would not be.
    assert.equal((await setLevel('eve', { scope: 'server', serverId, level: 'all' })).status, 403);
    assert.equal((await setLevel('eve', channel(general, 'all'))).status, 404);
    const hidden = await setLevel('carol', channel(officers, 'all'));
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.data, (await setLevel('carol', channel('ch-nope', 'all'))).data, 'a private channel answers exactly like one that does not exist');

    assert.deepEqual(await w.rows(), [], 'none of it left a row behind');
    assert.deepEqual(await w.settingsOf('bob'), { servers: {}, channels: {}, dms: {}, groups: {} });
    // The commons is a server like any other here: everyone is in it.
    assert.equal((await setLevel('eve', { scope: 'server', serverId: 'demo', level: 'none' })).status, 200);
    assert.equal((await setLevel('eve', { scope: 'server', serverId: 'demo', level: null })).status, 200);
    assert.deepEqual(await w.rows(), []);
  });

  test('with nothing set, only an @mention pushes (what everyone had before)', async () => {
    const plain = await w.pushedBy(() => w.say('s1', serverId, general, 'anyone around tonight?'));
    assert.deepEqual(plain.pushes, []);
    const named = await w.pushedBy(() => w.say('s1', serverId, general, '@bob you up?'));
    assert.deepEqual(pushedTo(named.pushes), ['bob']);
    assert.equal(named.pushes[0].payload.title, '🔔 general · Levels');
  });

  test('"All messages" pushes every message of that channel, once, and only to the person who asked', async () => {
    const set = await w.setLevel('bob', channel(general, 'all'));
    assert.equal(set.status, 200);
    assert.deepEqual(set.data.settings, { servers: {}, channels: { [serverId]: { [general]: 'all' } }, dms: {}, groups: {} });

    const plain = await w.pushedBy(() => w.say('s2', serverId, general, 'just chatting'));
    assert.deepEqual(pushedTo(plain.pushes), ['bob'], 'carol and dave are still on "only @mentions"');
    assert.deepEqual(plain.pushes[0].payload, {
      title: '# general · Levels', // the in-page notification's title for channel chatter, so the two collapse
      body: 's2: just chatting',
      tag: `lanparty-channel-${serverId}-${general}`,
      url: `/app/?open=channel/${serverId}/${general}`,
    });

    // Mentioned as well as listening: one push, and it is the mention.
    const both = await w.pushedBy(() => w.say('s2', serverId, general, '@bob and @carol look'));
    assert.deepEqual(pushedTo(both.pushes), ['bob', 'carol']);
    assert.ok(both.pushes.every((p) => p.payload.title === '🔔 general · Levels'));

    // Somebody else is mentioned: they get the bell, the listener gets the plain one.
    const split = await w.pushedBy(() => w.say('s2', serverId, general, '@carol only you'));
    assert.deepEqual(split.pushes.map((p) => [p.endpoint.split('/').pop(), p.payload.title]).sort(), [['bob', '# general · Levels'], ['carol', '🔔 general · Levels']]);

    // Another channel of the same server is untouched by a channel's setting.
    assert.deepEqual((await w.pushedBy(() => w.say('s2', serverId, quiet, 'elsewhere'))).pushes, []);

    // Your own messages never push you, whatever you asked for.
    assert.equal((await w.setLevel('s3', channel(general, 'all'))).status, 200);
    const own = await w.pushedBy(() => w.say('s3', serverId, general, 'talking to myself'));
    assert.deepEqual(pushedTo(own.pushes), ['bob']);
    assert.equal((await w.setLevel('s3', channel(general, null))).status, 200);
  });

  test('"Nothing" silences a channel completely, a mention included, and its unread count is still kept', async () => {
    assert.equal((await w.setLevel('carol', channel(general, 'none'))).status, 200);
    const named = await w.pushedBy(() => w.say('s3', serverId, general, '@carol are you there? @dave too'));
    assert.deepEqual(pushedTo(named.pushes), ['bob', 'dave'], 'dave is mentioned, bob listens to everything, carol has muted the channel');

    // What the client draws badges from. The count and the mention are both still there (the row
    // shows them, dimmed); the level beside them is what keeps them off the server tile.
    const unreads = (await w.call('GET', '/unreads', undefined, w.tok.carol)).data;
    assert.ok(unreads.unreads[serverId][general] >= 1, 'still counted');
    assert.ok(unreads.mentions[serverId][general] >= 1, 'the mention is still counted too');
    assert.equal(unreads.notifications.channels[serverId][general], 'none');
    assert.equal(effectiveChannelLevel(unreads.notifications, serverId, general), 'none');
    assert.equal(effectiveChannelLevel(unreads.notifications, serverId, quiet), 'mentions');

    // Someone with nothing set is told so in the same answer, even with nothing unread.
    const fresh = (await w.call('GET', '/unreads', undefined, w.tok.eve)).data;
    assert.deepEqual(fresh, { unreads: {}, mentions: {}, notifications: { servers: {}, channels: {}, dms: {}, groups: {} } });
  });

  test('a channel\'s own setting wins over its server\'s, and clearing it goes back to following the server', async () => {
    const serverLevel = (level) => ({ scope: 'server', serverId, level });
    assert.equal((await w.setLevel('dave', serverLevel('all'))).status, 200);
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s4', serverId, quiet, 'server-wide, one'))).pushes), ['dave']);
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s4', serverId, general, 'server-wide, two'))).pushes), ['bob', 'dave']);

    // One channel turned back down: it alone stops, the rest of the server carries on.
    assert.equal((await w.setLevel('dave', channel(quiet, 'mentions'))).status, 200);
    assert.deepEqual((await w.pushedBy(() => w.say('s4', serverId, quiet, 'not for dave'))).pushes, []);
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s4', serverId, misc, 'still for dave'))).pushes), ['dave']);

    // The server muted, with one channel set louder and one set to mentions.
    assert.equal((await w.setLevel('dave', serverLevel('none'))).status, 200);
    assert.equal((await w.setLevel('dave', channel(general, 'all'))).status, 200);
    const settings = await w.settingsOf('dave');
    assert.deepEqual(settings, { servers: { [serverId]: 'none' }, channels: { [serverId]: { [quiet]: 'mentions', [general]: 'all' } }, dms: {}, groups: {} });
    assert.equal(effectiveChannelLevel(settings, serverId, general), 'all');
    assert.equal(effectiveChannelLevel(settings, serverId, quiet), 'mentions');
    assert.equal(effectiveChannelLevel(settings, serverId, misc), 'none', 'a channel with no setting follows its server');

    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s4', serverId, general, 'louder here'))).pushes), ['bob', 'dave']);
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s7', serverId, quiet, '@dave mentions still reach this one'))).pushes), ['dave']);
    assert.deepEqual((await w.pushedBy(() => w.say('s7', serverId, misc, '@dave the server is muted'))).pushes, [], 'muted through the server: not even a mention');

    // Clearing the channel's setting: it follows the (muted) server again.
    assert.equal((await w.setLevel('dave', channel(quiet, null))).status, 200);
    assert.deepEqual((await w.pushedBy(() => w.say('s7', serverId, quiet, '@dave now muted here too'))).pushes, []);

    // "Only @mentions" on a server is the default, so it is stored as no row at all.
    assert.equal((await w.setLevel('dave', serverLevel('mentions'))).status, 200);
    assert.deepEqual((await w.settingsOf('dave')).servers, {});
    assert.deepEqual((await w.rows('SELECT scope, target, level FROM notification_settings WHERE user_id = ? ORDER BY target', [w.ids.dave])), [{ scope: 'channel', target: general, level: 'all' }]);
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s7', serverId, misc, '@dave back to normal'))).pushes), ['dave']);
    assert.equal((await w.setLevel('dave', channel(general, null))).status, 200);
  });

  test('"All messages" never pushes someone who cannot open the channel', async () => {
    // carol asks for everything in the server. The private channel is part of the server, and she
    // is not on its list.
    assert.equal((await w.setLevel('carol', { scope: 'server', serverId, level: 'all' })).status, 200);
    assert.equal((await w.setLevel('carol', channel(general, null))).status, 200);
    assert.equal((await w.setLevel('bob', channel(officers, 'all'))).status, 200);

    const secret = await w.pushedBy(() => w.say('s5', serverId, officers, 'the plan is on, @carol'));
    assert.deepEqual(pushedTo(secret.pushes), ['bob'], 'neither her level nor a mention gets a private channel onto carol\'s lock screen');
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s5', serverId, misc, 'public, so carol hears it'))).pushes), ['carol']);

    // bob is taken off the private channel's list. His setting for it is still on file, and counts
    // for nothing: who may be pushed is asked of the access rules every time.
    assert.equal((await w.call('DELETE', `/servers/${serverId}/channels/${officers}/members/bob`, undefined, w.tok.alice)).status, 200);
    assert.equal((await w.rows("SELECT COUNT(*) AS n FROM notification_settings WHERE user_id = ? AND target = ? AND level = 'all'", [w.ids.bob, officers]))[0].n, 1);
    assert.deepEqual((await w.pushedBy(() => w.say('s5', serverId, officers, 'bob is out of the room'))).pushes, []);
    // And he can no longer set anything for it (clearing his old row is still his to do).
    assert.equal((await w.setLevel('bob', channel(officers, 'none'))).status, 404);
    assert.equal((await w.setLevel('bob', channel(officers, null))).status, 200);
    assert.equal((await w.setLevel('carol', { scope: 'server', serverId, level: null })).status, 200);
  });

  test('someone you have blocked never notifies you, whatever your level', async () => {
    // bob still listens to everything in #general, and blocks s6.
    assert.equal((await w.call('POST', '/blocks/s6', {}, w.tok.bob)).status, 200);
    const before = (await w.call('GET', '/unreads', undefined, w.tok.bob)).data.unreads[serverId]?.[general] || 0;
    const blocked = await w.pushedBy(() => w.say('s6', serverId, general, 'hello @bob, and everyone'));
    assert.deepEqual(blocked.pushes, [], 'not as a listener and not as a mention');
    const after = (await w.call('GET', '/unreads', undefined, w.tok.bob)).data.unreads[serverId]?.[general] || 0;
    assert.equal(after, before, 'and it raises no badge either');
    // The same message from someone he has not blocked does reach him.
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('s8', serverId, general, 'hello everyone'))).pushes), ['bob']);
    assert.equal((await w.call('DELETE', '/blocks/s6', undefined, w.tok.bob)).status, 200);
  });

  test('a change reaches the person\'s other windows, and nobody else', async () => {
    const first = await connect(w.server.base, w.tok.dave);
    const second = await connect(w.server.base, w.tok.dave);
    const bystander = await connect(w.server.base, w.tok.carol);
    try {
      let leaked = null;
      bystander.on('notifications:updated', (p) => { leaked = p; });
      const heard = [once(first, 'notifications:updated'), once(second, 'notifications:updated')];
      const res = await w.setLevel('dave', channel(misc, 'none'));
      assert.equal(res.status, 200);
      const expected = { settings: { servers: {}, channels: { [serverId]: { [misc]: 'none' } }, dms: {}, groups: {} } };
      for (const event of await Promise.all(heard)) assert.deepEqual(event, expected, 'the whole settings object, the same on every device');
      assert.deepEqual(res.data.settings, expected.settings);

      const cleared = [once(first, 'notifications:updated'), once(second, 'notifications:updated')];
      assert.equal((await w.setLevel('dave', channel(misc, null))).status, 200);
      for (const event of await Promise.all(cleared)) assert.deepEqual(event.settings.channels, {});
      await sleep(60);
      assert.equal(leaked, null, 'settings are private to the person they belong to');
    } finally {
      first.close(); second.close(); bystander.close();
    }
  });

  test('leaving, being removed, and deleting a channel or the server take the settings with them', async () => {
    const { call, tok } = w;
    const mine = async (who) => (await w.rows('SELECT scope, target FROM notification_settings WHERE user_id = ? ORDER BY scope, target', [w.ids[who]]));
    const sorted = (list) => [...list].sort((a, b) => `${a.scope}${a.target}`.localeCompare(`${b.scope}${b.target}`));
    await w.setLevel('dave', { scope: 'server', serverId, level: 'all' });
    await w.setLevel('dave', channel(quiet, 'none'));
    await w.setLevel('carol', channel(quiet, 'all'));
    await w.setLevel('carol', channel(misc, 'all'));
    await w.setLevel('carol', { scope: 'server', serverId, level: 'none' });
    await w.setLevel('s1', channel(misc, 'none'));
    // A setting for somewhere else must survive all of it.
    await w.setLevel('dave', { scope: 'server', serverId: 'demo', level: 'none' });

    // A channel is deleted: everyone's setting for it goes; the rest stay.
    assert.equal((await call('DELETE', `/servers/${serverId}/channels/${quiet}`, undefined, tok.alice)).status, 200);
    assert.deepEqual(await mine('carol'), sorted([{ scope: 'channel', target: misc }, { scope: 'server', target: serverId }]));

    // dave leaves: what he had set here goes, the commons setting stays.
    assert.equal((await call('POST', `/servers/${serverId}/leave`, {}, tok.dave)).status, 200);
    assert.deepEqual(await mine('dave'), [{ scope: 'server', target: 'demo' }]);

    // carol is kicked: the same.
    assert.equal((await call('DELETE', `/servers/${serverId}/members/carol`, undefined, tok.alice)).status, 200);
    assert.deepEqual(await mine('carol'), []);

    // The server is deleted: whatever anyone still had for it or its channels goes.
    assert.equal((await w.rows('SELECT COUNT(*) AS n FROM notification_settings WHERE server_id = ?', [serverId]))[0].n >= 2, true, 'bob and s1 still have settings here');
    assert.equal((await call('DELETE', `/servers/${serverId}`, undefined, tok.alice)).status, 200);
    assert.deepEqual(await w.rows('SELECT user_id, scope, target FROM notification_settings'), [{ user_id: w.ids.dave, scope: 'server', target: 'demo' }]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('muting direct messages and group chats', () => {
  let w, serverId;
  const dm = (from, to, text) => w.call('POST', '/messages/send', { toUsername: to, text }, w.tok[from]);
  const mute = (who, of, level = 'none') => w.setLevel(who, { scope: 'dm', userId: String(w.ids[of]), level });

  before(async () => {
    w = await world(['alice', 'bob', 'carol', 'dave']);
    serverId = (await w.call('POST', '/servers', { name: 'Mutes' }, w.tok.alice)).data.server.id;
    for (const username of ['bob', 'carol', 'dave']) await w.call('POST', `/servers/${serverId}/invite`, { username }, w.tok.alice);
  });
  after(async () => { await w.stop(); });

  test('a muted conversation is never pushed, and is counted without adding to the Messages total', async () => {
    const carolSock = await connect(w.server.base, w.tok.carol);
    try {
      // Before: a DM pushes, and counts.
      assert.deepEqual(pushedTo((await w.pushedBy(() => dm('alice', 'carol', 'one'))).pushes), ['carol']);

      const told = once(carolSock, 'dm:unread-updated');
      const set = await mute('carol', 'alice');
      assert.equal(set.status, 200);
      assert.deepEqual(set.data.settings.dms, { [String(w.ids.alice)]: true });
      // Muting changes the total at once, on every window: the unread message from alice is still
      // there in her row, and no longer in the badge.
      const afterMute = await told;
      assert.equal(afterMute.totalUnread, 0);
      assert.deepEqual(afterMute.byPeer, [{ peerId: String(w.ids.alice), peerUsername: 'alice', unreadCount: 1 }]);

      const quiet = await w.pushedBy(() => dm('alice', 'carol', 'two'));
      assert.equal(quiet.result.status, 200, 'the message itself is delivered as always');
      assert.deepEqual(quiet.pushes, [], 'no push for a muted conversation');
      const thread = await w.call('GET', '/messages/with/alice', undefined, w.tok.carol);
      assert.equal(thread.data.totalUnread, 0);
      assert.ok(thread.data.messages.some((m) => m.text === 'two'));

      // Only that conversation: bob still gets through, and still counts.
      assert.deepEqual(pushedTo((await w.pushedBy(() => dm('bob', 'carol', 'from bob'))).pushes), ['carol']);
      assert.equal((await w.call('GET', '/messages/with/bob', undefined, w.tok.carol)).data.totalUnread, 1);
      // And only for the person who muted: alice hears carol as before.
      assert.deepEqual(pushedTo((await w.pushedBy(() => dm('carol', 'alice', 'reply'))).pushes), ['alice']);

      // Unmuting puts the count back in the total and the pushes back on.
      const back = once(carolSock, 'dm:unread-updated', (p) => p.totalUnread === 3);
      assert.equal((await mute('carol', 'alice', null)).status, 200);
      await back;
      assert.deepEqual((await w.settingsOf('carol')).dms, {});
      assert.deepEqual(pushedTo((await w.pushedBy(() => dm('alice', 'carol', 'three'))).pushes), ['carol']);
    } finally {
      carolSock.close();
    }
  });

  test('a muted group chat pushes everyone but the person who muted it', async () => {
    const group = (await w.call('POST', '/groups', { name: 'Raid', members: ['bob', 'carol'] }, w.tok.alice)).data.group;
    const send = (from, text) => w.call('POST', `/groups/${group.id}/messages`, { text }, w.tok[from]);
    assert.deepEqual(pushedTo((await w.pushedBy(() => send('alice', 'ready?'))).pushes), ['bob', 'carol']);

    const set = await w.setLevel('bob', { scope: 'group', groupId: group.id, level: 'none' });
    assert.equal(set.status, 200);
    assert.deepEqual(set.data.settings.groups, { [group.id]: true });
    assert.deepEqual(pushedTo((await w.pushedBy(() => send('alice', 'go go go'))).pushes), ['carol']);

    // Still counted for bob (the row shows it, dimmed); the client keeps it out of the Messages
    // badge using the settings that arrive with the unread counts.
    const bobs = (await w.call('GET', '/groups', undefined, w.tok.bob)).data.groups.find((g) => g.id === group.id);
    assert.equal(bobs.unreadCount, 2);
    assert.deepEqual((await w.call('GET', '/unreads', undefined, w.tok.bob)).data.notifications.groups, { [group.id]: true });

    // dave is not in the group: he can neither mute it nor learn that it exists.
    assert.equal((await w.setLevel('dave', { scope: 'group', groupId: group.id, level: 'none' })).status, 404);

    // Leaving takes the mute with it; so does the group ending.
    assert.equal((await w.call('DELETE', `/groups/${group.id}/members/bob`, undefined, w.tok.bob)).status, 200);
    assert.deepEqual(await w.rows("SELECT * FROM notification_settings WHERE scope = 'group'"), []);
    await w.setLevel('carol', { scope: 'group', groupId: group.id, level: 'none' });
    await w.call('DELETE', `/groups/${group.id}/members/alice`, undefined, w.tok.alice);
    assert.equal((await w.rows("SELECT COUNT(*) AS n FROM notification_settings WHERE scope = 'group'"))[0].n, 1, 'carol is still in it');
    await w.call('DELETE', `/groups/${group.id}/members/carol`, undefined, w.tok.carol);
    assert.deepEqual(await w.rows("SELECT * FROM notification_settings WHERE scope = 'group'"), [], 'the last member left: the group and every setting for it are gone');
  });

  test('settings follow a rename without anything being carried, on both sides', async () => {
    // bob mutes dave, and sets a level on the server. Then both of them change their names.
    assert.equal((await mute('bob', 'dave')).status, 200);
    assert.equal((await w.setLevel('bob', { scope: 'server', serverId, level: 'all' })).status, 200);
    const before = await w.rows('SELECT user_id, scope, target, level FROM notification_settings ORDER BY scope');

    const renamedBob = await w.call('POST', '/user/username', { username: 'bobby' }, w.tok.bob);
    assert.equal(renamedBob.status, 200);
    w.tok.bobby = renamedBob.data.token;
    const renamedDave = await w.call('POST', '/user/username', { username: 'david' }, w.tok.dave);
    assert.equal(renamedDave.status, 200);
    w.tok.david = renamedDave.data.token;

    assert.deepEqual(await w.rows('SELECT user_id, scope, target, level FROM notification_settings ORDER BY scope'), before, 'keyed by user id: a rename touches no row');
    assert.deepEqual(await w.settingsOf('bobby'), { servers: { [serverId]: 'all' }, channels: {}, dms: { [String(w.ids.dave)]: true }, groups: {} });

    // Still muted, under the new names (the push browser moved with the rename too).
    const quiet = await w.pushedBy(() => dm('david', 'bobby', 'new names, same mute'));
    assert.equal(quiet.result.status, 200);
    assert.deepEqual(quiet.pushes, []);
    // And "All messages" still reaches bobby.
    const general = (await dbAll(w.server.dataDir, "SELECT id FROM channels WHERE server_id = ? AND type = 'text'", [serverId]))[0].id;
    assert.deepEqual(pushedTo((await w.pushedBy(() => w.say('carol', serverId, general, 'hello all'))).pushes), ['bob'], 'bobby\'s browser, subscribed as bob');
  });

  test('deleting an account clears what it set, and everyone else\'s mute of it', async () => {
    const confirmDelete = async (who, id) => {
      assert.equal((await w.call('POST', '/account/deactivate', {}, w.tok[who])).status, 200);
      const [row] = await dbAll(w.server.dataDir, "SELECT token FROM auth_tokens WHERE purpose = 'deactivate' AND user_id = ?", [id]);
      assert.equal((await w.call('POST', '/account/deactivate/confirm', { token: row.token })).status, 200);
    };
    // carol mutes david (once dave) and alice; alice mutes carol. bobby already mutes david.
    assert.equal((await mute('carol', 'dave')).status, 200);
    assert.equal((await mute('carol', 'alice')).status, 200);
    assert.equal((await mute('alice', 'carol')).status, 200);
    const dmRows = () => w.rows("SELECT user_id, target FROM notification_settings WHERE scope = 'dm' ORDER BY user_id, target");
    assert.equal((await dmRows()).length, 4);

    // david goes: every mute OF him goes, since there is nobody left for it to be about.
    await confirmDelete('david', w.ids.dave);
    assert.deepEqual(await dmRows(), [
      { user_id: w.ids.alice, target: String(w.ids.carol) },
      { user_id: w.ids.carol, target: String(w.ids.alice) },
    ].sort((a, b) => a.user_id - b.user_id));

    // alice goes, and she owns the server: her own settings, carol's mute of her, and everything
    // anyone had set for her server all go.
    assert.equal((await w.rows('SELECT COUNT(*) AS n FROM notification_settings WHERE target = ?', [serverId]))[0].n, 1, 'bobby\'s level for the server');
    await confirmDelete('alice', w.ids.alice);
    assert.deepEqual(await w.rows('SELECT * FROM notification_settings'), []);
  });
});

// ---------------------------------------------------------------------------------------------
describe('push allowances with levels', () => {
  let w, serverId, general;

  before(async () => {
    w = await world(['alice', 'bob', 'carol']);
    serverId = (await w.call('POST', '/servers', { name: 'Busy' }, w.tok.alice)).data.server.id;
    for (const username of ['bob', 'carol']) await w.call('POST', `/servers/${serverId}/invite`, { username }, w.tok.alice);
    general = (await dbAll(w.server.dataDir, "SELECT id FROM channels WHERE server_id = ? AND type = 'text'", [serverId]))[0].id;
  });
  after(async () => { await w.stop(); });

  test('"All messages" is held to a push allowance of its own, which a mention never pays for', async () => {
    assert.equal((await w.setLevel('bob', { scope: 'channel', serverId, channelId: general, level: 'all' })).status, 200);
    const burst = await w.pushedBy(async () => {
      for (let i = 0; i < CHANNEL_PUSHES_PER_WINDOW + 3; i += 1) await w.say('alice', serverId, general, `line ${i}`);
    });
    assert.equal(burst.pushes.length, CHANNEL_PUSHES_PER_WINDOW, 'the first few lines of a burst ring; the rest are what the unread badge is for');
    assert.ok(burst.pushes.every((p) => p.endpoint.endsWith('/bob')));
    // Every one of them was still delivered and counted.
    assert.equal((await w.call('GET', '/unreads', undefined, w.tok.bob)).data.unreads[serverId][general], CHANNEL_PUSHES_PER_WINDOW + 3);

    // The burst used none of the mention allowance: carol (on the default) is still reached, and
    // so is bob when it is him who is named.
    const named = await w.pushedBy(() => w.say('alice', serverId, general, '@carol and @bob, over here'));
    assert.deepEqual(pushedTo(named.pushes), ['bob', 'carol']);
    assert.ok(named.pushes.every((p) => p.payload.title.startsWith('🔔')));
  });

  test('the two allowances are separate buckets, each per sender', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-levels-cap-'));
    try {
      const push = createPush({ db: { get: async () => null, all: async () => [], run: async () => ({}) }, dataDir: dir, env: {}, sender: async () => {}, log: { log() {}, warn() {} } });
      const t0 = 5_000_000;
      const listening = Array.from({ length: CHANNEL_PUSHES_PER_WINDOW + 4 }, (_, i) => push.allowChannelPush('chatty', t0 + i));
      assert.equal(listening.filter(Boolean).length, CHANNEL_PUSHES_PER_WINDOW);
      const mentions = Array.from({ length: MENTION_PUSHES_PER_WINDOW }, (_, i) => push.allowMentionPush('chatty', t0 + 50 + i));
      assert.ok(mentions.every(Boolean), 'a full burst of listener pushes leaves the mention allowance untouched');
      assert.equal(push.allowMentionPush('chatty', t0 + 100), false, 'which has its own ceiling');
      assert.equal(push.allowChannelPush('someone-else', t0 + 100), true, 'per sender');
      assert.equal(push.allowChannelPush('chatty', t0 + 61_000), true, 'and it lifts once the window has passed');
      assert.ok(MAX_LEVEL_TARGETS >= 10 && MAX_LEVEL_TARGETS <= 200, 'one message reaches a bounded number of listeners');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
