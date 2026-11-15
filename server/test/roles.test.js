// Custom roles, role-based access to private channels, and channel categories
// (services/permissions.js, routes/roles.js, routes/categories.js, services/accessChanges.js).
//
// Most of this is about what must NOT be possible: using a route without the permission it
// names, acting on someone ranked at or above you, touching a role at or above your own, granting
// a permission you do not hold, opening a private channel a role no longer lets you into (through
// a socket that was already in it, too), and any of it reaching the public commons.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUserFromOwnAddress: makeUser, dbAll } = require('./helpers');
const { PERMISSIONS, MAX_ROLES } = require('../services/permissions');
const { MAX_CATEGORIES } = require('../services/channels');

const FAKE_WEB_PUSH = path.join(__dirname, 'fixtures', 'fakeWebPush.js');
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
const never = (socket, event, match = () => true, ms = 600) => once(socket, event, match, ms).then(() => false, () => true);

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

// Enter a server the way the client does, and hand back the state the server sent about it.
async function joinServer(socket, serverId) {
  const state = once(socket, 'server:state', (s) => s.server.id === serverId);
  const init = once(socket, 'messages:init', (m) => m.serverId === serverId);
  socket.emit('join', { serverId });
  await init;
  return state;
}
// Open a channel the way the client does. Resolves false when the server did not let it in.
async function openChannel(socket, serverId, channelId) {
  const joined = once(socket, 'channel:joined', (p) => p.channelId === channelId, 800).then(() => true, () => false);
  socket.emit('joinChannel', { serverId, channelId });
  return joined;
}

// A server with one owner, and the named admins and members added to it.
async function makeServer(call, tok, { name, owner, admins = [], members = [] }) {
  const id = (await call('POST', '/servers', { name }, tok[owner])).data.server.id;
  for (const who of [...admins, ...members]) {
    assert.equal((await call('POST', `/servers/${id}/invite`, { username: who }, tok[owner])).status, 200, `invite ${who}`);
  }
  for (const who of admins) {
    assert.equal((await call('PATCH', `/servers/${id}/members/${who}`, { role: 'admin' }, tok[owner])).status, 200);
  }
  return id;
}
async function makeRole(call, token, serverId, body) {
  const res = await call('POST', `/servers/${serverId}/roles`, body, token);
  assert.equal(res.status, 200, `create role ${body.name}: ${JSON.stringify(res.data)}`);
  return res.data.role.id;
}
async function giveRole(call, token, serverId, username, roleId) {
  const res = await call('PUT', `/servers/${serverId}/members/${username}/roles/${roleId}`, undefined, token);
  assert.equal(res.status, 200, `give ${username} a role: ${JSON.stringify(res.data)}`);
}
const rolesOf = async (call, token, serverId) => (await call('GET', `/servers/${serverId}/roles`, undefined, token)).data;
const epochOf = async (server, serverId) => (await dbAll(server.dataDir, 'SELECT app_room_epoch AS epoch FROM servers WHERE id = ?', [serverId]))[0].epoch;
const auditActions = async (server, serverId) => (await dbAll(server.dataDir, 'SELECT action FROM server_audit WHERE server_id = ? ORDER BY id', [serverId])).map((r) => r.action);

describe('the permission matrix: every gated route, for every kind of member', () => {
  let server, call, sid, generalId, spareChannelId, privateId, vaultId, categoryId, spareRoleId;
  const tok = {};
  const holderOf = (permission) => `p_${permission}`;
  const ACTORS = ['own', 'adm', ...PERMISSIONS.map(holderOf), 'none', 'out'];

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of [...ACTORS, 'target']) tok[name] = await makeUser(server.base, name);
    sid = await makeServer(call, tok, { name: 'Matrix', owner: 'own', admins: ['adm'], members: [...PERMISSIONS.map(holderOf), 'none', 'target'] });
    // One role per permission, carrying that permission and no other, held by one member each.
    for (const permission of PERMISSIONS) {
      const roleId = await makeRole(call, tok.own, sid, { name: permission, permissions: [permission] });
      await giveRole(call, tok.own, sid, holderOf(permission), roleId);
    }
    // Created last, so it sits below every role above: the one the role probes act on.
    spareRoleId = await makeRole(call, tok.own, sid, { name: 'spare', permissions: [] });
    const channel = (body) => call('POST', `/servers/${sid}/channels`, body, tok.own).then((r) => r.data.channel.id);
    spareChannelId = await channel({ name: 'spare' });
    privateId = await channel({ name: 'private', privacy: 'private' });
    vaultId = await channel({ name: 'vault', privacy: 'private' });
    categoryId = (await call('POST', `/servers/${sid}/categories`, { name: 'Shelf' }, tok.own)).data.category.id;
    generalId = (await dbAll(server.dataDir, "SELECT id FROM channels WHERE server_id = ? AND name = 'general'", [sid]))[0].id;
  });
  after(async () => { await server.stop(); });

  // Each probe: what it is, the permission it needs, the status someone who HAS the permission
  // gets, and the request. Destructive ones are aimed at things that are not there (a kick of
  // someone who is not a member answers 404 to a person allowed to kick, 403 to everyone else),
  // so the whole matrix can run against one server without taking it apart.
  const ownerMakes = {
    channel: () => call('POST', `/servers/${sid}/channels`, { name: 'temp' }, tok.own).then((r) => r.data.channel.id),
    category: () => call('POST', `/servers/${sid}/categories`, { name: 'temp' }, tok.own).then((r) => r.data.category.id),
    role: () => makeRole(call, tok.own, sid, { name: 'temp' }),
  };
  const PROBES = [
    ['rename the server', 'manage_server', 200, (t) => call('PATCH', `/servers/${sid}`, { name: 'Matrix' }, t)],
    ['set the icon (no file sent)', 'manage_server', 400, (t) => call('POST', `/servers/${sid}/icon`, undefined, t)],
    ['clear the icon', 'manage_server', 200, (t) => call('DELETE', `/servers/${sid}/icon`, undefined, t)],
    ['reset app rooms', 'manage_server', 200, (t) => call('POST', `/servers/${sid}/app-rooms/reset`, undefined, t)],

    ['create a channel', 'manage_channels', 200, (t) => call('POST', `/servers/${sid}/channels`, { name: 'made' }, t)],
    ['rename a channel', 'manage_channels', 200, (t) => call('PATCH', `/servers/${sid}/channels/${spareChannelId}`, { name: 'spare' }, t)],
    ['delete a channel', 'manage_channels', 200, async (t) => call('DELETE', `/servers/${sid}/channels/${await ownerMakes.channel()}`, undefined, t)],
    ['open a private channel they are not listed on', 'manage_channels', 200, (t) => call('GET', `/servers/${sid}/channels/${vaultId}/messages`, undefined, t)],
    ['read a private channel\'s access list', 'manage_channels', 200, (t) => call('GET', `/servers/${sid}/channels/${privateId}/members`, undefined, t)],
    ['add a member to a private channel', 'manage_channels', 200, (t) => call('POST', `/servers/${sid}/channels/${privateId}/members`, { username: 'target' }, t)],
    ['take a member off a private channel', 'manage_channels', 200, (t) => call('DELETE', `/servers/${sid}/channels/${privateId}/members/target`, undefined, t)],
    ['put a role on a private channel', 'manage_channels', 200, (t) => call('POST', `/servers/${sid}/channels/${privateId}/roles`, { roleId: spareRoleId }, t)],
    ['take a role off a private channel', 'manage_channels', 200, (t) => call('DELETE', `/servers/${sid}/channels/${privateId}/roles/${spareRoleId}`, undefined, t)],
    ['create a category', 'manage_channels', 200, (t) => call('POST', `/servers/${sid}/categories`, { name: 'made' }, t)],
    ['rename a category', 'manage_channels', 200, (t) => call('PATCH', `/servers/${sid}/categories/${categoryId}`, { name: 'Shelf' }, t)],
    ['move a category', 'manage_channels', 200, (t) => call('POST', `/servers/${sid}/categories/${categoryId}/move`, { direction: 'up' }, t)],
    ['delete a category', 'manage_channels', 200, async (t) => call('DELETE', `/servers/${sid}/categories/${await ownerMakes.category()}`, undefined, t)],
    ['file a channel under a category', 'manage_channels', 200, (t) => call('PUT', `/servers/${sid}/channels/${spareChannelId}/category`, { categoryId }, t)],
    ['move a channel', 'manage_channels', 200, (t) => call('POST', `/servers/${sid}/channels/${spareChannelId}/move`, { direction: 'up' }, t)],

    ['create a role', 'manage_roles', 200, (t) => call('POST', `/servers/${sid}/roles`, { name: 'made' }, t)],
    ['edit a role', 'manage_roles', 200, (t) => call('PATCH', `/servers/${sid}/roles/${spareRoleId}`, { color: '#3ba55c' }, t)],
    ['move a role', 'manage_roles', 200, (t) => call('POST', `/servers/${sid}/roles/${spareRoleId}/move`, { direction: 'down' }, t)],
    ['delete a role', 'manage_roles', 200, async (t) => call('DELETE', `/servers/${sid}/roles/${await ownerMakes.role()}`, undefined, t)],
    ['give a member a role', 'manage_roles', 200, (t) => call('PUT', `/servers/${sid}/members/none/roles/${spareRoleId}`, undefined, t)],
    ['take a role from a member', 'manage_roles', 200, (t) => call('DELETE', `/servers/${sid}/members/none/roles/${spareRoleId}`, undefined, t)],

    ['invite someone by name', 'invite', 404, (t) => call('POST', `/servers/${sid}/invite`, { username: 'nobody-by-this-name' }, t)],
    ['create an invite link', 'invite', 200, (t) => call('POST', `/servers/${sid}/invites`, {}, t)],
    ['list invite links', 'invite', 200, (t) => call('GET', `/servers/${sid}/invites`, undefined, t)],
    ['revoke an invite link', 'invite', 404, (t) => call('DELETE', `/servers/${sid}/invites/nosuchcode0000`, undefined, t)],

    ['kick', 'kick', 404, (t) => call('DELETE', `/servers/${sid}/members/nobody-by-this-name`, undefined, t)],
    ['time someone out', 'timeout', 404, (t) => call('POST', `/servers/${sid}/timeouts/nobody-by-this-name`, { minutes: 5 }, t)],
    ['lift a time out', 'timeout', 404, (t) => call('DELETE', `/servers/${sid}/timeouts/none`, undefined, t)],
    ['ban', 'ban', 404, (t) => call('POST', `/servers/${sid}/bans/nobody-by-this-name`, {}, t)],
    ['read the ban list', 'ban', 200, (t) => call('GET', `/servers/${sid}/bans`, undefined, t)],
    ['unban', 'ban', 404, (t) => call('DELETE', `/servers/${sid}/bans/nobody-by-this-name`, undefined, t)],
    ['read the audit log', 'view_audit_log', 200, (t) => call('GET', `/servers/${sid}/audit`, undefined, t)],
  ];

  test('every permission is exercised by at least one probe', () => {
    assert.deepEqual([...new Set(PROBES.map((p) => p[1]))].sort(), [...PERMISSIONS].sort());
  });

  for (const [what, needs, allowedStatus, run] of PROBES) {
    test(`${what}: the owner, an admin and a member with ${needs}; nobody else`, async () => {
      for (const actor of ACTORS) {
        const allowed = actor === 'own' || actor === 'adm' || actor === holderOf(needs);
        const res = await run(tok[actor]);
        assert.equal(res.status, allowed ? allowedStatus : 403, `${what} by ${actor}: ${JSON.stringify(res.data)}`);
      }
      assert.equal((await run(undefined)).status, 401, 'and nobody without a token');
    });
  }

  test('server:state tells each socket exactly the permissions it holds, and GET /servers the same', async () => {
    for (const actor of ACTORS.filter((a) => a !== 'out')) {
      const sock = await connect(server.base, tok[actor]);
      try {
        const state = await joinServer(sock, sid);
        const expected = actor === 'own' || actor === 'adm' ? [...PERMISSIONS] : actor === 'none' ? [] : [actor.slice(2)];
        assert.deepEqual([...state.myPermissions].sort(), [...expected].sort(), `${actor} over the socket`);
        const rail = (await call('GET', '/servers', undefined, tok[actor])).data.servers.find((s) => s.id === sid);
        assert.deepEqual([...rail.permissions].sort(), [...expected].sort(), `${actor} on the rail`);
        // What each role permits is only sent to someone who manages roles.
        const seesPermissions = actor === 'own' || actor === 'adm' || actor === holderOf('manage_roles');
        assert.equal(state.server.roles.every((r) => Array.isArray(r.permissions)), seesPermissions, `${actor}: role permissions in the state`);
        assert.ok(state.server.roles.length > PERMISSIONS.length, 'every member is sent the roles themselves');
      } finally { sock.close(); }
    }
  });

  test('someone who is not a member is refused the server, whatever they ask over a raw socket', async () => {
    const sock = await connect(server.base, tok.out);
    try {
      const denied = once(sock, 'server:denied');
      const noState = never(sock, 'server:state');
      sock.emit('join', { serverId: sid });
      assert.equal((await denied).serverId, sid);
      assert.ok(await noState);
    } finally { sock.close(); }
  });

  test('over raw sockets: only manage_channels (and staff) gets into a private channel nobody is listed on', async () => {
    for (const actor of ACTORS) {
      const allowed = actor === 'own' || actor === 'adm' || actor === holderOf('manage_channels');
      const sock = await connect(server.base, tok[actor]);
      try {
        if (actor !== 'out') {
          const state = await joinServer(sock, sid);
          assert.equal(state.server.channels.some((c) => c.id === vaultId), allowed, `${actor}: listed in the state`);
        }
        assert.equal(await openChannel(sock, sid, vaultId), allowed, `${actor}: joinChannel`);
        const refused = once(sock, 'message:error', (e) => e.channelId === vaultId, 800).then((e) => e.reason, () => null);
        const echoed = once(sock, 'message', (m) => m.channelId === vaultId && m.text === `from ${actor}`, 800).then(() => true, () => false);
        sock.emit('message', { serverId: sid, channelId: vaultId, text: `from ${actor}` });
        assert.equal(await echoed, allowed, `${actor}: message delivered`);
        assert.equal(await refused, allowed ? null : 'no-access', `${actor}: message refused`);
      } finally { sock.close(); }
    }
    const stored = (await dbAll(server.dataDir, 'SELECT author FROM messages WHERE channel_id = ? ORDER BY id', [vaultId])).map((r) => r.author);
    assert.deepEqual(stored, ['own', 'adm', holderOf('manage_channels')], 'only theirs were stored');
  });

  test('pinning is still open to every member who can see the channel, as it was before roles', async () => {
    // Deliberately not behind a permission: any member could pin before custom roles existed,
    // and a server that has made no roles must behave exactly as it did.
    const sock = await connect(server.base, tok.none);
    try {
      await joinServer(sock, sid);
      await openChannel(sock, sid, generalId);
      const echoed = once(sock, 'message', (m) => m.text === 'pin me');
      sock.emit('message', { serverId: sid, channelId: generalId, text: 'pin me' });
      const message = await echoed;
      const pinned = once(sock, 'pins:updated', (p) => p.pins.some((pin) => pin.id === message.id));
      sock.emit('message:pin', { id: message.id });
      await pinned;
    } finally { sock.close(); }
  });
});

describe('rank: who may act on whom, and on which roles', () => {
  let server, call, sid, high, mid, low;
  const tok = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'adm', 'adm2', 'hi', 'hi2', 'midd', 'loww', 'plain', 'plain2', 'out']) tok[name] = await makeUser(server.base, name);
    sid = await makeServer(call, tok, { name: 'Ranks', owner: 'own', admins: ['adm', 'adm2'], members: ['hi', 'hi2', 'midd', 'loww', 'plain', 'plain2'] });
    // Created highest first: a new role starts at the bottom.
    high = await makeRole(call, tok.own, sid, { name: 'High', color: '#e0574d', permissions: ['manage_roles', 'kick', 'timeout', 'ban', 'invite'] });
    mid = await makeRole(call, tok.own, sid, { name: 'Mid', color: '#3ba55c', permissions: ['kick', 'timeout'] });
    low = await makeRole(call, tok.own, sid, { name: 'Low', permissions: [] });
    await giveRole(call, tok.own, sid, 'hi', high);
    await giveRole(call, tok.own, sid, 'hi2', high);
    await giveRole(call, tok.own, sid, 'midd', mid);
    await giveRole(call, tok.own, sid, 'loww', low);
  });
  after(async () => { await server.stop(); });

  const memberNames = async () => (await call('GET', `/servers/${sid}/members`, undefined, tok.own)).data.members.map((m) => m.username).sort();
  const everyone = ['adm', 'adm2', 'hi', 'hi2', 'loww', 'midd', 'own', 'plain', 'plain2'];
  const roleRows = () => dbAll(server.dataDir, 'SELECT name, position, permissions, color FROM server_roles WHERE server_id = ? ORDER BY position DESC', [sid]);
  const heldBy = async (username) => (await dbAll(server.dataDir, 'SELECT r.name FROM server_member_roles mr JOIN server_roles r ON r.id = mr.role_id WHERE mr.server_id = ? AND mr.username = ? ORDER BY r.position DESC', [sid, username])).map((r) => r.name);

  test('roles are listed highest first, positions 1..n, for any member; never for an outsider', async () => {
    const seen = await rolesOf(call, tok.plain, sid);
    assert.deepEqual(seen.roles.map((r) => [r.name, r.position, r.members]), [['High', 3, ['hi', 'hi2']], ['Mid', 2, ['midd']], ['Low', 1, ['loww']]]);
    assert.ok(seen.roles.every((r) => r.permissions === undefined), 'a plain member is not told what each role permits');
    assert.deepEqual(seen.myPermissions, []);
    assert.deepEqual(seen.members.find((m) => m.username === 'hi'), { username: 'hi', role: 'member', roles: [high] });
    assert.deepEqual((await rolesOf(call, tok.hi, sid)).roles[0].permissions, ['manage_roles', 'invite', 'kick', 'timeout', 'ban']);
    assert.equal((await call('GET', `/servers/${sid}/roles`, undefined, tok.out)).status, 403);
    assert.equal((await call('GET', `/servers/${sid}/roles`)).status, 401);
    assert.equal((await call('GET', '/servers/srv-nope/roles', undefined, tok.own)).status, 404);
  });

  // Kick, ban, time out and lift: never upwards, never sideways, never yourself.
  const ACTIONS = {
    kick: (actor, target) => call('DELETE', `/servers/${sid}/members/${target}`, undefined, tok[actor]),
    ban: (actor, target) => call('POST', `/servers/${sid}/bans/${target}`, {}, tok[actor]),
    timeout: (actor, target) => call('POST', `/servers/${sid}/timeouts/${target}`, { minutes: 5 }, tok[actor]),
    lift: (actor, target) => call('DELETE', `/servers/${sid}/timeouts/${target}`, undefined, tok[actor]),
  };
  const REFUSED = [
    // actor, target, which actions, why
    ['hi', 'own', ['kick', 'ban', 'timeout', 'lift'], 'upwards: a role holder on the owner'],
    ['hi', 'adm', ['kick', 'ban', 'timeout', 'lift'], 'upwards: a role holder on an admin'],
    ['hi', 'hi2', ['kick', 'ban', 'timeout', 'lift'], 'sideways: the same highest role'],
    ['hi', 'hi', ['kick', 'ban', 'timeout', 'lift'], 'on themselves'],
    ['midd', 'hi', ['kick', 'timeout', 'lift'], 'upwards: a lower role on a higher one'],
    ['midd', 'midd', ['kick', 'timeout', 'lift'], 'a lower role holder on themselves'],
    ['midd', 'plain', ['ban'], 'a permission their role does not carry'],
    ['loww', 'plain', ['kick', 'ban', 'timeout', 'lift'], 'a role with no permissions'],
    ['plain', 'plain2', ['kick', 'ban', 'timeout', 'lift'], 'a member with no role'],
    ['adm', 'adm2', ['kick', 'ban', 'timeout', 'lift'], 'sideways: an admin on an admin (as before)'],
    ['adm', 'own', ['kick', 'ban', 'timeout', 'lift'], 'upwards: an admin on the owner (as before)'],
  ];
  for (const [actor, target, actions, why] of REFUSED) {
    test(`refused: ${why}`, async () => {
      for (const name of actions) {
        const res = await ACTIONS[name](actor, target);
        assert.ok(res.status === 403 || res.status === 400, `${name} by ${actor} on ${target}: ${res.status} ${JSON.stringify(res.data)}`);
      }
      assert.deepEqual(await memberNames(), everyone, 'nobody was removed');
      assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_bans'))[0].n, 0);
      assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_timeouts'))[0].n, 0);
    });
  }

  test('allowed: downwards only (time out, then lift)', async () => {
    for (const [actor, target] of [['hi', 'midd'], ['hi', 'loww'], ['hi', 'plain'], ['midd', 'loww'], ['midd', 'plain'], ['adm', 'hi'], ['own', 'adm']]) {
      assert.equal((await ACTIONS.timeout(actor, target)).status, 200, `${actor} times out ${target}`);
      assert.equal((await ACTIONS.lift(actor, target)).status, 200, `${actor} lifts it`);
    }
  });

  test('a role at or above your own cannot be edited, deleted, moved or handed out', async () => {
    const before = await roleRows();
    // hi's own highest role, by hi.
    for (const res of [
      await call('PATCH', `/servers/${sid}/roles/${high}`, { name: 'Higher' }, tok.hi),
      await call('PATCH', `/servers/${sid}/roles/${high}`, { permissions: ['manage_roles', 'kick'] }, tok.hi),
      await call('POST', `/servers/${sid}/roles/${high}/move`, { direction: 'down' }, tok.hi),
      await call('DELETE', `/servers/${sid}/roles/${high}`, undefined, tok.hi),
      await call('PUT', `/servers/${sid}/members/plain/roles/${high}`, undefined, tok.hi),
      await call('DELETE', `/servers/${sid}/members/hi2/roles/${high}`, undefined, tok.hi),
      // Moving the role below theirs UP would swap it with their own.
      await call('POST', `/servers/${sid}/roles/${mid}/move`, { direction: 'up' }, tok.hi),
    ]) assert.equal(res.status, 403, JSON.stringify(res.data));
    // A role holder without manage_roles, on a role below their own.
    for (const res of [
      await call('PATCH', `/servers/${sid}/roles/${low}`, { name: 'Lower' }, tok.midd),
      await call('DELETE', `/servers/${sid}/roles/${low}`, undefined, tok.midd),
      await call('PUT', `/servers/${sid}/members/plain/roles/${low}`, undefined, tok.midd),
      await call('POST', `/servers/${sid}/roles`, { name: 'Mine' }, tok.midd),
    ]) assert.equal(res.status, 403, JSON.stringify(res.data));
    assert.deepEqual(await roleRows(), before, 'no role changed');
    assert.deepEqual(await heldBy('plain'), []);
    assert.deepEqual(await heldBy('hi2'), ['High']);
  });

  test('nobody grants a permission they do not hold: not on a role, not by handing a role out', async () => {
    const before = await roleRows();
    // hi holds manage_roles, kick, timeout, ban, invite: not manage_server, manage_channels, view_audit_log.
    for (const missing of ['manage_server', 'manage_channels', 'view_audit_log']) {
      assert.equal((await call('POST', `/servers/${sid}/roles`, { name: 'Sneaky', permissions: [missing] }, tok.hi)).status, 403, `create with ${missing}`);
      assert.equal((await call('PATCH', `/servers/${sid}/roles/${mid}`, { permissions: ['kick', 'timeout', missing] }, tok.hi)).status, 403, `add ${missing}`);
    }
    assert.deepEqual(await roleRows(), before);
    // A role below hi's that carries something hi lacks: hi may not give it to anyone.
    const keys = await makeRole(call, tok.own, sid, { name: 'Keys', permissions: ['manage_server'] });
    assert.equal((await call('PUT', `/servers/${sid}/members/plain/roles/${keys}`, undefined, tok.hi)).status, 403);
    assert.deepEqual(await heldBy('plain'), []);
    // ...but may rename it, and may take the permission OFF it: only adding is granting.
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${keys}`, { name: 'Keyring' }, tok.hi)).status, 200);
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${keys}`, { permissions: [] }, tok.hi)).status, 200);
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${keys}`, { permissions: ['manage_server'] }, tok.hi)).status, 403, 'and cannot put it back');
    assert.equal((await call('DELETE', `/servers/${sid}/roles/${keys}`, undefined, tok.own)).status, 200);
    // What hi does hold, hi may grant, to a role below and to a member below.
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${low}`, { permissions: ['invite'] }, tok.hi)).status, 200);
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${low}`, { permissions: [] }, tok.hi)).status, 200);
  });

  test('roles are given to and taken from members ranked strictly below you', async () => {
    for (const [actor, target, status, why] of [
      ['hi', 'own', 403, 'the owner'],
      ['hi', 'adm', 403, 'an admin'],
      ['hi', 'hi2', 403, 'someone of the same rank'],
      ['hi', 'hi', 400, 'themselves'],
      ['adm', 'adm2', 403, 'an admin on another admin'],
      ['adm', 'adm', 400, 'an admin on themselves'],
      ['adm', 'own', 403, 'an admin on the owner'],
      ['hi', 'out', 404, 'someone who is not a member'],
    ]) {
      assert.equal((await call('PUT', `/servers/${sid}/members/${target}/roles/${low}`, undefined, tok[actor])).status, status, `${actor} gives a role to ${why}`);
      assert.equal((await call('DELETE', `/servers/${sid}/members/${target}/roles/${low}`, undefined, tok[actor])).status, status, `${actor} takes a role from ${why}`);
    }
    assert.deepEqual(await heldBy('adm'), []);
    assert.deepEqual(await heldBy('own'), []);
    // Downwards works, both ways, and is idempotent.
    assert.equal((await call('PUT', `/servers/${sid}/members/plain/roles/${low}`, undefined, tok.hi)).status, 200);
    assert.equal((await call('PUT', `/servers/${sid}/members/plain/roles/${low}`, undefined, tok.hi)).status, 200);
    assert.deepEqual(await heldBy('plain'), ['Low']);
    assert.equal((await call('DELETE', `/servers/${sid}/members/plain/roles/${low}`, undefined, tok.hi)).status, 200);
    assert.deepEqual(await heldBy('plain'), []);
    // The owner on themselves is the one exception: nobody else could give the owner a role.
    assert.equal((await call('PUT', `/servers/${sid}/members/own/roles/${low}`, undefined, tok.own)).status, 200);
    assert.deepEqual(await heldBy('own'), ['Low']);
    assert.equal((await call('DELETE', `/servers/${sid}/members/own/roles/${low}`, undefined, tok.own)).status, 200);
  });

  test('a custom role never makes or unmakes an owner or an admin', async () => {
    // Promotion stays the owner's alone, whatever a role permits.
    assert.equal((await call('PATCH', `/servers/${sid}/members/plain`, { role: 'admin' }, tok.hi)).status, 403);
    assert.equal((await call('PATCH', `/servers/${sid}/members/adm`, { role: 'member' }, tok.hi)).status, 403);
    assert.equal((await call('PATCH', `/servers/${sid}/members/plain`, { role: 'admin' }, tok.adm)).status, 403, 'not an admin either, as before');
    // An admin given a role and losing it again is an admin throughout, with every permission.
    const badge = await makeRole(call, tok.own, sid, { name: 'Badge', permissions: [] });
    await giveRole(call, tok.own, sid, 'adm', badge);
    assert.deepEqual((await rolesOf(call, tok.adm, sid)).myPermissions.sort(), [...PERMISSIONS].sort());
    assert.equal((await call('DELETE', `/servers/${sid}/roles/${badge}`, undefined, tok.own)).status, 200);
    const standing = Object.fromEntries((await dbAll(server.dataDir, 'SELECT username, role FROM server_members WHERE server_id = ?', [sid])).map((r) => [r.username, r.role]));
    assert.deepEqual([standing.own, standing.adm, standing.adm2, standing.hi, standing.plain], ['owner', 'admin', 'admin', 'member', 'member']);
    assert.deepEqual((await rolesOf(call, tok.adm, sid)).myPermissions.sort(), [...PERMISSIONS].sort());
    // A role holder is still someone an admin and the owner can act on, and cannot act back.
    assert.equal((await ACTIONS.timeout('hi', 'adm')).status, 403);
  });

  test('reordering changes rank: a role moved above another now outranks it', async () => {
    assert.equal((await ACTIONS.timeout('midd', 'loww')).status, 200);
    assert.equal((await ACTIONS.lift('midd', 'loww')).status, 200);
    assert.equal((await call('POST', `/servers/${sid}/roles/${low}/move`, { direction: 'up' }, tok.own)).status, 200);
    assert.deepEqual((await roleRows()).map((r) => [r.name, r.position]), [['High', 3], ['Low', 2], ['Mid', 1]]);
    assert.equal((await ACTIONS.timeout('midd', 'loww')).status, 403, 'loww now outranks midd');
    // Already at an end: answered, nothing moved.
    const top = await call('POST', `/servers/${sid}/roles/${high}/move`, { direction: 'up' }, tok.own);
    assert.deepEqual([top.status, top.data.moved], [200, false]);
    assert.equal((await call('POST', `/servers/${sid}/roles/${low}/move`, { direction: 'sideways' }, tok.own)).status, 400);
    assert.equal((await call('POST', `/servers/${sid}/roles/${low}/move`, { direction: 'down' }, tok.own)).status, 200);
    assert.deepEqual((await roleRows()).map((r) => [r.name, r.position]), [['High', 3], ['Mid', 2], ['Low', 1]]);
  });

  test('what a role may be: a name of 1 to 32 characters, a hex colour, known permissions', async () => {
    const create = (body) => call('POST', `/servers/${sid}/roles`, body, tok.own);
    for (const body of [
      {}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(33) }, { name: 42 },
      { name: 'ok', color: 'red' }, { name: 'ok', color: '#fff' }, { name: 'ok', color: '#12345g' }, { name: 'ok', color: 7 },
      { name: 'ok', permissions: 'kick' }, { name: 'ok', permissions: ['kick', 'fly'] }, { name: 'ok', permissions: [null] },
    ]) assert.equal((await create(body)).status, 400, JSON.stringify(body));
    const made = await create({ name: `  ${'y'.repeat(32)}  `, color: '#ABCDEF', permissions: ['ban', 'kick', 'kick'] });
    assert.equal(made.status, 200);
    assert.deepEqual([made.data.role.name, made.data.role.color, made.data.role.permissions, made.data.role.position], ['y'.repeat(32), '#abcdef', ['kick', 'ban'], 1]);
    const id = made.data.role.id;
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${id}`, {}, tok.own)).status, 400, 'nothing to change');
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${id}`, { name: '' }, tok.own)).status, 400);
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${id}`, { color: 'blue' }, tok.own)).status, 400);
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${id}`, { permissions: ['nope'] }, tok.own)).status, 400);
    const cleared = await call('PATCH', `/servers/${sid}/roles/${id}`, { color: null, name: 'Plainer' }, tok.own);
    assert.deepEqual([cleared.data.role.name, cleared.data.role.color, cleared.data.role.permissions], ['Plainer', null, ['kick', 'ban']], 'what is left out stays');
    assert.equal((await call('PATCH', `/servers/${sid}/roles/role-nope`, { name: 'x' }, tok.own)).status, 404);
    assert.equal((await call('DELETE', `/servers/${sid}/roles/${id}`, undefined, tok.own)).status, 200);
    assert.equal((await call('DELETE', `/servers/${sid}/roles/${id}`, undefined, tok.own)).status, 404);
  });

  test('a role of one server is nothing in another', async () => {
    const other = await makeServer(call, tok, { name: 'Elsewhere', owner: 'out', members: ['plain'] });
    // `out` owns Elsewhere and cannot use a role of Ranks there, nor reach into Ranks.
    assert.equal((await call('PUT', `/servers/${other}/members/plain/roles/${high}`, undefined, tok.out)).status, 404);
    assert.equal((await call('PATCH', `/servers/${other}/roles/${high}`, { name: 'x' }, tok.out)).status, 404);
    assert.equal((await call('PATCH', `/servers/${sid}/roles/${high}`, { name: 'x' }, tok.out)).status, 403);
    // hi's role in Ranks gives hi nothing in Elsewhere (hi is not even a member there).
    assert.equal((await call('POST', `/servers/${other}/roles`, { name: 'x' }, tok.hi)).status, 403);
    assert.equal((await call('POST', `/servers/${other}/invites`, {}, tok.hi)).status, 403);
    // A row planted for a role of the wrong server is ignored when permissions are worked out.
    const theirs = await makeRole(call, tok.out, other, { name: 'Theirs', permissions: ['kick'] });
    const sqlite3 = require('sqlite3');
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path.join(server.dataDir, 'data.sqlite'));
      db.run('INSERT INTO server_member_roles (server_id, username, role_id) VALUES (?, ?, ?)', [sid, 'plain', theirs], (err) => { db.close(); if (err) reject(err); else resolve(undefined); });
    });
    assert.deepEqual((await rolesOf(call, tok.plain, sid)).myPermissions, []);
    assert.equal((await ACTIONS.kick('plain', 'plain2')).status, 403);
  });

  test('at most 50 roles in a server', async () => {
    const fresh = await makeServer(call, tok, { name: 'Many', owner: 'adm2' });
    for (let i = 0; i < MAX_ROLES; i++) await makeRole(call, tok.adm2, fresh, { name: `r${i}` });
    const extra = await call('POST', `/servers/${fresh}/roles`, { name: 'one too many' }, tok.adm2);
    assert.equal(extra.status, 400);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_roles WHERE server_id = ?', [fresh]))[0].n, MAX_ROLES);
    const positions = (await dbAll(server.dataDir, 'SELECT position FROM server_roles WHERE server_id = ? ORDER BY position', [fresh])).map((r) => r.position);
    assert.deepEqual(positions, Array.from({ length: MAX_ROLES }, (_, i) => i + 1), 'positions stay 1..n with no ties');
  });

  test('every change is in the audit log, and reading it needs the permission', async () => {
    const actions = new Set(await auditActions(server, sid));
    for (const action of ['role.create', 'role.update', 'role.delete', 'role.move', 'member.role_add', 'member.role_remove']) {
      assert.ok(actions.has(action), `${action} was recorded`);
    }
    const [given] = await dbAll(server.dataDir, "SELECT actor, detail FROM server_audit WHERE server_id = ? AND action = 'member.role_add' AND target = 'plain' ORDER BY id LIMIT 1", [sid]);
    assert.deepEqual([given.actor, JSON.parse(given.detail)], ['hi', { roleId: low, role: 'Low' }]);
    assert.equal((await call('GET', `/servers/${sid}/audit`, undefined, tok.own)).status, 200);
    assert.equal((await call('GET', `/servers/${sid}/audit`, undefined, tok.hi)).status, 403, 'High does not carry view_audit_log');
  });
});

describe('a private channel that lists a role', () => {
  let server, call, sid, generalId, secretId, denId, crew;
  const tok = {};
  const socks = {};
  const pushSubscription = (where) => ({
    endpoint: `https://push.example.com/ok/${where}`,
    expirationTime: null,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)]).toString('base64url'),
      auth: crypto.randomBytes(16).toString('base64url'),
    },
  });
  const pushesSent = () => {
    const file = path.join(server.dataDir, 'push-sent.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };

  before(async () => {
    server = await startServer({ env: { WEB_PUSH_MODULE: FAKE_WEB_PUSH, PUSH_EXTRA_HOSTS: 'push.example.com' } });
    call = apiFor(server.base);
    for (const name of ['own', 'holder', 'other', 'named', 'chief', 'leaver']) tok[name] = await makeUser(server.base, name);
    sid = await makeServer(call, tok, { name: 'Crew', owner: 'own', members: ['holder', 'other', 'named', 'chief', 'leaver'] });
    crew = await makeRole(call, tok.own, sid, { name: 'Crew', color: '#29b6f6', permissions: [] });
    await giveRole(call, tok.own, sid, 'holder', crew);
    // Listed when the channel is made; a role id of nowhere is ignored rather than stored.
    const text = await call('POST', `/servers/${sid}/channels`, { name: 'secret', privacy: 'private', roles: [crew, 'role-nope'] }, tok.own);
    secretId = text.data.channel.id;
    const voice = await call('POST', `/servers/${sid}/channels`, { name: 'den', type: 'voice', privacy: 'private', roles: [crew] }, tok.own);
    denId = voice.data.channel.id;
    generalId = (await dbAll(server.dataDir, "SELECT id FROM channels WHERE server_id = ? AND name = 'general'", [sid]))[0].id;
    for (const name of ['own', 'holder', 'other']) socks[name] = await connect(server.base, tok[name]);
  });
  after(async () => {
    for (const s of Object.values(socks)) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  const accessList = async () => (await call('GET', `/servers/${sid}/channels/${secretId}/members`, undefined, tok.own)).data;
  const say = async (who, channelId, text) => {
    const echoed = once(socks[who], 'message', (m) => m.text === text && m.channelId === channelId);
    socks[who].emit('message', { serverId: sid, channelId, text });
    return echoed;
  };

  test('the list reads back with the role on it', async () => {
    assert.deepEqual(await accessList(), { members: [], roles: [crew] });
    const stored = await dbAll(server.dataDir, 'SELECT channel_id, role_id FROM channel_roles WHERE server_id = ?', [sid]);
    assert.deepEqual(stored.map((r) => r.channel_id).sort(), [secretId, denId].sort(), 'the unknown role id was not stored');
    assert.ok(stored.every((r) => r.role_id === crew));
  });

  test('putting a role on a list needs a real channel and a real role of this server', async () => {
    assert.equal((await call('POST', `/servers/${sid}/channels/ch-nope/roles`, { roleId: crew }, tok.own)).status, 404);
    assert.equal((await call('POST', `/servers/${sid}/channels/${secretId}/roles`, { roleId: 'role-nope' }, tok.own)).status, 404);
    assert.equal((await call('POST', `/servers/${sid}/channels/${secretId}/roles`, {}, tok.own)).status, 404);
    assert.equal((await call('POST', `/servers/${sid}/channels/${secretId}/roles`, { roleId: crew }, tok.holder)).status, 403, 'holding a listed role is not managing the list');
    assert.equal((await call('GET', `/servers/${sid}/channels/${secretId}/members`, undefined, tok.holder)).status, 403);
    assert.equal((await call('POST', `/servers/${sid}/channels/${secretId}/roles`, { roleId: crew }, tok.own)).status, 200, 'again: still once');
    assert.deepEqual((await accessList()).roles, [crew]);
  });

  test('visible to a holder and to staff in server:state; to nobody else', async () => {
    const seen = {};
    for (const name of ['own', 'holder', 'other']) {
      seen[name] = (await joinServer(socks[name], sid)).server.channels.map((c) => c.id);
    }
    for (const id of [secretId, denId]) {
      assert.ok(seen.own.includes(id));
      assert.ok(seen.holder.includes(id));
      assert.ok(!seen.other.includes(id));
    }
    // /user/sync is the other place a client learns its channels.
    const synced = async (who) => (await call('GET', '/user/sync', undefined, tok[who])).data.servers[sid].channels.map((c) => c.id);
    assert.ok((await synced('holder')).includes(secretId));
    assert.ok(!(await synced('other')).includes(secretId));
  });

  test('a holder can open it, post in it and read it; another member can do none of that', async () => {
    assert.equal(await openChannel(socks.own, sid, secretId), true);
    assert.equal(await openChannel(socks.holder, sid, secretId), true);
    assert.equal(await openChannel(socks.other, sid, secretId), false);

    const heard = once(socks.holder, 'message', (m) => m.text === 'the plan is zebra');
    const notHeard = never(socks.other, 'message', (m) => m.channelId === secretId);
    await say('own', secretId, 'the plan is zebra');
    await heard;
    assert.ok(await notHeard, 'the other member received nothing');
    await say('holder', secretId, 'zebra it is');

    const refused = once(socks.other, 'message:error', (e) => e.channelId === secretId);
    socks.other.emit('message', { serverId: sid, channelId: secretId, text: 'let me in' });
    assert.equal((await refused).reason, 'no-access');
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND author = 'other'", [secretId]))[0].n, 0);

    const history = (who) => call('GET', `/servers/${sid}/channels/${secretId}/messages`, undefined, tok[who]);
    assert.deepEqual((await history('holder')).data.messages.map((m) => m.text), ['the plan is zebra', 'zebra it is']);
    assert.equal((await history('other')).status, 403);
  });

  test('searchable by a holder, in every scope; by nobody else', async () => {
    const search = (who, query) => call('GET', `/search?q=zebra&${query}`, undefined, tok[who]);
    const texts = (res) => res.data.results.map((r) => r.message.text).sort();
    const both = ['the plan is zebra', 'zebra it is'];
    assert.deepEqual(texts(await search('holder', `scope=channel&serverId=${sid}&channelId=${secretId}`)), both);
    assert.deepEqual(texts(await search('holder', `scope=server&serverId=${sid}`)), both);
    assert.deepEqual(texts(await search('holder', 'scope=all')), both);
    assert.equal((await search('other', `scope=channel&serverId=${sid}&channelId=${secretId}`)).status, 403);
    assert.deepEqual(texts(await search('other', `scope=server&serverId=${sid}`)), []);
    assert.deepEqual(texts(await search('other', 'scope=all')), []);
  });

  test('unread counts and the live nudge reach a holder, and never the other member', async () => {
    const bumped = once(socks.holder, 'unread:bump', (p) => p.channelId === secretId);
    const notBumped = never(socks.other, 'unread:bump', (p) => p.channelId === secretId);
    await say('own', secretId, 'one more');
    await bumped;
    assert.ok(await notBumped);
    const unreads = async (who) => (await call('GET', '/unreads', undefined, tok[who])).data.unreads[sid] || {};
    assert.ok((await unreads('holder'))[secretId] >= 1);
    assert.equal((await unreads('other'))[secretId], undefined);
  });

  test('a mention pushes a holder, and never someone who cannot open the channel', async () => {
    for (const who of ['holder', 'other']) {
      assert.equal((await call('POST', '/push/subscribe', pushSubscription(who), tok[who])).status, 200);
    }
    await say('own', secretId, '@holder @other the plan is on');
    // Sends are fire-and-forget; a mention in a channel both can open goes through the same
    // pipeline afterwards, and once THAT push to `other` shows up the first has been dealt with.
    await openChannel(socks.own, sid, generalId);
    await say('own', generalId, '@other canary');
    const deadline = Date.now() + 5000;
    while (!pushesSent().some((p) => p.payload.body.includes('canary'))) {
      assert.ok(Date.now() < deadline, 'the canary push never arrived');
      await sleep(20);
    }
    await sleep(40);
    const about = pushesSent().filter((p) => p.payload.body.includes('the plan is on')).map((p) => p.endpoint.split('/').pop());
    assert.deepEqual(about, ['holder']);
    await openChannel(socks.own, sid, secretId);
  });

  test('joinable as voice by a holder; refused at the door for anyone else', async () => {
    const roster = once(socks.holder, 'voice:peers');
    socks.holder.emit('voice:join', { serverId: sid, channelId: denId });
    await roster;
    const door = once(socks.other, 'voice:removed');
    const noRoster = never(socks.other, 'voice:peers');
    socks.other.emit('voice:join', { serverId: sid, channelId: denId });
    assert.deepEqual(await door, { serverId: sid, channelId: denId });
    assert.ok(await noRoster);
  });

  test('gaining the role opens the channel and replaces no app room keys', async () => {
    const before = await epochOf(server, sid);
    const state = once(socks.other, 'server:state', (s) => s.server.channels.some((c) => c.id === secretId));
    await giveRole(call, tok.own, sid, 'other', crew);
    await state; // a fresh state, without asking
    assert.equal(await openChannel(socks.other, sid, secretId), true);
    assert.equal(await epochOf(server, sid), before, 'a gain rotates nothing');
    // Putting the role on a list (again), and adding a name, are gains too.
    assert.equal((await call('POST', `/servers/${sid}/channels/${secretId}/roles`, { roleId: crew }, tok.own)).status, 200);
    for (const id of [secretId, denId]) {
      assert.equal((await call('POST', `/servers/${sid}/channels/${id}/members`, { username: 'named' }, tok.own)).status, 200);
    }
    await giveRole(call, tok.own, sid, 'named', crew);
    assert.equal(await epochOf(server, sid), before);
  });

  test('losing the role closes it at once: the state, the open text room, the voice room, and new room keys', async () => {
    const before = await epochOf(server, sid);
    // holder has #secret open and is sitting in the den's voice room (from the tests above).
    const hungUp = once(socks.holder, 'voice:removed');
    const state = once(socks.holder, 'server:state', (s) => !s.server.channels.some((c) => c.id === secretId));
    const res = await call('DELETE', `/servers/${sid}/members/holder/roles/${crew}`, undefined, tok.own);
    assert.equal(res.status, 200);
    assert.deepEqual(await hungUp, { serverId: sid, channelId: denId });
    const lost = await state;
    assert.ok(!lost.server.channels.some((c) => c.id === denId));
    assert.deepEqual(lost.members.find((m) => m.username === 'holder').roles, []);
    assert.equal(await epochOf(server, sid), before + 1, 'the room keys were replaced, once');

    // The socket that had the channel open no longer hears it, and cannot write to it or reopen it.
    const silence = never(socks.holder, 'message', (m) => m.channelId === secretId);
    await say('own', secretId, 'after holder lost the role');
    assert.ok(await silence);
    const refused = once(socks.holder, 'message:error', (e) => e.channelId === secretId);
    socks.holder.emit('message', { serverId: sid, channelId: secretId, text: 'still here?' });
    assert.equal((await refused).reason, 'no-access');
    assert.equal(await openChannel(socks.holder, sid, secretId), false);
    const door = once(socks.holder, 'voice:removed');
    socks.holder.emit('voice:join', { serverId: sid, channelId: denId });
    await door;
    assert.equal((await call('GET', `/servers/${sid}/channels/${secretId}/messages`, undefined, tok.holder)).status, 403);
    assert.deepEqual((await call('GET', `/search?q=zebra&scope=server&serverId=${sid}`, undefined, tok.holder)).data.results, []);

    // Taking the role from someone who is ALSO listed by name, on every channel the role opens,
    // takes nothing away: no rotation.
    assert.equal((await call('DELETE', `/servers/${sid}/members/named/roles/${crew}`, undefined, tok.own)).status, 200);
    assert.equal(await epochOf(server, sid), before + 1);
    assert.equal((await call('GET', `/servers/${sid}/channels/${secretId}/messages`, undefined, tok.named)).status, 200);
  });

  test('taking the role off the channel closes it for every holder who has no other way in', async () => {
    await giveRole(call, tok.own, sid, 'holder', crew);
    await giveRole(call, tok.own, sid, 'named', crew);
    assert.equal(await openChannel(socks.holder, sid, secretId), true);
    assert.equal(await openChannel(socks.other, sid, secretId), true); // `other` still holds the role
    const before = await epochOf(server, sid);
    const gone = Promise.all(['holder', 'other'].map((who) => once(socks[who], 'server:state', (s) => !s.server.channels.some((c) => c.id === secretId))));
    assert.equal((await call('DELETE', `/servers/${sid}/channels/${secretId}/roles/${crew}`, undefined, tok.own)).status, 200);
    await gone;
    assert.equal(await epochOf(server, sid), before + 1, 'once, however many people lost it');
    const silence = Promise.all(['holder', 'other'].map((who) => never(socks[who], 'message', (m) => m.channelId === secretId)));
    await say('own', secretId, 'role taken off the list');
    assert.ok((await silence).every(Boolean));
    assert.equal((await call('GET', `/servers/${sid}/channels/${secretId}/messages`, undefined, tok.holder)).status, 403);
    assert.equal((await call('GET', `/servers/${sid}/channels/${secretId}/messages`, undefined, tok.named)).status, 200, 'listed by name: untouched');
    // The den still lists the role, so they keep that.
    assert.equal((await call('GET', `/servers/${sid}/channels/${denId}/messages`, undefined, tok.holder)).status, 200);
    // Taking it off again changes nothing and rotates nothing.
    assert.equal((await call('DELETE', `/servers/${sid}/channels/${secretId}/roles/${crew}`, undefined, tok.own)).status, 200);
    assert.equal(await epochOf(server, sid), before + 1);
  });

  test('deleting the role closes what it opened, and clears every trace of it', async () => {
    assert.equal((await call('POST', `/servers/${sid}/channels/${secretId}/roles`, { roleId: crew }, tok.own)).status, 200);
    assert.equal(await openChannel(socks.holder, sid, secretId), true);
    const roster = once(socks.holder, 'voice:peers');
    socks.holder.emit('voice:join', { serverId: sid, channelId: denId });
    await roster;
    const before = await epochOf(server, sid);
    const hungUp = once(socks.holder, 'voice:removed');
    assert.equal((await call('DELETE', `/servers/${sid}/roles/${crew}`, undefined, tok.own)).status, 200);
    await hungUp;
    assert.equal(await epochOf(server, sid), before + 1);
    for (const table of ['server_roles', 'server_member_roles', 'channel_roles']) {
      assert.equal((await dbAll(server.dataDir, `SELECT COUNT(*) AS n FROM ${table} WHERE server_id = ?`, [sid]))[0].n, 0, table);
    }
    assert.equal(await openChannel(socks.holder, sid, secretId), false);
    assert.deepEqual(await accessList(), { members: ['named'], roles: [] });
  });

  test('a role that manages channels opens every private channel, and losing that permission closes them', async () => {
    const keeper = await makeRole(call, tok.own, sid, { name: 'Keeper', permissions: ['manage_channels', 'invite'] });
    await giveRole(call, tok.own, sid, 'chief', keeper);
    const chief = await connect(server.base, tok.chief);
    try {
      const state = await joinServer(chief, sid);
      assert.ok(state.server.channels.some((c) => c.id === secretId));
      assert.equal(await openChannel(chief, sid, secretId), true);
      // chief minted an invite link while they could.
      const link = (await call('POST', `/servers/${sid}/invites`, {}, tok.chief)).data.invite.code;
      assert.equal((await call('GET', `/invites/${link}`)).status, 200);

      const before = await epochOf(server, sid);
      const closed = once(chief, 'server:state', (s) => !s.server.channels.some((c) => c.id === secretId));
      assert.equal((await call('PATCH', `/servers/${sid}/roles/${keeper}`, { permissions: ['invite'] }, tok.own)).status, 200);
      assert.deepEqual((await closed).myPermissions, ['invite']);
      assert.equal(await epochOf(server, sid), before + 1);
      const silence = never(chief, 'message', (m) => m.channelId === secretId);
      await say('own', secretId, 'keeper lost manage_channels');
      assert.ok(await silence);
      assert.equal((await call('GET', `/invites/${link}`)).status, 200, 'they can still invite, so the link lives');

      // Losing the invite permission revokes the links they minted, as a demotion does. No
      // channel is lost by it, so no room keys are replaced.
      assert.equal((await call('PATCH', `/servers/${sid}/roles/${keeper}`, { permissions: [] }, tok.own)).status, 200);
      assert.equal((await call('GET', `/invites/${link}`)).status, 404);
      assert.equal(await epochOf(server, sid), before + 1);
      // Renaming or recolouring a role takes nothing from anyone.
      assert.equal((await call('PATCH', `/servers/${sid}/roles/${keeper}`, { name: 'Keeper 2', color: '#faa61a' }, tok.own)).status, 200);
      assert.equal(await epochOf(server, sid), before + 1);
    } finally { chief.close(); }
  });

  test('a kick takes the roles with it; a rename carries them; a deleted account leaves none behind', async () => {
    const pass = await makeRole(call, tok.own, sid, { name: 'Pass', permissions: ['kick'] });
    assert.equal((await call('POST', `/servers/${sid}/channels/${secretId}/roles`, { roleId: pass }, tok.own)).status, 200);
    const held = async (username) => (await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM server_member_roles WHERE server_id = ? AND username = ?', [sid, username]))[0].n;

    // Kicked, then invited back: a plain member again.
    await giveRole(call, tok.own, sid, 'leaver', pass);
    assert.equal((await call('DELETE', `/servers/${sid}/members/leaver`, undefined, tok.own)).status, 200);
    assert.equal(await held('leaver'), 0);
    assert.equal((await call('POST', `/servers/${sid}/invite`, { username: 'leaver' }, tok.own)).status, 200);
    assert.deepEqual((await rolesOf(call, tok.leaver, sid)).myPermissions, []);
    assert.equal((await call('GET', `/servers/${sid}/channels/${secretId}/messages`, undefined, tok.leaver)).status, 403);
    // Leaving does the same.
    await giveRole(call, tok.own, sid, 'leaver', pass);
    assert.equal((await call('POST', `/servers/${sid}/leave`, undefined, tok.leaver)).status, 200);
    assert.equal(await held('leaver'), 0);

    // Renamed: the role, what it permits and the channel it opens all follow.
    await giveRole(call, tok.own, sid, 'other', pass);
    const renamed = await call('POST', '/user/username', { username: 'other2' }, tok.other);
    assert.equal(renamed.status, 200);
    assert.equal(await held('other'), 0);
    assert.equal(await held('other2'), 1);
    assert.deepEqual((await rolesOf(call, renamed.data.token, sid)).myPermissions, ['kick']);
    assert.equal((await call('GET', `/servers/${sid}/channels/${secretId}/messages`, undefined, renamed.data.token)).status, 200);

    // Deleted: nothing is left for whoever takes the name next.
    assert.equal((await call('POST', '/account/deactivate', {}, renamed.data.token)).status, 200);
    const [pending] = await dbAll(server.dataDir, "SELECT token FROM auth_tokens WHERE purpose = 'deactivate' ORDER BY rowid DESC LIMIT 1");
    assert.equal((await call('POST', '/account/deactivate/confirm', { token: pending.token })).status, 200);
    assert.equal(await held('other2'), 0);
  });

  test('deleting the server leaves no role, list or category of it behind', async () => {
    await call('POST', `/servers/${sid}/categories`, { name: 'Shelf' }, tok.own);
    assert.equal((await call('DELETE', `/servers/${sid}`, undefined, tok.own)).status, 200);
    for (const table of ['server_roles', 'server_member_roles', 'channel_roles', 'channel_categories']) {
      assert.equal((await dbAll(server.dataDir, `SELECT COUNT(*) AS n FROM ${table} WHERE server_id = ?`, [sid]))[0].n, 0, table);
    }
  });
});

describe('channel categories and order', () => {
  let server, call, sid, generalId, voiceId;
  const tok = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'mem', 'listed', 'out']) tok[name] = await makeUser(server.base, name);
    sid = await makeServer(call, tok, { name: 'Shelves', owner: 'own', members: ['mem', 'listed'] });
    const rows = await dbAll(server.dataDir, 'SELECT id, type FROM channels WHERE server_id = ? ORDER BY rowid', [sid]);
    generalId = rows.find((r) => r.type === 'text').id;
    voiceId = rows.find((r) => r.type === 'voice').id;
  });
  after(async () => { await server.stop(); });

  const stateFor = async (who) => {
    const sock = await connect(server.base, tok[who]);
    try { return await joinServer(sock, sid); } finally { sock.close(); }
  };
  const layout = (state) => ({
    categories: state.server.categories.map((c) => c.name),
    channels: state.server.channels.map((c) => [c.name, state.server.categories.find((cat) => cat.id === c.categoryId)?.name || null]),
  });
  const channel = async (body) => (await call('POST', `/servers/${sid}/channels`, body, tok.own)).data.channel.id;
  const category = async (name) => (await call('POST', `/servers/${sid}/categories`, { name }, tok.own)).data.category.id;
  const move = (kind, id, direction) => call('POST', `/servers/${sid}/${kind}/${id}/move`, { direction }, tok.own);
  const file = (channelId, categoryId, token = tok.own) => call('PUT', `/servers/${sid}/channels/${channelId}/category`, { categoryId }, token);

  test('a server nobody has arranged: no categories, no roles, channels in the order they were made', async () => {
    const state = await stateFor('mem');
    assert.deepEqual(layout(state), { categories: [], channels: [['general', null], ['Voice 1', null]] });
    assert.deepEqual(state.server.roles, []);
    assert.deepEqual(state.myPermissions, []);
    assert.equal(state.myRole, 'member');
    assert.deepEqual([...(await stateFor('own')).myPermissions].sort(), [...PERMISSIONS].sort());
    assert.ok(state.members.every((m) => Array.isArray(m.roles) && m.roles.length === 0));
  });

  test('categories are made, renamed, reordered and deleted by someone who manages channels', async () => {
    const games = await category('Games');
    const chat = await category('  Chat  ');
    assert.deepEqual(layout(await stateFor('own')).categories, ['Games', 'Chat'], 'a new one goes last, trimmed');
    assert.equal((await call('PATCH', `/servers/${sid}/categories/${chat}`, { name: 'Talk' }, tok.own)).status, 200);
    assert.deepEqual((await move('categories', chat, 'up')).data, { success: true, moved: true });
    assert.deepEqual(layout(await stateFor('own')).categories, ['Talk', 'Games']);
    assert.deepEqual((await move('categories', chat, 'up')).data, { success: true, moved: false }, 'already first');
    assert.equal((await move('categories', chat, 'left')).status, 400);
    assert.equal((await move('categories', 'cat-nope', 'up')).status, 404);
    for (const name of [undefined, '', '   ', 'x'.repeat(33), 5]) {
      assert.equal((await call('POST', `/servers/${sid}/categories`, { name }, tok.own)).status, 400, String(name));
      assert.equal((await call('PATCH', `/servers/${sid}/categories/${games}`, { name }, tok.own)).status, 400, String(name));
    }
    assert.equal((await call('PATCH', `/servers/${sid}/categories/cat-nope`, { name: 'x' }, tok.own)).status, 404);
    for (const who of ['mem', 'out']) {
      assert.equal((await call('POST', `/servers/${sid}/categories`, { name: 'Mine' }, tok[who])).status, 403);
      assert.equal((await call('DELETE', `/servers/${sid}/categories/${games}`, undefined, tok[who])).status, 403);
      assert.equal((await file(generalId, games, tok[who])).status, 403);
    }
  });

  test('a member is only shown a category that holds a channel they can see', async () => {
    const [talk, games] = (await stateFor('own')).server.categories.map((c) => c.id);
    assert.deepEqual(layout(await stateFor('mem')).categories, [], 'both are empty: someone who manages channels sees them, a member does not');
    assert.equal((await file(generalId, talk)).status, 200);
    assert.deepEqual(layout(await stateFor('mem')), { categories: ['Talk'], channels: [['general', 'Talk'], ['Voice 1', null]] });

    // A private channel in a category keeps its own list: the category opens nothing.
    const officers = await channel({ name: 'officers', privacy: 'private', members: ['listed'], categoryId: games });
    assert.deepEqual(layout(await stateFor('mem')), { categories: ['Talk'], channels: [['general', 'Talk'], ['Voice 1', null]] }, 'neither the channel nor its category');
    assert.deepEqual(layout(await stateFor('listed')).categories, ['Talk', 'Games']);
    assert.equal((await call('GET', `/servers/${sid}/channels/${officers}/messages`, undefined, tok.mem)).status, 403);
    assert.equal((await call('GET', `/servers/${sid}/channels/${officers}/messages`, undefined, tok.listed)).status, 200);
    // Filing a public channel next to it shows the category, and still not the private channel.
    assert.equal((await file(voiceId, games)).status, 200);
    assert.deepEqual(layout(await stateFor('mem')), { categories: ['Talk', 'Games'], channels: [['general', 'Talk'], ['Voice 1', 'Games']] });
    assert.equal((await call('GET', `/servers/${sid}/channels/${officers}/messages`, undefined, tok.mem)).status, 403);
  });

  test('channels move up and down within their list, and between categories', async () => {
    const [talk] = (await stateFor('own')).server.categories.map((c) => c.id);
    const a = await channel({ name: 'alpha', categoryId: talk });
    const b = await channel({ name: 'beta', categoryId: talk });
    const inTalk = async () => layout(await stateFor('own')).channels.filter(([, cat]) => cat === 'Talk').map(([name]) => name);
    assert.deepEqual(await inTalk(), ['general', 'alpha', 'beta']);
    assert.deepEqual((await move('channels', b, 'up')).data, { success: true, moved: true });
    assert.deepEqual(await inTalk(), ['general', 'beta', 'alpha']);
    assert.deepEqual((await move('channels', b, 'up')).data, { success: true, moved: true });
    assert.deepEqual((await move('channels', b, 'up')).data, { success: true, moved: false }, 'already first');
    assert.deepEqual(await inTalk(), ['beta', 'general', 'alpha']);
    assert.deepEqual((await move('channels', b, 'down')).data, { success: true, moved: true });
    assert.deepEqual(await inTalk(), ['general', 'beta', 'alpha']);
    assert.equal((await move('channels', 'ch-nope', 'up')).status, 404);
    assert.equal((await move('channels', a, 'around')).status, 400);

    // Out of the category: back among the uncategorised channels of its type, at the end.
    assert.equal((await file(a, null)).status, 200);
    assert.deepEqual(await inTalk(), ['general', 'beta']);
    assert.deepEqual(layout(await stateFor('own')).channels.filter(([, cat]) => cat === null), [['alpha', null]]);
    assert.equal((await file(a, 'cat-nope')).status, 404);
    assert.equal((await file(a, 7)).status, 400);
    assert.equal((await file('ch-nope', talk)).status, 404);
  });

  test('a category of another server is not one of this server\'s', async () => {
    const other = await makeServer(call, tok, { name: 'Elsewhere', owner: 'out' });
    const theirs = (await call('POST', `/servers/${other}/categories`, { name: 'Theirs' }, tok.out)).data.category.id;
    assert.equal((await file(generalId, theirs)).status, 404);
    assert.equal((await call('PATCH', `/servers/${sid}/categories/${theirs}`, { name: 'x' }, tok.own)).status, 404);
    assert.equal((await call('DELETE', `/servers/${sid}/categories/${theirs}`, undefined, tok.own)).status, 404);
    // Named when a channel is made: the channel is made, in no category.
    const made = await call('POST', `/servers/${sid}/channels`, { name: 'stray', categoryId: theirs }, tok.own);
    assert.deepEqual([made.status, made.data.channel.categoryId], [200, null]);
  });

  test('deleting a category never deletes its channels, their messages or their lists', async () => {
    const state = await stateFor('own');
    const games = state.server.categories.find((c) => c.name === 'Games').id;
    const inGames = state.server.channels.filter((c) => c.categoryId === games).map((c) => c.id);
    assert.equal(inGames.length, 2);
    const officers = state.server.channels.find((c) => c.name === 'officers').id;
    const channelsBefore = (await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', [sid]))[0].n;
    const epoch = await epochOf(server, sid);
    assert.equal((await call('DELETE', `/servers/${sid}/categories/${games}`, undefined, tok.own)).status, 200);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM channels WHERE server_id = ?', [sid]))[0].n, channelsBefore);
    const after = await stateFor('own');
    assert.ok(!after.server.categories.some((c) => c.id === games));
    for (const id of inGames) assert.equal(after.server.channels.find((c) => c.id === id).categoryId, null);
    assert.deepEqual((await call('GET', `/servers/${sid}/channels/${officers}/members`, undefined, tok.own)).data.members, ['listed'], 'still private, same list');
    assert.equal((await call('GET', `/servers/${sid}/channels/${officers}/messages`, undefined, tok.mem)).status, 403);
    assert.equal(await epochOf(server, sid), epoch, 'arranging channels never replaces room keys');
    assert.equal((await call('DELETE', `/servers/${sid}/categories/${games}`, undefined, tok.own)).status, 404);
  });

  test('at most 30 categories, and every change is in the audit log', async () => {
    const have = (await stateFor('own')).server.categories.length;
    for (let i = have; i < MAX_CATEGORIES; i++) await category(`c${i}`);
    assert.equal((await call('POST', `/servers/${sid}/categories`, { name: 'one too many' }, tok.own)).status, 400);
    const actions = new Set(await auditActions(server, sid));
    for (const action of ['category.create', 'category.rename', 'category.move', 'category.delete', 'channel.move', 'channel.category']) {
      assert.ok(actions.has(action), `${action} was recorded`);
    }
  });
});

describe('the public commons takes none of it', () => {
  let server, call, token;
  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    token = await makeUser(server.base, 'anyone');
  });
  after(async () => { await server.stop(); });

  test('no roles, no role assignments, no roles on channels, no categories, no reordering', async () => {
    for (const [method, route, body] of [
      ['GET', '/servers/demo/roles'],
      ['POST', '/servers/demo/roles', { name: 'Boss', permissions: [...PERMISSIONS] }],
      ['PATCH', '/servers/demo/roles/role-x', { name: 'Boss' }],
      ['POST', '/servers/demo/roles/role-x/move', { direction: 'up' }],
      ['DELETE', '/servers/demo/roles/role-x'],
      ['PUT', '/servers/demo/members/anyone/roles/role-x'],
      ['DELETE', '/servers/demo/members/anyone/roles/role-x'],
      ['POST', '/servers/demo/channels/general/roles', { roleId: 'role-x' }],
      ['DELETE', '/servers/demo/channels/general/roles/role-x'],
      ['POST', '/servers/demo/categories', { name: 'Mine' }],
      ['PATCH', '/servers/demo/categories/cat-x', { name: 'Mine' }],
      ['POST', '/servers/demo/categories/cat-x/move', { direction: 'up' }],
      ['DELETE', '/servers/demo/categories/cat-x'],
      ['PUT', '/servers/demo/channels/general/category', { categoryId: null }],
      ['POST', '/servers/demo/channels/general/move', { direction: 'down' }],
    ]) {
      const res = await call(method, route, body, token);
      assert.equal(res.status, 400, `${method} ${route}: ${JSON.stringify(res.data)}`);
    }
    for (const table of ['server_roles', 'server_member_roles', 'channel_roles', 'channel_categories']) {
      assert.equal((await dbAll(server.dataDir, `SELECT COUNT(*) AS n FROM ${table}`))[0].n, 0, table);
    }
  });

  test('rows planted for the commons grant nothing, and its state carries no roles or permissions', async () => {
    const sqlite3 = require('sqlite3');
    const run = (sql, params) => new Promise((resolve, reject) => {
      const db = new sqlite3.Database(path.join(server.dataDir, 'data.sqlite'));
      db.run(sql, params, (err) => { db.close(); if (err) reject(err); else resolve(undefined); });
    });
    await run("INSERT INTO server_roles (id, server_id, name, position, permissions, created_at) VALUES ('role-planted', 'demo', 'Boss', 1, ?, 1)", [JSON.stringify(PERMISSIONS)]);
    await run("INSERT INTO server_member_roles (server_id, username, role_id) VALUES ('demo', 'anyone', 'role-planted')", []);
    const sock = await connect(server.base, token);
    try {
      const state = await joinServer(sock, 'demo');
      assert.deepEqual([state.myRole, state.myPermissions, state.server.roles, state.server.categories], ['member', [], [], []]);
    } finally { sock.close(); }
    assert.equal((await call('PATCH', '/servers/demo', { name: 'Mine now' }, token)).status, 400);
    assert.equal((await call('GET', '/servers/demo/audit', undefined, token)).status, 400);
    // Anyone may still add a public channel there, as before; a category named with it is ignored.
    const made = await call('POST', '/servers/demo/channels', { name: 'open', privacy: 'private', roles: ['role-planted'], categoryId: 'cat-x' }, token);
    assert.deepEqual([made.status, made.data.channel.privacy, made.data.channel.categoryId], [200, 'public', null]);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM channel_roles'))[0].n, 0);
  });
});
