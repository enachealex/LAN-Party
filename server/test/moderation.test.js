// Server moderation: bans, timeouts and the audit log (routes/moderation.js, services/moderation.js).
//
// Most of this is about what must NOT be possible: moderating upwards or sideways, a banned person
// finding a way back (a link, a direct invite, a new name, a restart), a timed-out member writing
// through a raw socket that ignores what the client would have stopped, anyone but staff reading
// the log, and any of it touching the public commons.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUserFromOwnAddress: makeUser, dbAll } = require('./helpers');
const { MODERATION_WRITE_MAX } = require('../routes/moderation');
const { REASON_MAX, TIMEOUT_MAX_MINUTES } = require('../services/moderation');

const INVALID_LINK = { valid: false, error: 'This invite link is invalid or has expired.' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
// Resolves true if the event does NOT arrive within the window.
const never = (socket, event, match = () => true, ms = 700) => once(socket, event, match, ms).then(() => false, () => true);
// Emit with an acknowledgement and wait for it.
const ask = (socket, event, payload) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve('__no-answer__'), 5000);
  socket.emit(event, payload, (answer) => { clearTimeout(timer); resolve(answer); });
});

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

// Enter a server the way the client does, and hand back what the server sent about it.
async function joinServer(socket, serverId) {
  const state = once(socket, 'server:state', (s) => s.server.id === serverId);
  const init = once(socket, 'messages:init', (m) => m.serverId === serverId);
  socket.emit('join', { serverId });
  return { state: await state, init: await init };
}

// A server with one owner, and the named admins and members added to it.
async function makeServer(call, tok, { name, owner, admins = [], members = [] }) {
  const id = (await call('POST', '/servers', { name }, tok[owner])).data.server.id;
  for (const who of [...admins, ...members]) {
    assert.equal((await call('POST', `/servers/${id}/invite`, { username: who }, tok[owner])).status, 200);
  }
  for (const who of admins) {
    assert.equal((await call('PATCH', `/servers/${id}/members/${who}`, { role: 'admin' }, tok[owner])).status, 200);
  }
  return id;
}
const memberNames = async (call, token, serverId) => (await call('GET', `/servers/${serverId}/members`, undefined, token)).data.members.map((m) => m.username).sort();
const mintLink = async (call, token, serverId, body = {}) => (await call('POST', `/servers/${serverId}/invites`, body, token)).data.invite.code;

describe('who may ban or time out whom', () => {
  let server, call, serverId, elsewhereId;
  const tok = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'adm1', 'adm2', 'mem1', 'mem2', 'out', 'elsewhere']) tok[name] = await makeUser(server.base, name);
    serverId = await makeServer(call, tok, { name: 'Ranks', owner: 'own', admins: ['adm1', 'adm2'], members: ['mem1', 'mem2'] });
    // `elsewhere` owns a different server: staff there, nobody here.
    elsewhereId = await makeServer(call, tok, { name: 'Elsewhere', owner: 'elsewhere' });
  });
  after(async () => { await server.stop(); });

  const actions = {
    ban: (actor, target) => call('POST', `/servers/${serverId}/bans/${target}`, {}, tok[actor]),
    timeout: (actor, target) => call('POST', `/servers/${serverId}/timeouts/${target}`, { minutes: 5 }, tok[actor]),
    lift: (actor, target) => call('DELETE', `/servers/${serverId}/timeouts/${target}`, undefined, tok[actor]),
  };
  const untouched = async () => {
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_bans'))[0].n, 0);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_timeouts'))[0].n, 0);
    assert.deepEqual(await memberNames(call, tok.own, serverId), ['adm1', 'adm2', 'mem1', 'mem2', 'own']);
  };

  // Every refusal in the matrix, for all three actions. Nothing here may change anything.
  const REFUSED = [
    // actor,      target,  status, why
    ['own', 'own', 400, 'the owner on themselves'],
    ['adm1', 'own', 403, 'upwards: an admin on the owner'],
    ['adm1', 'adm2', 403, 'sideways: an admin on another admin'],
    ['adm1', 'adm1', 400, 'an admin on themselves'],
    ['mem1', 'own', 403, 'a member on the owner'],
    ['mem1', 'adm1', 403, 'a member on an admin'],
    ['mem1', 'mem2', 403, 'a member on another member'],
    ['mem1', 'mem1', 403, 'a member on themselves'],
    ['out', 'mem1', 403, 'someone who is not in the server'],
    ['out', 'own', 403, 'someone who is not in the server, on the owner'],
    ['elsewhere', 'mem1', 403, 'the owner of a different server'],
  ];
  for (const [actor, target, status, why] of REFUSED) {
    test(`refused: ${why}`, async () => {
      for (const [name, act] of Object.entries(actions)) {
        const res = await act(actor, target);
        assert.equal(res.status, status, `${name} by ${actor} on ${target}: ${JSON.stringify(res.data)}`);
      }
      await untouched();
    });
  }

  test('no token: 401 on every route', async () => {
    assert.equal((await call('GET', `/servers/${serverId}/bans`)).status, 401);
    assert.equal((await call('POST', `/servers/${serverId}/bans/mem1`, {})).status, 401);
    assert.equal((await call('DELETE', `/servers/${serverId}/bans/mem1`)).status, 401);
    assert.equal((await call('POST', `/servers/${serverId}/timeouts/mem1`, { minutes: 5 })).status, 401);
    assert.equal((await call('DELETE', `/servers/${serverId}/timeouts/mem1`)).status, 401);
    assert.equal((await call('GET', `/servers/${serverId}/audit`)).status, 401);
    await untouched();
  });

  test('the ban list is for staff of that server only', async () => {
    assert.equal((await call('GET', `/servers/${serverId}/bans`, undefined, tok.own)).status, 200);
    assert.equal((await call('GET', `/servers/${serverId}/bans`, undefined, tok.adm1)).status, 200);
    for (const who of ['mem1', 'out', 'elsewhere']) {
      assert.equal((await call('GET', `/servers/${serverId}/bans`, undefined, tok[who])).status, 403, who);
    }
    assert.equal((await call('GET', '/servers/srv-nope/bans', undefined, tok.own)).status, 404);
    assert.equal((await call('GET', `/servers/${elsewhereId}/bans`, undefined, tok.own)).status, 403, 'an owner elsewhere is nobody here');
  });

  test('allowed: an admin on a member, the owner on an admin (timeout, then lift)', async () => {
    assert.equal((await actions.timeout('adm1', 'mem1')).status, 200);
    assert.equal((await actions.timeout('own', 'adm2')).status, 200);
    // Lifting is held to the same rules: an admin cannot lift another admin's, nor a member their own.
    assert.equal((await actions.lift('adm1', 'adm2')).status, 403);
    assert.equal((await actions.lift('adm2', 'adm2')).status, 400);
    assert.equal((await actions.lift('mem1', 'mem1')).status, 403);
    assert.equal((await actions.lift('adm2', 'mem1')).status, 200, 'any admin may lift a member\'s');
    assert.equal((await actions.lift('own', 'adm2')).status, 200);
    await untouched();
  });

  test('allowed: an admin bans a member, the owner bans an admin', async () => {
    assert.equal((await actions.ban('adm1', 'mem2')).status, 200);
    assert.equal((await actions.ban('own', 'adm2')).status, 200);
    assert.deepEqual(await memberNames(call, tok.own, serverId), ['adm1', 'mem1', 'own']);
    // Any staff member can unban; a member cannot.
    assert.equal((await call('DELETE', `/servers/${serverId}/bans/adm2`, undefined, tok.mem1)).status, 403);
    assert.equal((await call('DELETE', `/servers/${serverId}/bans/adm2`, undefined, tok.adm1)).status, 200);
  });
});

describe('none of it exists on the public commons', () => {
  let server, call;
  const tok = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['pat', 'quo']) tok[name] = await makeUser(server.base, name);
  });
  after(async () => { await server.stop(); });

  test('every moderation route refuses the commons by name', async () => {
    const attempts = [
      ['GET', '/servers/demo/bans', undefined],
      ['POST', '/servers/demo/bans/quo', { reason: 'nope' }],
      ['DELETE', '/servers/demo/bans/quo', undefined],
      ['POST', '/servers/demo/timeouts/quo', { minutes: 5 }],
      ['DELETE', '/servers/demo/timeouts/quo', undefined],
      ['GET', '/servers/demo/audit', undefined],
    ];
    for (const [method, route, body] of attempts) {
      const res = await call(method, route, body, tok.pat);
      assert.equal(res.status, 400, `${method} ${route}`);
    }
    for (const table of ['server_bans', 'server_timeouts', 'server_audit']) {
      assert.equal((await dbAll(server.dataDir, `SELECT COUNT(*) AS n FROM ${table}`))[0].n, 0, table);
    }
  });

  test('rows for the commons, however they got there, are ignored', async () => {
    // Written straight into the database: no route will do it.
    const far = Date.now() + 3_600_000;
    await dbAll(server.dataDir, "INSERT INTO server_timeouts (server_id, username, until, timed_out_by, reason, created_at) VALUES ('demo', 'quo', ?, 'pat', 'x', ?)", [far, Date.now()]);
    await dbAll(server.dataDir, "INSERT INTO server_bans (server_id, username, banned_by, reason, banned_at) VALUES ('demo', 'quo', 'pat', 'x', ?)", [Date.now()]);
    const quo = await connect(server.base, tok.quo);
    try {
      const { state } = await joinServer(quo, 'demo');
      assert.equal(state.myTimeout, null);
      const echoed = once(quo, 'message', (m) => m.text === 'still talking');
      quo.emit('message', { serverId: 'demo', channelId: 'general', text: 'still talking' });
      await echoed;
      const peers = once(quo, 'voice:peers');
      quo.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      assert.ok(Array.isArray(await peers));
    } finally { quo.close(); }
  });

  test('what happens in the commons is not written to any audit log', async () => {
    const made = await call('POST', '/servers/demo/channels', { name: 'side-room' }, tok.pat);
    assert.equal(made.status, 200);
    assert.equal((await call('PATCH', `/servers/demo/channels/${made.data.channel.id}`, { name: 'side' }, tok.pat)).status, 200);
    assert.equal((await call('DELETE', `/servers/demo/channels/${made.data.channel.id}`, undefined, tok.pat)).status, 200);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_audit'))[0].n, 0);
  });
});

describe('bans', () => {
  let server, call, serverId, generalId, voiceId, privateId;
  const tok = {};
  const bans = async (token = tok.own) => (await call('GET', `/servers/${serverId}/bans`, undefined, token)).data.bans;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'adm', 'bad', 'kik', 'new1', 'new2', 'mem']) tok[name] = await makeUser(server.base, name);
    // `bad` starts as an admin so that he has minted a link of his own before he is banned.
    serverId = await makeServer(call, tok, { name: 'Lounge', owner: 'own', admins: ['adm', 'bad'], members: ['kik', 'mem'] });
    const channels = (await call('GET', '/user/sync', undefined, tok.own)).data.servers[serverId].channels;
    generalId = channels.find((c) => c.type === 'text').id;
    voiceId = channels.find((c) => c.type === 'voice').id;
    privateId = (await call('POST', `/servers/${serverId}/channels`, { name: 'staff-only', privacy: 'private', members: ['kik'] }, tok.own)).data.channel.id;
  });
  after(async () => { await server.stop(); });

  test('input is checked before anything happens', async () => {
    const tooLong = await call('POST', `/servers/${serverId}/bans/mem`, { reason: 'x'.repeat(REASON_MAX + 1) }, tok.own);
    assert.equal(tooLong.status, 400);
    assert.equal((await call('POST', `/servers/${serverId}/bans/mem`, { reason: 42 }, tok.own)).status, 400);
    const ghost = await call('POST', `/servers/${serverId}/bans/nobody-at-all`, {}, tok.own);
    assert.equal(ghost.status, 404, 'a ban is on an account, not on a name nobody holds');
    assert.equal((await call('DELETE', `/servers/${serverId}/bans/mem`, undefined, tok.own)).status, 404, 'unbanning someone who is not banned');
    assert.deepEqual(await bans(), []);
    assert.ok((await memberNames(call, tok.own, serverId)).includes('mem'));
  });

  test('banning a member removes them the way a kick does, and tells them it was a ban', async () => {
    const badLink = await mintLink(call, tok.bad, serverId);
    await call('POST', `/servers/${serverId}/channels/${privateId}/members`, { username: 'bad' }, tok.own);
    const [{ app_room_epoch: epochBefore }] = await dbAll(server.dataDir, 'SELECT app_room_epoch FROM servers WHERE id = ?', [serverId]);

    // bad is in a call with mem when it happens.
    const bad = await connect(server.base, tok.bad);
    const mem = await connect(server.base, tok.mem);
    try {
      await joinServer(bad, serverId);
      for (const s of [mem, bad]) {
        const peers = once(s, 'voice:peers');
        s.emit('voice:join', { serverId, channelId: voiceId });
        await peers;
      }
      const removed = once(bad, 'server:removed');
      const hungUp = once(bad, 'voice:removed');
      const peerLeft = once(mem, 'voice:peer-left', (p) => p.id === bad.id);

      const res = await call('POST', `/servers/${serverId}/bans/bad`, { reason: '  spamming the lounge  ' }, tok.own);
      assert.equal(res.status, 200);
      assert.equal(res.data.removed, true);
      assert.equal(res.data.ban.reason, 'spamming the lounge', 'trimmed');
      assert.equal(res.data.ban.bannedBy, 'own');

      assert.deepEqual(await removed, { serverId, banned: true });
      assert.equal((await hungUp).serverId, serverId);
      await peerLeft;

      // His socket still has the text channel open. A client that ignores "you were removed" must
      // not go on receiving what is said there, or being sent the member list.
      await joinServer(mem, serverId);
      const deaf = Promise.all([never(bad, 'message'), never(bad, 'server:state'), never(bad, 'unread:bump')]);
      const heard = once(mem, 'message', (m) => m.text === 'good riddance');
      mem.emit('message', { serverId, channelId: generalId, text: 'good riddance' });
      await heard;
      assert.deepEqual(await deaf, [true, true, true]);
      // Nor can he write there, or open the channel again.
      const refused = once(bad, 'message:error');
      bad.emit('message', { serverId, channelId: generalId, text: 'still here' });
      assert.equal((await refused).reason, 'no-access');
      const noHistory = never(bad, 'messages:init');
      bad.emit('joinChannel', { serverId, channelId: generalId });
      assert.ok(await noHistory);
    } finally { bad.close(); mem.close(); }

    // Everything the kick route cleans up.
    assert.ok(!(await memberNames(call, tok.own, serverId)).includes('bad'), 'membership');
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM channel_members WHERE username = 'bad'"))[0].n, 0, 'private-channel rows');
    assert.equal((await call('GET', `/invites/${badLink}`)).status, 404, 'the link he minted is dead');
    const [{ app_room_epoch: epochAfter }] = await dbAll(server.dataDir, 'SELECT app_room_epoch FROM servers WHERE id = ?', [serverId]);
    assert.equal(epochAfter, epochBefore + 1, 'app room keys were replaced');
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM server_removed WHERE username = 'bad'"))[0].n, 1);

    // And the record staff can read: who, by whom, why, when.
    const [entry, ...rest] = await bans(tok.adm);
    assert.equal(rest.length, 0);
    assert.deepEqual({ username: entry.username, bannedBy: entry.bannedBy, reason: entry.reason }, { username: 'bad', bannedBy: 'own', reason: 'spamming the lounge' });
    assert.ok(entry.bannedAt <= Date.now() && entry.bannedAt > Date.now() - 60_000);
  });

  test('a banned person cannot come back through any invite link, and the link is not charged', async () => {
    const link = await mintLink(call, tok.own, serverId, { maxUses: 1 });
    const refused = await call('POST', `/invites/${link}/accept`, undefined, tok.bad);
    assert.equal(refused.status, 404);
    assert.deepEqual(refused.data, INVALID_LINK, 'the same answer as for a dead code');
    assert.deepEqual(await call('POST', '/invites/AAAAAAAAAAAAAAAA/accept', undefined, tok.bad), refused);
    // The single use is still there for someone who may come in.
    const ok = await call('POST', `/invites/${link}/accept`, undefined, tok.new1);
    assert.equal(ok.status, 200);
    assert.ok(!(await memberNames(call, tok.own, serverId)).includes('bad'));
  });

  test('...nor by being invited by name: that is what separates a ban from a kick', async () => {
    // kik is only kicked: staff can simply add them again.
    assert.equal((await call('DELETE', `/servers/${serverId}/members/kik`, undefined, tok.own)).status, 200);
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'kik' }, tok.adm)).status, 200);
    assert.ok((await memberNames(call, tok.own, serverId)).includes('kik'));

    // bad is banned: neither an admin nor the owner can.
    for (const staff of ['adm', 'own']) {
      const res = await call('POST', `/servers/${serverId}/invite`, { username: 'bad' }, tok[staff]);
      assert.equal(res.status, 403);
      assert.match(res.data.error, /banned/i);
    }
    assert.ok(!(await memberNames(call, tok.own, serverId)).includes('bad'));
  });

  test('losing a channel takes an open socket out of it too: kicked, or taken off a private channel', async () => {
    // The same "still connected, no longer entitled" case as the ban above, by its two other routes.
    const kik = await connect(server.base, tok.kik);
    const own = await connect(server.base, tok.own);
    try {
      await call('POST', `/servers/${serverId}/channels/${privateId}/members`, { username: 'kik' }, tok.own);
      for (const s of [kik, own]) {
        await joinServer(s, serverId);
        const opened = once(s, 'messages:init', (m) => m.channelId === privateId);
        s.emit('joinChannel', { serverId, channelId: privateId });
        await opened;
      }
      const first = once(kik, 'message', (m) => m.text === 'for the few');
      own.emit('message', { serverId, channelId: privateId, text: 'for the few' });
      await first;

      // Off the private channel's list: still a member, but that channel is closed to him.
      assert.equal((await call('DELETE', `/servers/${serverId}/channels/${privateId}/members/kik`, undefined, tok.own)).status, 200);
      const deaf = never(kik, 'message', (m) => m.channelId === privateId);
      const heard = once(own, 'message', (m) => m.text === 'staff only now');
      own.emit('message', { serverId, channelId: privateId, text: 'staff only now' });
      await heard;
      assert.ok(await deaf, 'the private channel no longer reaches him');

      // Kicked while looking at the public channel: that stops reaching him as well.
      const reopened = once(kik, 'messages:init', (m) => m.channelId === generalId);
      kik.emit('joinChannel', { serverId, channelId: generalId });
      await reopened;
      own.emit('joinChannel', { serverId, channelId: generalId });
      await once(own, 'messages:init', (m) => m.channelId === generalId);
      assert.equal((await call('DELETE', `/servers/${serverId}/members/kik`, undefined, tok.own)).status, 200);
      const silent = Promise.all([never(kik, 'message'), never(kik, 'server:state')]);
      const echoed = once(own, 'message', (m) => m.text === 'after the kick');
      own.emit('message', { serverId, channelId: generalId, text: 'after the kick' });
      await echoed;
      assert.deepEqual(await silent, [true, true]);
    } finally { kik.close(); own.close(); }
    // Back in for the tests that follow.
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'kik' }, tok.own)).status, 200);
  });

  test('...nor under a new name: the ban follows the rename', async () => {
    const renamed = await call('POST', '/user/username', { username: 'totally-new' }, tok.bad);
    assert.equal(renamed.status, 200);
    tok.bad = renamed.data.token;
    assert.deepEqual((await bans()).map((b) => b.username), ['totally-new']);
    const link = await mintLink(call, tok.own, serverId);
    assert.deepEqual((await call('POST', `/invites/${link}/accept`, undefined, tok.bad)).data, INVALID_LINK);
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'totally-new' }, tok.own)).status, 403);
    // The old name is free again and carries nothing.
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'bad' }, tok.own)).status, 404);

    // The name of whoever placed a ban follows them too.
    const adm = await call('POST', '/user/username', { username: 'adm-renamed' }, tok.adm);
    tok.adm = adm.data.token;
    assert.equal((await call('POST', `/servers/${serverId}/bans/mem`, { reason: 'second' }, tok.adm)).status, 200);
    const again = await call('POST', '/user/username', { username: 'adm' }, tok.adm);
    tok.adm = again.data.token;
    assert.equal((await bans()).find((b) => b.username === 'mem').bannedBy, 'adm');
    assert.equal((await call('DELETE', `/servers/${serverId}/bans/mem`, undefined, tok.own)).status, 200);
  });

  test('...nor after the server restarts', async () => {
    const link = await mintLink(call, tok.own, serverId);
    await server.stop({ keepData: true });
    server = await startServer({ dataDir: server.dataDir });
    call = apiFor(server.base);
    assert.deepEqual((await bans()).map((b) => b.username), ['totally-new']);
    assert.deepEqual((await call('POST', `/invites/${link}/accept`, undefined, tok.bad)).data, INVALID_LINK);
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'totally-new' }, tok.own)).status, 403);
  });

  test('banning again replaces the reason and keeps one row', async () => {
    const res = await call('POST', `/servers/${serverId}/bans/totally-new`, { reason: 'and for the alt account' }, tok.adm);
    assert.equal(res.status, 200);
    assert.equal(res.data.removed, false, 'there was nobody left to remove');
    const list = await bans();
    assert.equal(list.length, 1);
    assert.equal(list[0].reason, 'and for the alt account');
    assert.equal(list[0].bannedBy, 'adm');
    // No reason at all is fine, and is stored as none.
    assert.equal((await call('POST', `/servers/${serverId}/bans/totally-new`, { reason: '   ' }, tok.own)).data.ban.reason, null);
  });

  test('unbanned, they are where a kick would have left them: no link, but staff can invite them', async () => {
    assert.equal((await call('DELETE', `/servers/${serverId}/bans/totally-new`, undefined, tok.adm)).status, 200);
    assert.deepEqual(await bans(), []);
    const link = await mintLink(call, tok.own, serverId);
    assert.deepEqual((await call('POST', `/invites/${link}/accept`, undefined, tok.bad)).data, INVALID_LINK, 'removed by staff, like a kick');
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'totally-new' }, tok.own)).status, 200);
    assert.ok((await memberNames(call, tok.own, serverId)).includes('totally-new'));
    // Back as a plain member: the admin role did not survive.
    assert.equal((await call('GET', `/servers/${serverId}/bans`, undefined, tok.bad)).status, 403);
  });

  test('someone who is not a member can be banned, which keeps them from ever joining', async () => {
    const res = await call('POST', `/servers/${serverId}/bans/new2`, { reason: 'known troublemaker' }, tok.adm);
    assert.equal(res.status, 200);
    assert.equal(res.data.removed, false);
    const link = await mintLink(call, tok.own, serverId);
    assert.deepEqual((await call('POST', `/invites/${link}/accept`, undefined, tok.new2)).data, INVALID_LINK);
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'new2' }, tok.own)).status, 403);
    // They were never removed from anything, so once unbanned a link lets them in.
    assert.equal((await call('DELETE', `/servers/${serverId}/bans/new2`, undefined, tok.own)).status, 200);
    assert.equal((await call('POST', `/invites/${link}/accept`, undefined, tok.new2)).status, 200);
  });

  test('a ban in one server means nothing in another', async () => {
    assert.equal((await call('POST', `/servers/${serverId}/bans/new2`, {}, tok.own)).status, 200);
    const otherId = await makeServer(call, tok, { name: 'Other', owner: 'adm' });
    assert.equal((await call('POST', `/servers/${otherId}/invite`, { username: 'new2' }, tok.adm)).status, 200);
    assert.deepEqual((await call('GET', `/servers/${otherId}/bans`, undefined, tok.adm)).data.bans, []);
  });

  test('deleting the server deletes its bans, timeouts and audit log', async () => {
    const goneId = await makeServer(call, tok, { name: 'Doomed', owner: 'own', members: ['mem'] });
    await call('POST', `/servers/${goneId}/bans/new1`, {}, tok.own);
    await call('POST', `/servers/${goneId}/timeouts/mem`, { minutes: 5 }, tok.own);
    assert.equal((await call('DELETE', `/servers/${goneId}`, undefined, tok.own)).status, 200);
    for (const table of ['server_bans', 'server_timeouts', 'server_audit']) {
      assert.equal((await dbAll(server.dataDir, `SELECT COUNT(*) AS n FROM ${table} WHERE server_id = ?`, [goneId]))[0].n, 0, table);
    }
  });
});

describe('timeouts', () => {
  let server, call, serverId, otherId, generalId, voiceId;
  const tok = {};
  const sock = {};
  const place = (target, body, by = 'own') => call('POST', `/servers/${serverId}/timeouts/${target}`, body, tok[by]);
  const lift = (target, by = 'own') => call('DELETE', `/servers/${serverId}/timeouts/${target}`, undefined, tok[by]);
  const stored = () => dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM messages WHERE server_id = ?', [serverId]).then((r) => r[0].n);

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'adm', 'tim', 'mem', 'out']) tok[name] = await makeUser(server.base, name);
    serverId = await makeServer(call, tok, { name: 'Quiet Room', owner: 'own', admins: ['adm'], members: ['tim', 'mem'] });
    otherId = await makeServer(call, tok, { name: 'Next Door', owner: 'adm', members: ['tim'] });
    for (const name of ['own', 'tim', 'mem']) {
      sock[name] = await connect(server.base, tok[name]);
      const { state } = await joinServer(sock[name], serverId);
      generalId = state.server.channels.find((c) => c.type === 'text').id;
      voiceId = state.server.channels.find((c) => c.type === 'voice').id;
    }
    // Something of tim's to edit, react to and pin once he is timed out.
    const echoed = once(sock.tim, 'message', (m) => m.text === 'from before');
    sock.tim.emit('message', { serverId, channelId: generalId, text: 'from before' });
    await echoed;
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server.stop();
  });

  test('the length and the reason are checked, and only a member can be timed out', async () => {
    for (const minutes of [undefined, 0, -5, 1.5, '5', TIMEOUT_MAX_MINUTES + 1, null, Infinity]) {
      const res = await place('tim', { minutes });
      assert.equal(res.status, 400, `minutes=${String(minutes)}`);
    }
    assert.equal((await place('tim', { minutes: 5, reason: 'x'.repeat(REASON_MAX + 1) })).status, 400);
    assert.equal((await place('tim', { minutes: 5, reason: { nested: true } })).status, 400);
    assert.equal((await place('out', { minutes: 5 })).status, 404, 'not a member');
    assert.equal((await place('nobody-at-all', { minutes: 5 })).status, 404);
    assert.equal((await lift('tim')).status, 404, 'nothing to lift');
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_timeouts'))[0].n, 0);
    // Both ends of the range are accepted.
    assert.equal((await place('mem', { minutes: 1 })).status, 200);
    assert.equal((await place('mem', { minutes: TIMEOUT_MAX_MINUTES })).status, 200);
    assert.equal((await lift('mem')).status, 200);
  });

  test('placing one: the member is told, with the reason, and every member list is marked', async () => {
    // tim is in a call with mem when it starts.
    for (const name of ['mem', 'tim']) {
      const peers = once(sock[name], 'voice:peers');
      sock[name].emit('voice:join', { serverId, channelId: voiceId });
      await peers;
    }
    const told = once(sock.tim, 'server:timeout');
    const timState = once(sock.tim, 'server:state', (s) => s.myTimeout);
    // Named for tim: states from the previous test (mem marked, then cleared) may still be arriving.
    const memState = once(sock.mem, 'server:state', (s) => s.members.some((m) => m.username === 'tim' && m.timeoutUntil));
    const hungUp = once(sock.tim, 'voice:removed');
    const peerLeft = once(sock.mem, 'voice:peer-left', (p) => p.id === sock.tim.id);

    const before = Date.now();
    const res = await place('tim', { minutes: 60, reason: 'cool off' }, 'adm');
    assert.equal(res.status, 200);
    const { until } = res.data.timeout;
    assert.deepEqual(res.data.timeout, { username: 'tim', until, reason: 'cool off', by: 'adm' });
    assert.ok(until >= before + 60 * 60_000 && until <= Date.now() + 60 * 60_000);

    const event = await told;
    assert.deepEqual({ ...event, now: 0 }, { serverId, until, reason: 'cool off', by: 'adm', now: 0 });
    assert.ok(Math.abs(event.now - Date.now()) < 5000, 'the server\'s clock rides along');

    // His own state carries the reason; everyone's roster carries only the marker.
    const mine = await timState;
    assert.deepEqual(mine.myTimeout, { until, reason: 'cool off', by: 'adm' });
    const theirs = await memState;
    assert.equal(theirs.myTimeout, null);
    const marked = theirs.members.filter((m) => m.timeoutUntil);
    assert.deepEqual(marked.map((m) => [m.username, m.timeoutUntil]), [['tim', until]]);
    assert.ok(!JSON.stringify(theirs.members).includes('cool off'), 'the reason is not in the roster');

    // Out of the call he was in.
    assert.deepEqual(await hungUp, { serverId, channelId: voiceId, reason: 'timeout', until });
    await peerLeft;
    sock.mem.emit('voice:leave', { serverId, channelId: voiceId });
  });

  test('a raw socket cannot send, edit, react, type, pin, start an activity or join voice', async () => {
    const [mine] = await dbAll(server.dataDir, "SELECT id FROM messages WHERE author = 'tim' AND server_id = ?", [serverId]);
    const before = await stored();
    // A fresh connection that never looked at the roster, as a hand-written client would be.
    const raw = await connect(server.base, tok.tim);
    try {
      await joinServer(raw, serverId);
      const nothingReachesOthers = Promise.all([
        never(sock.mem, 'message'), never(sock.mem, 'message:edited'), never(sock.mem, 'reaction:updated'),
        never(sock.mem, 'typing'), never(sock.mem, 'pins:updated'), never(sock.mem, 'unread:bump'),
      ]);

      const refused = once(raw, 'message:error');
      raw.emit('message', { serverId, channelId: generalId, text: 'you cannot stop me' });
      const error = await refused;
      assert.equal(error.reason, 'timed-out');
      assert.equal(error.text, 'you cannot stop me', 'what they typed comes back with the refusal');
      assert.ok(error.until > Date.now());

      assert.deepEqual(await ask(raw, 'message:edit', { id: mine.id, text: 'rewritten' }), { ok: false, error: 'timed-out' });
      raw.emit('reaction:toggle', { scope: 'channel', messageId: mine.id, emoji: '🔥' });
      raw.emit('typing', { scope: 'channel', serverId, channelId: generalId });
      raw.emit('message:pin', { id: mine.id });
      raw.emit('message:unpin', { id: mine.id });

      assert.ok((await nothingReachesOthers).every(Boolean), 'the channel heard nothing');
      assert.equal(await stored(), before, 'nothing was stored');
      const [row] = await dbAll(server.dataDir, 'SELECT text, reactions_json, pinned_at, edited_at FROM messages WHERE id = ?', [mine.id]);
      assert.deepEqual(row, { text: 'from before', reactions_json: null, pinned_at: null, edited_at: null });

      // Voice: refused at the door, told why, and given no participant list.
      const noRoster = never(raw, 'voice:peers');
      const door = once(raw, 'voice:removed');
      raw.emit('voice:join', { serverId, channelId: voiceId });
      const answer = await door;
      assert.equal(answer.reason, 'timeout');
      assert.ok(await noRoster);

      // Activities in that server's rooms: neither started nor stopped from outside.
      const memIn = once(sock.mem, 'voice:peers');
      const current = once(sock.mem, 'activity:update'); // a joiner is always sent the room's activity (none)
      sock.mem.emit('voice:join', { serverId, channelId: voiceId });
      await memIn;
      await current;
      const noActivity = never(sock.mem, 'activity:update');
      raw.emit('activity:start', { serverId, channelId: voiceId, type: 'whiteboard' });
      assert.ok(await noActivity);
      const started = once(sock.mem, 'activity:update', (a) => a && a.type === 'whiteboard');
      sock.mem.emit('activity:start', { serverId, channelId: voiceId, type: 'whiteboard' });
      await started;
      const notStopped = never(sock.mem, 'activity:update');
      raw.emit('activity:stop', { serverId, channelId: voiceId });
      raw.emit('activity:event', { serverId, channelId: voiceId, event: { kind: 'clear' } });
      assert.ok(await notStopped);
      // A soundboard clip into a room he is not in goes nowhere either.
      const silent = never(sock.mem, 'soundboard:play');
      raw.emit('soundboard:play', { serverId, channelId: voiceId, url: '/sounds/x.mp3', name: 'x' });
      assert.ok(await silent);
      sock.mem.emit('activity:stop', { serverId, channelId: voiceId });
      sock.mem.emit('voice:leave', { serverId, channelId: voiceId });
    } finally { raw.close(); }
  });

  test('he can still read, and can still delete what he said', async () => {
    const page = await call('GET', `/servers/${serverId}/channels/${generalId}/messages`, undefined, tok.tim);
    assert.equal(page.status, 200);
    assert.deepEqual(page.data.messages.map((m) => m.text), ['from before']);
    const init = once(sock.tim, 'messages:init', (m) => m.channelId === generalId);
    sock.tim.emit('joinChannel', { serverId, channelId: generalId });
    assert.equal((await init).messages.length, 1);
    assert.equal((await call('GET', `/search?q=before&scope=server&serverId=${serverId}`, undefined, tok.tim)).data.results.length, 1);
    // New messages from others still reach him.
    const heard = once(sock.tim, 'message', (m) => m.text === 'meanwhile');
    sock.mem.emit('message', { serverId, channelId: generalId, text: 'meanwhile' });
    await heard;
    // Taking his own words back is not "taking part", and is the one write left to him.
    const gone = once(sock.mem, 'message:deleted', (p) => p.id === page.data.messages[0].id);
    sock.tim.emit('message:delete', { id: page.data.messages[0].id });
    await gone;
  });

  test('it is per server: elsewhere, and in the commons, he is not timed out', async () => {
    const tim = await connect(server.base, tok.tim);
    try {
      const { state } = await joinServer(tim, otherId);
      assert.equal(state.myTimeout, null);
      const otherGeneral = state.server.channels.find((c) => c.type === 'text').id;
      const echoed = once(tim, 'message', (m) => m.text === 'fine over here');
      tim.emit('message', { serverId: otherId, channelId: otherGeneral, text: 'fine over here' });
      await echoed;
      await joinServer(tim, 'demo');
      const commons = once(tim, 'message', (m) => m.text === 'and here');
      tim.emit('message', { serverId: 'demo', channelId: 'general', text: 'and here' });
      await commons;
    } finally { tim.close(); }
  });

  test('leaving and coming back through a link does not shake it off', async () => {
    const link = await mintLink(call, tok.own, serverId);
    assert.equal((await call('POST', `/servers/${serverId}/leave`, undefined, tok.tim)).status, 200);
    assert.equal((await call('POST', `/invites/${link}/accept`, undefined, tok.tim)).status, 200);
    const raw = await connect(server.base, tok.tim);
    try {
      const { state } = await joinServer(raw, serverId);
      assert.ok(state.myTimeout && state.myTimeout.until > Date.now());
      const refused = once(raw, 'message:error');
      raw.emit('message', { serverId, channelId: generalId, text: 'back again' });
      assert.equal((await refused).reason, 'timed-out');
    } finally { raw.close(); }
    await joinServer(sock.tim, serverId); // leaving took his long-lived socket out of the server's rooms
  });

  test('a new name does not shake it off either', async () => {
    const renamed = await call('POST', '/user/username', { username: 'timothy' }, tok.tim);
    assert.equal(renamed.status, 200);
    const raw = await connect(server.base, renamed.data.token);
    try {
      const { state } = await joinServer(raw, serverId);
      assert.ok(state.myTimeout);
      assert.deepEqual(state.members.filter((m) => m.timeoutUntil).map((m) => m.username), ['timothy']);
    } finally { raw.close(); }
    const back = await call('POST', '/user/username', { username: 'tim' }, renamed.data.token);
    tok.tim = back.data.token;
  });

  test('lifting it: he is told, the marker goes, and he can write again', async () => {
    const told = once(sock.tim, 'server:timeout-lifted');
    const cleared = once(sock.mem, 'server:state', (s) => !s.members.some((m) => m.timeoutUntil));
    assert.equal((await lift('tim', 'adm')).status, 200);
    assert.deepEqual(await told, { serverId });
    await cleared;
    assert.equal((await lift('tim')).status, 404, 'already lifted');

    const raw = await connect(server.base, tok.tim);
    try {
      const { state } = await joinServer(raw, serverId);
      assert.equal(state.myTimeout, null);
      const heard = once(sock.mem, 'message', (m) => m.text === 'thank you');
      raw.emit('message', { serverId, channelId: generalId, text: 'thank you' });
      await heard;
      const peers = once(raw, 'voice:peers');
      raw.emit('voice:join', { serverId, channelId: voiceId });
      assert.ok(Array.isArray(await peers));
    } finally { raw.close(); }
  });

  test('it ends by itself when its time is up: nothing has to run', async () => {
    assert.equal((await place('tim', { minutes: 60 })).status, 200);
    const raw = await connect(server.base, tok.tim);
    try {
      await joinServer(raw, serverId);
      const refused = once(raw, 'message:error');
      raw.emit('message', { serverId, channelId: generalId, text: 'too early' });
      assert.equal((await refused).reason, 'timed-out');

      // The route takes whole minutes; to watch one run out, its end is moved to half a second
      // from now in the database. Nothing is told to the server: the next check simply finds it over.
      await dbAll(server.dataDir, "UPDATE server_timeouts SET until = ? WHERE server_id = ? AND username = 'tim'", [Date.now() + 500, serverId]);
      const stillRefused = once(raw, 'message:error');
      raw.emit('message', { serverId, channelId: generalId, text: 'still too early' });
      assert.equal((await stillRefused).reason, 'timed-out');

      await sleep(700);
      const heard = once(sock.mem, 'message', (m) => m.text === 'on time');
      raw.emit('message', { serverId, channelId: generalId, text: 'on time' });
      await heard;
      // The roster no longer marks him, and there is nothing left to lift.
      const { state } = await joinServer(raw, serverId);
      assert.equal(state.myTimeout, null);
      assert.ok(!state.members.some((m) => m.timeoutUntil));
      assert.equal((await lift('tim')).status, 404);
    } finally { raw.close(); }
  });

  test('a second timeout replaces the first, and both survive a restart', async () => {
    const first = (await place('tim', { minutes: 60, reason: 'one' })).data.timeout;
    const second = (await place('tim', { minutes: 5, reason: 'two' }, 'adm')).data.timeout;
    assert.ok(second.until < first.until, 'the latest decision stands, even when it is shorter');
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_timeouts'))[0].n, 1);

    for (const s of Object.values(sock)) s.close();
    await server.stop({ keepData: true });
    server = await startServer({ dataDir: server.dataDir });
    call = apiFor(server.base);
    const raw = await connect(server.base, tok.tim);
    sock.tim = raw;
    const { state } = await joinServer(raw, serverId);
    assert.deepEqual(state.myTimeout, { until: second.until, reason: 'two', by: 'adm' });
    const refused = once(raw, 'message:error');
    raw.emit('message', { serverId, channelId: generalId, text: 'after the restart' });
    assert.equal((await refused).reason, 'timed-out');
  });

  test('the routes are rate limited per account', async () => {
    // A fresh process (the restart above), so the owner's bucket is empty.
    for (let i = 0; i < MODERATION_WRITE_MAX; i++) {
      const res = await place('mem', { minutes: 1 });
      assert.equal(res.status, 200, `request ${i + 1} is inside the limit`);
    }
    const over = await place('mem', { minutes: 1 });
    assert.equal(over.status, 429);
    assert.ok(over.data.retryAfter > 0);
    assert.equal((await call('POST', `/servers/${serverId}/bans/mem`, {}, tok.own)).status, 429, 'bans share the same budget');
    assert.equal((await lift('mem', 'adm')).status, 200, 'another admin\'s budget is their own');
  });
});

describe('the audit log', () => {
  let server, call, serverId, elsewhereId, generalId;
  const tok = {};
  // A real 1x1 PNG: the icon route sniffs the leading bytes.
  const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  const log = async (token = tok.own, query = '') => call('GET', `/servers/${serverId}/audit${query}`, undefined, token);
  // The whole log, oldest first.
  const story = async () => (await log(tok.own, '?limit=100')).data.entries.reverse();
  const brief = (entries) => entries.map((e) => [e.action, e.actor, e.target]);

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'adm', 'm1', 'm2', 'joiner', 'out', 'elsewhere']) tok[name] = await makeUser(server.base, name);
    serverId = await makeServer(call, tok, { name: 'Ledger', owner: 'own', admins: ['adm'], members: ['m1', 'm2'] });
    elsewhereId = await makeServer(call, tok, { name: 'Elsewhere', owner: 'elsewhere' });
    generalId = (await call('GET', '/user/sync', undefined, tok.own)).data.servers[serverId].channels.find((c) => c.type === 'text').id;
  });
  after(async () => { await server.stop(); });

  test('setting the server up is already on record: invitations and the promotion', async () => {
    const entries = await story();
    assert.deepEqual(brief(entries), [
      ['member.invite', 'own', 'adm'],
      ['member.invite', 'own', 'm1'],
      ['member.invite', 'own', 'm2'],
      ['member.role', 'own', 'adm'],
    ]);
    assert.deepEqual(entries[3].detail, { from: 'member', to: 'admin' });
    assert.deepEqual(Object.keys(entries[0]).sort(), ['action', 'actor', 'detail', 'id', 'target', 'ts']);
    assert.ok(entries[0].ts <= Date.now() && entries[0].ts > Date.now() - 60_000);
  });

  test('every recorded action leaves one entry saying who did what to whom', async () => {
    const start = (await story()).length;
    const s = `/servers/${serverId}`;
    const ok = async (promise) => { const res = await promise; assert.ok(res.status === 200, JSON.stringify(res)); return res; };

    // Channels and their access lists.
    const channelId = (await ok(call('POST', `${s}/channels`, { name: 'plans', privacy: 'private', members: ['m1'] }, tok.adm))).data.channel.id;
    await ok(call('PATCH', `${s}/channels/${channelId}`, { name: 'schemes' }, tok.own));
    await ok(call('POST', `${s}/channels/${channelId}/members`, { username: 'm2' }, tok.own));
    await ok(call('DELETE', `${s}/channels/${channelId}/members/m2`, undefined, tok.adm));
    await ok(call('DELETE', `${s}/channels/${channelId}`, undefined, tok.own));
    // The server itself.
    await ok(call('PATCH', s, { name: 'Ledger II' }, tok.adm));
    const icon = new FormData();
    icon.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'icon.png');
    await ok(call('POST', `${s}/icon`, icon, tok.own));
    await ok(call('DELETE', `${s}/icon`, undefined, tok.own));
    // Invite links, and someone arriving through one.
    const invite = (await ok(call('POST', `${s}/invites`, { expiresInHours: 1, maxUses: 3 }, tok.adm))).data.invite;
    await ok(call('POST', `/invites/${invite.code}/accept`, undefined, tok.joiner));
    await ok(call('DELETE', `${s}/invites/${invite.code}`, undefined, tok.own));
    // Roles.
    await ok(call('PATCH', `${s}/members/m1`, { role: 'admin' }, tok.own));
    await ok(call('PATCH', `${s}/members/m1`, { role: 'member' }, tok.own));
    // Timeout, lifted.
    const timeout = (await ok(call('POST', `${s}/timeouts/m1`, { minutes: 5, reason: 'breathe' }, tok.adm))).data.timeout;
    await ok(call('DELETE', `${s}/timeouts/m1`, undefined, tok.own));
    // Kick, invite back, ban, unban.
    await ok(call('DELETE', `${s}/members/m2`, undefined, tok.adm));
    await ok(call('POST', `${s}/invite`, { username: 'm2' }, tok.own));
    await ok(call('POST', `${s}/bans/m2`, { reason: 'enough' }, tok.own));
    await ok(call('DELETE', `${s}/bans/m2`, undefined, tok.adm));
    // Someone leaving of their own accord, and a manual app-room reset.
    await ok(call('POST', `${s}/leave`, undefined, tok.joiner));
    await ok(call('POST', `${s}/app-rooms/reset`, undefined, tok.own));

    const entries = (await story()).slice(start);
    assert.deepEqual(brief(entries), [
      ['channel.create', 'adm', null],
      ['channel.rename', 'own', null],
      ['channel.access_grant', 'own', 'm2'],
      ['channel.access_remove', 'adm', 'm2'],
      ['channel.delete', 'own', null],
      ['server.rename', 'adm', null],
      ['server.icon', 'own', null],
      ['server.icon', 'own', null],
      ['invite.create', 'adm', null],
      ['member.join', 'joiner', null],
      ['invite.revoke', 'own', null],
      ['member.role', 'own', 'm1'],
      ['member.role', 'own', 'm1'],
      ['member.timeout', 'adm', 'm1'],
      ['member.timeout_lifted', 'own', 'm1'],
      ['member.kick', 'adm', 'm2'],
      ['member.invite', 'own', 'm2'],
      ['member.ban', 'own', 'm2'],
      ['member.unban', 'adm', 'm2'],
      ['member.leave', 'joiner', null],
      ['app_rooms.reset', 'own', null],
    ]);
    const detail = entries.map((e) => e.detail);
    assert.deepEqual(detail[0], { channelId, name: 'plans', type: 'text', privacy: 'private' });
    assert.deepEqual(detail[1], { channelId, from: 'plans', to: 'schemes' });
    assert.deepEqual(detail[2], { channelId, channel: 'schemes' });
    assert.deepEqual(detail[3], { channelId, channel: 'schemes' });
    assert.deepEqual(detail[4], { channelId, name: 'schemes', type: 'text' });
    assert.deepEqual(detail[5], { from: 'Ledger', to: 'Ledger II' });
    assert.deepEqual([detail[6], detail[7]], [{ change: 'set' }, { change: 'cleared' }]);
    assert.deepEqual(detail[8], { expiresAt: invite.expiresAt, maxUses: 3 });
    assert.deepEqual(detail[9], { via: 'link' });
    assert.deepEqual(detail[10], { createdBy: 'adm' });
    assert.deepEqual([detail[11], detail[12]], [{ from: 'member', to: 'admin' }, { from: 'admin', to: 'member' }]);
    assert.deepEqual(detail[13], { minutes: 5, until: timeout.until, reason: 'breathe' });
    assert.deepEqual(detail[17], { reason: 'enough', wasMember: true });
    // Newest first is how the route hands them out, and ids only ever go up.
    const ids = (await log(tok.own, '?limit=100')).data.entries.map((e) => e.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => b - a));

    // The link's code is a credential and is nowhere in the log.
    const raw = JSON.stringify(await dbAll(server.dataDir, 'SELECT * FROM server_audit'));
    assert.ok(!raw.includes(invite.code));
  });

  test('things that changed nothing are not recorded', async () => {
    const start = (await story()).length;
    const s = `/servers/${serverId}`;
    await call('PATCH', s, { name: 'Ledger II' }, tok.own); // the name it already has
    await call('PATCH', `${s}/members/m1`, { role: 'member' }, tok.own); // the role they already have
    await call('DELETE', `${s}/icon`, undefined, tok.own); // no icon to clear
    await call('DELETE', `${s}/channels/${generalId}/members/m1`, undefined, tok.own); // not on any list
    // And refusals: a member trying staff actions, an admin reaching upwards.
    await call('POST', `${s}/bans/adm`, {}, tok.m1);
    await call('POST', `${s}/timeouts/own`, { minutes: 5 }, tok.adm);
    await call('DELETE', `${s}/members/own`, undefined, tok.adm);
    await call('POST', `${s}/invite`, { username: 'nobody-at-all' }, tok.own);
    assert.equal((await story()).length, start);
  });

  test('what people say is never in it', async () => {
    const speaker = await connect(server.base, tok.m1);
    try {
      await joinServer(speaker, serverId);
      const echoed = once(speaker, 'message', (m) => m.text.includes('PINEAPPLE'));
      speaker.emit('message', { serverId, channelId: generalId, text: 'the password is PINEAPPLE-42' });
      const msg = await echoed;
      assert.equal((await ask(speaker, 'message:edit', { id: msg.id, text: 'the password is PINEAPPLE-43' })).ok, true);
      speaker.emit('message:delete', { id: msg.id });
      await sleep(150);
    } finally { speaker.close(); }
    const raw = JSON.stringify(await dbAll(server.dataDir, 'SELECT * FROM server_audit'));
    assert.ok(!raw.includes('PINEAPPLE'));
    // And a moderation reason is in the one entry it belongs to, nowhere else.
    assert.equal((raw.match(/breathe/g) || []).length, 1);
  });

  test('only staff of that server can read it', async () => {
    assert.equal((await log(tok.own)).status, 200);
    assert.equal((await log(tok.adm)).status, 200);
    for (const who of ['m1', 'm2', 'out', 'elsewhere']) {
      const res = await log(tok[who]);
      assert.equal(res.status, 403, who);
      assert.ok(!res.data.entries, `${who} is given no entries`);
    }
    assert.equal((await call('GET', `/servers/${serverId}/audit`)).status, 401);
    assert.equal((await call('GET', '/servers/srv-nope/audit', undefined, tok.own)).status, 404);
  });

  test('it is one server\'s log: nothing from another server is in it, or the other way round', async () => {
    assert.equal((await call('POST', `/servers/${elsewhereId}/channels`, { name: 'over-there' }, tok.elsewhere)).status, 200);
    const theirs = (await call('GET', `/servers/${elsewhereId}/audit`, undefined, tok.elsewhere)).data.entries;
    assert.deepEqual(brief(theirs), [['channel.create', 'elsewhere', null]]);
    assert.ok(!(await story()).some((e) => e.detail && e.detail.name === 'over-there'));
    // Being staff here does not open the log there.
    assert.equal((await call('GET', `/servers/${elsewhereId}/audit`, undefined, tok.own)).status, 403);
  });

  test('it is read a page at a time, newest first', async () => {
    const all = (await log(tok.own, '?limit=100')).data;
    assert.equal(all.hasMore, false);
    assert.ok(all.entries.length > 20);

    const first = (await log(tok.own, '?limit=7')).data;
    assert.equal(first.entries.length, 7);
    assert.equal(first.hasMore, true);
    assert.deepEqual(first.entries, all.entries.slice(0, 7));

    // Walk the whole log by cursor: every entry exactly once, in order, and an end that says so.
    const walked = [];
    let before = null;
    for (let page = 0; page < 50; page++) {
      const res = (await log(tok.own, `?limit=7${before ? `&before=${before}` : ''}`)).data;
      walked.push(...res.entries);
      if (!res.hasMore) break;
      before = res.entries[res.entries.length - 1].id;
    }
    assert.deepEqual(walked, all.entries);

    // Past the oldest entry there is nothing, and that is not an error.
    const oldest = all.entries[all.entries.length - 1].id;
    assert.deepEqual((await log(tok.own, `?before=${oldest}`)).data, { entries: [], hasMore: false });
    // The default page holds all of this log.
    assert.equal((await log(tok.own)).data.entries.length, all.entries.length);

    for (const bad of ['?before=abc', '?before=0', '?before=-3', '?before=1.5', '?limit=0', '?limit=-1', '?limit=ten', '?before=']) {
      assert.equal((await log(tok.own, bad)).status, 400, bad);
    }
  });

  test('a rename is carried through the log, as actor and as target', async () => {
    const renamed = await call('POST', '/user/username', { username: 'm1-renamed' }, tok.m1);
    assert.equal(renamed.status, 200);
    tok.m1 = renamed.data.token;
    const entries = await story();
    assert.ok(!entries.some((e) => e.actor === 'm1' || e.target === 'm1'));
    assert.ok(entries.some((e) => e.action === 'member.timeout' && e.target === 'm1-renamed'));
    const adm = await call('POST', '/user/username', { username: 'adm-renamed' }, tok.adm);
    tok.adm = adm.data.token;
    assert.ok((await story()).some((e) => e.action === 'member.kick' && e.actor === 'adm-renamed'));
  });
});
