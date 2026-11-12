// Typing indicators and the durable "@" badge. Typing is ephemeral, but it still says something
// about a private channel or a private conversation, so who it reaches is held to the same rules as
// who a message would reach.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function once(socket, event, match = () => true, timeoutMs = 4000) {
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

// Everything `socket` hears on `event` while `action` runs and for a short settle time afterwards:
// the way to assert that something did NOT arrive.
async function heard(socket, event, action, settleMs = 350) {
  const got = [];
  const onEvent = (payload) => got.push(payload);
  socket.on(event, onEvent);
  await action();
  await sleep(settleMs);
  socket.off(event, onEvent);
  return got;
}

describe('typing indicators', () => {
  let server, call, tok, serverId, generalId, privateId, groupId;
  const sockets = [];

  const connect = async (name) => {
    const socket = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token: tok[name] } });
    await once(socket, 'connect');
    sockets.push(socket);
    return socket;
  };
  // Put a socket in a channel's room the way the client does when it opens that channel.
  const open = async (socket, name, channelId, sid = serverId) => {
    socket.emit('join', { serverId: sid, name });
    await once(socket, 'server:state');
    socket.emit('joinChannel', { serverId: sid, channelId });
    await sleep(150);
  };

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    tok = {};
    for (const name of ['ann', 'ben', 'cat', 'dan', 'eve']) tok[name] = await makeUser(call, name);

    // ann owns a server; ben, cat and eve are members; dan is a stranger to all of them.
    const made = await call('POST', '/servers', { name: 'Typing Test' }, tok.ann);
    serverId = made.data.server.id;
    for (const name of ['ben', 'cat', 'eve']) await call('POST', `/servers/${serverId}/invite`, { username: name }, tok.ann);
    const priv = await call('POST', `/servers/${serverId}/channels`, { name: 'officers', privacy: 'private', members: ['ben'] }, tok.ann);
    privateId = priv.data.channel.id;

    // A group needs at least two other people. cat is deliberately left out of it.
    const group = await call('POST', '/groups', { name: 'trio', members: ['ben', 'eve'] }, tok.ann);
    assert.equal(group.status, 200, JSON.stringify(group.data));
    groupId = group.data.group.id;
  });
  after(async () => { for (const s of sockets) s.close(); await server.stop(); });

  test('in a channel, typing reaches the others who have it open, and not the typist', async () => {
    const ann = await connect('ann');
    const ben = await connect('ben');
    // The channel id comes from the state the server sends on join.
    ann.emit('join', { serverId, name: 'ann' });
    const state = await once(ann, 'server:state');
    generalId = state.server.channels.find((c) => c.name === 'general').id;
    ann.emit('joinChannel', { serverId, channelId: generalId });
    await open(ben, 'ben', generalId);

    const benHears = once(ben, 'typing');
    const annHears = await heard(ann, 'typing', async () => ann.emit('typing', { scope: 'channel', serverId, channelId: generalId }));
    assert.deepEqual(await benHears, { scope: 'channel', serverId, channelId: generalId, from: 'ann' });
    assert.deepEqual(annHears, [], 'you are not told that you are typing');
  });

  test('typing in a private channel reaches nobody who cannot open it', async () => {
    const ann = await connect('ann');
    const ben = await connect('ben');
    const cat = await connect('cat');
    await open(ann, 'ann', privateId);
    await open(ben, 'ben', privateId);
    await open(cat, 'cat', privateId); // refused by the server: cat has no access

    const benHears = once(ben, 'typing');
    const catHears = await heard(cat, 'typing', async () => ann.emit('typing', { scope: 'channel', serverId, channelId: privateId }));
    assert.equal((await benHears).from, 'ann');
    assert.deepEqual(catHears, [], 'cat cannot see the channel, so must not learn someone is typing in it');
  });

  test('someone who cannot post in a channel cannot announce typing there', async () => {
    const ben = await connect('ben');
    const dan = await connect('dan');
    await open(ben, 'ben', generalId);
    // dan is not a member of the server at all.
    const benHears = await heard(ben, 'typing', async () => dan.emit('typing', { scope: 'channel', serverId, channelId: generalId }));
    assert.deepEqual(benHears, []);
    // cat is a member, but not of the private channel.
    const cat = await connect('cat');
    await open(ben, 'ben', privateId);
    assert.deepEqual(await heard(ben, 'typing', async () => cat.emit('typing', { scope: 'channel', serverId, channelId: privateId })), []);
  });

  test('in a DM it reaches the other person only if the two may message each other', async () => {
    const ann = await connect('ann');
    const ben = await connect('ben');
    const dan = await connect('dan');
    // ann and ben share a server, so they may DM.
    const benHears = once(ben, 'typing', (p) => p.scope === 'dm');
    ann.emit('typing', { scope: 'dm', to: 'ben' });
    assert.deepEqual(await benHears, { scope: 'dm', from: 'ann' });
    // dan has no connection to ann: a stranger must not be able to make "typing…" appear for her.
    assert.deepEqual(await heard(ann, 'typing', async () => dan.emit('typing', { scope: 'dm', to: 'ann' })), []);
    // …and nothing for a user who does not exist, or for yourself.
    assert.deepEqual(await heard(dan, 'typing', async () => { await sleep(1100); dan.emit('typing', { scope: 'dm', to: 'nobody-here' }); }), []);
  });

  test('in a group it reaches the other members, and only a member can send it', async () => {
    const ann = await connect('ann');
    const ben = await connect('ben');
    const cat = await connect('cat');
    const benHears = once(ben, 'typing', (p) => p.scope === 'group');
    const annHears = await heard(ann, 'typing', async () => ann.emit('typing', { scope: 'group', groupId }));
    assert.deepEqual(await benHears, { scope: 'group', groupId, from: 'ann' });
    assert.deepEqual(annHears, []);
    // cat is not in the group.
    assert.deepEqual(await heard(ben, 'typing', async () => cat.emit('typing', { scope: 'group', groupId })), []);
  });

  test('a flood of typing events is collapsed, so it cannot be used to spam a room', async () => {
    const ann = await connect('ann');
    const ben = await connect('ben');
    await open(ann, 'ann', generalId);
    await open(ben, 'ben', generalId);
    const got = await heard(ben, 'typing', async () => {
      for (let i = 0; i < 25; i++) ann.emit('typing', { scope: 'channel', serverId, channelId: generalId });
    }, 500);
    assert.equal(got.length, 1, 'one per second per socket, however many are sent');
  });

  test('someone leaving does not strip the server name and channels from everyone else', async () => {
    const ann = await connect('ann');
    const ben = await connect('ben');
    await open(ann, 'ann', generalId);
    await open(ben, 'ben', generalId);
    // The client replaces its whole server state with each one it is sent, so the state that follows
    // a disconnect has to be as complete as the one that follows a join.
    const afterLeave = once(ann, 'server:state');
    ben.close();
    const state = await afterLeave;
    assert.equal(state.server.name, 'Typing Test');
    assert.ok(state.server.channels.some((c) => c.id === generalId), 'channels are still there');
    assert.equal(state.myRole, 'owner');
    assert.ok(state.members.some((m) => m.username === 'ann'));
  });

  test('malformed typing events are ignored without breaking the socket', async () => {
    const ann = await connect('ann');
    for (const bad of [undefined, null, 'x', { scope: 'channel' }, { scope: 'nonsense' }, { scope: 'group', groupId: 'nope' }]) {
      ann.emit('typing', bad);
      await sleep(30);
    }
    await sleep(1100);
    // Still alive and still working.
    const ben = await connect('ben');
    const benHears = once(ben, 'typing', (p) => p.scope === 'dm');
    ann.emit('typing', { scope: 'dm', to: 'ben' });
    assert.equal((await benHears).from, 'ann');
  });
});

describe('the mention badge after a reload', () => {
  let server, call, tok, serverId, generalId, privateId;
  const sockets = [];

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    tok = {};
    for (const name of ['sam', 'samantha', 'kit']) tok[name] = await makeUser(call, name);
    const made = await call('POST', '/servers', { name: 'Mention Test' }, tok.kit);
    serverId = made.data.server.id;
    for (const name of ['sam', 'samantha']) await call('POST', `/servers/${serverId}/invite`, { username: name }, tok.kit);
    const priv = await call('POST', `/servers/${serverId}/channels`, { name: 'staff', privacy: 'private', members: [] }, tok.kit);
    privateId = priv.data.channel.id;

    const kit = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token: tok.kit } });
    sockets.push(kit);
    await once(kit, 'connect');
    kit.emit('join', { serverId, name: 'kit' });
    const state = await once(kit, 'server:state');
    generalId = state.server.channels.find((c) => c.name === 'general').id;
    const say = async (channelId, text) => {
      kit.emit('joinChannel', { serverId, channelId });
      await sleep(80);
      const echoed = once(kit, 'message', (m) => m.text === text);
      kit.emit('message', { serverId, channelId, text });
      await echoed;
    };
    await say(generalId, 'morning all');
    await say(generalId, 'hey @sam can you look at this');
    await say(generalId, '@samantha you too');
    await say(generalId, 'mail sam@example.com about it');
    await say(privateId, '@sam this is staff only');
  });
  after(async () => { for (const s of sockets) s.close(); await server.stop(); });

  test('GET /unreads counts the unread messages that mention me', async () => {
    const res = await call('GET', '/unreads', undefined, tok.sam);
    assert.equal(res.status, 200);
    assert.equal(res.data.unreads[serverId][generalId], 4);
    assert.deepEqual(res.data.mentions, { [serverId]: { [generalId]: 1 } }, 'only the message that names sam: not @samantha, not an email address');
  });

  test('a longer name is not confused with a shorter one', async () => {
    const res = await call('GET', '/unreads', undefined, tok.samantha);
    assert.deepEqual(res.data.mentions, { [serverId]: { [generalId]: 1 } });
  });

  test('a mention in a channel I cannot open is never reported', async () => {
    // sam was named in the private staff channel but has no access to it.
    const res = await call('GET', '/unreads', undefined, tok.sam);
    assert.equal(res.data.unreads[serverId][privateId], undefined);
    assert.equal(res.data.mentions[serverId][privateId], undefined);
  });

  test('the author of a message is not badged by their own mention, and nothing unread means no mentions', async () => {
    const res = await call('GET', '/unreads', undefined, tok.kit);
    assert.deepEqual(res.data.mentions, {});
  });
});
