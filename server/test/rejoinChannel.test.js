// A reconnect re-sends `join` with the channel the window was on. The server puts it back there
// when that channel is still one it may see, instead of moving everyone to the first text channel
// (which pulled people out of the call view they were looking at, mid-call, on every deploy).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUserFromOwnAddress: makeUser } = require('./helpers');

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

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

// What a join lands on: the channel:joined answer, plus the history sent with it (if any).
async function joinLanding(socket, serverId, channelId) {
  const joined = once(socket, 'channel:joined', (p) => p.serverId === serverId);
  socket.emit('join', channelId === undefined ? { serverId } : { serverId, channelId });
  return (await joined).channelId;
}

describe('join puts a reconnecting window back in its channel', () => {
  let server, call, serverId, otherServerId, generalId, sideId, voiceId, privateId, otherChannelId;
  const tok = {};
  const sock = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'mem']) tok[name] = await makeUser(server.base, name);
    serverId = (await call('POST', '/servers', { name: 'Rejoin Room' }, tok.own)).data.server.id;
    otherServerId = (await call('POST', '/servers', { name: 'Elsewhere' }, tok.own)).data.server.id;
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'mem' }, tok.own)).status, 200);
    sideId = (await call('POST', `/servers/${serverId}/channels`, { name: 'side', type: 'text' }, tok.own)).data.channel.id;
    privateId = (await call('POST', `/servers/${serverId}/channels`, { name: 'staff', type: 'text', privacy: 'private' }, tok.own)).data.channel.id;
    sock.own = await connect(server.base, tok.own);
    sock.mem = await connect(server.base, tok.mem);
    const stateP = once(sock.own, 'server:state', (s) => s.server.id === serverId);
    sock.own.emit('join', { serverId });
    const state = await stateP;
    generalId = state.server.channels.find((c) => c.type === 'text').id;
    voiceId = state.server.channels.find((c) => c.type === 'voice').id;
    const otherP = once(sock.own, 'server:state', (s) => s.server.id === otherServerId);
    sock.own.emit('join', { serverId: otherServerId });
    otherChannelId = (await otherP).server.channels.find((c) => c.type === 'text').id;
    assert.notEqual(generalId, sideId);
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server.stop();
  });

  test('no channel named: the first text channel, as before', async () => {
    assert.equal(await joinLanding(sock.mem, serverId), generalId);
  });

  test('a text channel it may see: that channel, with its history', async () => {
    // Matched on the channel: the previous test's history for the first channel may still be on its way.
    const init = once(sock.mem, 'messages:init', (p) => p.serverId === serverId && p.channelId === sideId);
    assert.equal(await joinLanding(sock.mem, serverId, sideId), sideId);
    assert.ok(Array.isArray((await init).messages));
  });

  test('a voice channel (the call view): stays on it', async () => {
    assert.equal(await joinLanding(sock.mem, serverId, voiceId), voiceId);
  });

  test('a private channel it was not given: the first text channel instead', async () => {
    assert.equal(await joinLanding(sock.mem, serverId, privateId), generalId);
  });

  test('a channel of another server: the first text channel instead', async () => {
    assert.equal(await joinLanding(sock.own, serverId, otherChannelId), generalId);
  });

  test('junk in place of a channel id is ignored', async () => {
    assert.equal(await joinLanding(sock.own, serverId, { $ne: null }), generalId);
  });
});
