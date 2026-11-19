// A channel message sent with an acknowledgement (the quick reply on a notification toast). The
// sender is not in the channel's room, so the answer is the only way it learns the message landed
// or why it was refused. Without one, refusals still arrive as message:error, as the composer
// expects. The badge nudge also says what kind of file came with a message that has no text.
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
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.on(event, onEvent);
  });
}
const never = (socket, event, match = () => true, ms = 700) => once(socket, event, match, ms).then(() => false, () => true);

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

async function joinServer(socket, serverId) {
  const state = once(socket, 'server:state', (s) => s.server.id === serverId);
  socket.emit('join', { serverId });
  return { state: await state };
}

const sendWithAck = (socket, payload) => new Promise((resolve) => socket.emit('message', payload, resolve));

describe('channel messages with an acknowledgement', () => {
  let server, call, serverId, generalId;
  const tok = {};
  const sock = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'mem', 'out']) tok[name] = await makeUser(server.base, name);
    serverId = (await call('POST', '/servers', { name: 'Ack Room' }, tok.own)).data.server.id;
    assert.equal((await call('POST', `/servers/${serverId}/invite`, { username: 'mem' }, tok.own)).status, 200);
    sock.own = await connect(server.base, tok.own);
    generalId = (await joinServer(sock.own, serverId)).state.server.channels.find((c) => c.type === 'text').id;
    // mem replies from a socket that never joined the server, as a toast reply from elsewhere can.
    sock.mem = await connect(server.base, tok.mem);
    sock.out = await connect(server.base, tok.out);
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server.stop();
  });

  test('accepted: answered with the stored message, delivered to the channel under the sender\'s name', async () => {
    const heard = once(sock.own, 'message', (m) => m.text === 'quick reply');
    const answer = await sendWithAck(sock.mem, { serverId, channelId: generalId, text: 'quick reply' });
    assert.equal(answer.ok, true);
    assert.equal(answer.message.text, 'quick reply');
    assert.equal(answer.message.author, 'mem');
    assert.equal((await heard).author, 'mem');
  });

  test('refused: the reason comes back in the answer, and no message:error is sent as well', async () => {
    const noError = never(sock.out, 'message:error');
    const answer = await sendWithAck(sock.out, { serverId, channelId: generalId, text: 'let me in' });
    assert.equal(answer.ok, false);
    assert.equal(answer.reason, 'no-access');
    assert.equal(answer.text, 'let me in');
    assert.ok(await noError);
    const unknown = await sendWithAck(sock.mem, { serverId, channelId: 'ch-nope', text: 'hello?' });
    assert.deepEqual([unknown.ok, unknown.reason], [false, 'unknown-channel']);
    const empty = await sendWithAck(sock.mem, { serverId, channelId: generalId, text: '   ' });
    assert.deepEqual([empty.ok, empty.reason], [false, 'empty']);
  });

  test('without an acknowledgement a refusal is a message:error, as before', async () => {
    const refused = once(sock.out, 'message:error');
    sock.out.emit('message', { serverId, channelId: generalId, text: 'still no' });
    const err = await refused;
    assert.equal(err.reason, 'no-access');
    assert.equal(err.text, 'still no');
  });

  test('the unread nudge carries the type of a file sent without text', async () => {
    const bump = once(sock.mem, 'unread:bump', (b) => b.author === 'own' && b.channelId === generalId);
    sock.own.emit('message', { serverId, channelId: generalId, text: '', attachment: { url: '/uploads/1700000000000-cat.png', name: 'cat.png', size: 10, type: 'image/png' } });
    const b = await bump;
    assert.equal(b.attachmentType, 'image/png');
    assert.equal(b.preview, '');
    const plain = once(sock.mem, 'unread:bump', (x) => x.author === 'own' && x.preview === 'just words');
    sock.own.emit('message', { serverId, channelId: generalId, text: 'just words' });
    assert.equal((await plain).attachmentType, undefined);
  });
});
