// Two things a channel must never do: hand its history to someone who cannot open it (GET
// /user/sync used to return every server's every message to any signed-in user), and echo the wrong
// row after a send (the socket handler re-read "the last inserted row" on a connection it shares
// with DM and group inserts).
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

async function connectTo(server, token, sockets) {
  const socket = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  sockets.push(socket);
  return socket;
}

// Join a server and open one of its channels, the way the client does. Resolves with the general
// channel's id, which only the server's own state reveals.
async function openChannel(socket, serverId, name, channelId) {
  socket.emit('join', { serverId, name });
  const state = await once(socket, 'server:state');
  const generalId = state.server.channels.find((c) => c.name === 'general').id;
  const target = channelId || generalId;
  const joined = once(socket, 'channel:joined', (p) => p.channelId === target);
  socket.emit('joinChannel', { serverId, channelId: target });
  await joined;
  return generalId;
}

async function say(socket, serverId, channelId, text) {
  const echoed = once(socket, 'message', (m) => m.text === text);
  socket.emit('message', { serverId, channelId, text });
  return echoed;
}

describe('the echo of a channel message', () => {
  let server, call, tok, serverId, generalId, privateId, groupId;
  const sockets = [];

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    tok = {};
    for (const name of ['ann', 'ben', 'cat']) tok[name] = await makeUser(call, name);
    const made = await call('POST', '/servers', { name: 'Echo Test' }, tok.ann);
    serverId = made.data.server.id;
    for (const name of ['ben', 'cat']) await call('POST', `/servers/${serverId}/invite`, { username: name }, tok.ann);
    const priv = await call('POST', `/servers/${serverId}/channels`, { name: 'officers', privacy: 'private', members: [] }, tok.ann);
    privateId = priv.data.channel.id;
    const group = await call('POST', '/groups', { name: 'trio', members: ['ben', 'cat'] }, tok.ann);
    assert.equal(group.status, 200, JSON.stringify(group.data));
    groupId = group.data.group.id;
  });
  after(async () => { for (const s of sockets) s.close(); await server.stop(); });

  test('is the message that was sent, even while DMs and group messages are being stored', async () => {
    const ann = await connectTo(server, tok.ann, sockets);
    generalId = await openChannel(ann, serverId, 'ann');

    // Put the three tables' ids out of step, and leave private-channel rows at the low ids a stray
    // DM or group rowid would point to: those are what a wrong re-read would broadcast.
    const staff = await connectTo(server, tok.ann, sockets);
    await openChannel(staff, serverId, 'ann', privateId);
    for (let i = 0; i < 8; i++) await say(staff, serverId, privateId, `staff only ${i}`);

    const ben = await connectTo(server, tok.ben, sockets);
    await openChannel(ben, serverId, 'ben');
    const benHeard = [];
    ben.on('message', (m) => benHeard.push(m));

    const annHeard = [];
    ann.on('message', (m) => annHeard.push(m));

    // One burst of all three kinds at once, so DM and group inserts land between a channel insert
    // and its re-read.
    const count = 25;
    const expected = Array.from({ length: count }, (_, i) => `channel ${i}`);
    const others = [];
    for (let i = 0; i < count; i++) {
      others.push(call('POST', '/messages/send', { toUsername: 'ben', text: `dm ${i}` }, tok.ann));
      others.push(call('POST', `/groups/${groupId}/messages`, { text: `group ${i}` }, tok.ann));
    }
    await sleep(5); // let those requests reach the server before the channel messages do
    for (const text of expected) ann.emit('message', { serverId, channelId: generalId, text });
    for (const res of await Promise.all(others)) assert.equal(res.status, 200, JSON.stringify(res.data));

    const deadline = Date.now() + 4000;
    while (annHeard.length < count && Date.now() < deadline) await sleep(25);
    await sleep(200);

    // Compared as a set: a burst sent this fast is not stored in the order it was sent, and that is
    // not what is being tested. Each message echoed exactly once, and nothing else, is.
    const texts = (heard) => heard.map((m) => m.text).sort();
    assert.deepEqual(texts(annHeard), [...expected].sort(), 'the sender is echoed each of its own messages, exactly once');
    assert.ok(annHeard.every((m) => m.author === 'ann' && m.serverId === serverId && m.channelId === generalId));
    assert.deepEqual(texts(benHeard), [...expected].sort(), 'and everyone else in the channel gets exactly those');
    assert.deepEqual(benHeard.map((m) => m.id), annHeard.map((m) => m.id), 'the same rows, in the same order, for everyone');
    assert.ok(!benHeard.some((m) => /staff only/.test(m.text)), 'and nothing from the private channel');

    // Each echo carries the id of its own row, so a later edit or delete addresses the right message.
    const history = await call('GET', '/user/sync', undefined, tok.ann);
    const stored = history.data.servers[serverId].messages[generalId];
    const storedText = new Map(stored.map((m) => [m.id, m.text]));
    for (const m of annHeard) assert.equal(storedText.get(m.id), m.text, `echo ${m.id} names its own row`);
  });
});

describe('GET /user/sync', () => {
  let server, call, tok, serverId, otherServerId, generalId, privateId;
  const sockets = [];
  const TOTAL = 60; // more than one page

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    tok = {};
    for (const name of ['owner', 'granted', 'member', 'outsider']) tok[name] = await makeUser(call, name);

    const made = await call('POST', '/servers', { name: 'Sync Test' }, tok.owner);
    serverId = made.data.server.id;
    for (const name of ['granted', 'member']) await call('POST', `/servers/${serverId}/invite`, { username: name }, tok.owner);
    const priv = await call('POST', `/servers/${serverId}/channels`, { name: 'officers', privacy: 'private', members: ['granted'] }, tok.owner);
    privateId = priv.data.channel.id;
    // A second server nobody but the outsider belongs to.
    otherServerId = (await call('POST', '/servers', { name: 'Elsewhere' }, tok.outsider)).data.server.id;

    const owner = await connectTo(server, tok.owner, sockets);
    generalId = await openChannel(owner, serverId, 'owner');
    for (let i = 0; i < TOTAL; i++) await say(owner, serverId, generalId, `general ${i}`);
    await openChannel(owner, serverId, 'owner', privateId);
    await say(owner, serverId, privateId, 'officers only');

    const outsider = await connectTo(server, tok.outsider, sockets);
    const elsewhereGeneral = await openChannel(outsider, otherServerId, 'outsider');
    await say(outsider, otherServerId, elsewhereGeneral, 'elsewhere only');
  });
  after(async () => { for (const s of sockets) s.close(); await server.stop(); });

  test('requires auth', async () => {
    assert.equal((await call('GET', '/user/sync')).status, 401);
  });

  test('someone who is not a member gets nothing from the server', async () => {
    const res = await call('GET', '/user/sync', undefined, tok.outsider);
    assert.equal(res.status, 200);
    assert.equal(res.data.servers[serverId], undefined);
    assert.ok(!JSON.stringify(res.data).includes('officers only'));
    assert.ok(!JSON.stringify(res.data).includes('general 59'));
    // The public commons and their own server are still there.
    assert.ok(res.data.servers.demo, 'everyone belongs to the commons');
    assert.ok(Array.isArray(res.data.servers.demo.channels));
    assert.ok(res.data.servers[otherServerId]);
  });

  test('a member sees the server, but not a private channel they were not added to', async () => {
    const res = await call('GET', '/user/sync', undefined, tok.member);
    const mine = res.data.servers[serverId];
    assert.equal(mine.name, 'Sync Test');
    assert.ok(mine.channels.some((c) => c.id === generalId));
    assert.ok(!mine.channels.some((c) => c.id === privateId), 'the channel is not even listed');
    assert.equal(mine.messages[privateId], undefined);
    assert.ok(!JSON.stringify(res.data).includes('officers only'));
    assert.equal(res.data.servers[otherServerId], undefined, "nor another server's messages");
    assert.ok(!JSON.stringify(res.data).includes('elsewhere only'));
  });

  test('the private channel is there for the people who can open it', async () => {
    for (const name of ['owner', 'granted']) {
      const res = await call('GET', '/user/sync', undefined, tok[name]);
      const mine = res.data.servers[serverId];
      assert.ok(mine.channels.some((c) => c.id === privateId), `${name} sees the channel`);
      assert.deepEqual(mine.messages[privateId].map((m) => m.text), ['officers only']);
    }
  });

  test('history is the newest page, oldest first, not the whole channel', async () => {
    const res = await call('GET', '/user/sync', undefined, tok.member);
    const texts = res.data.servers[serverId].messages[generalId].map((m) => m.text);
    assert.equal(texts.length, 50);
    assert.deepEqual(texts, Array.from({ length: 50 }, (_, i) => `general ${i + TOTAL - 50}`));
  });
});
