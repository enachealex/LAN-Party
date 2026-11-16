// A timeout reaches past messages and voice: the shared image canvas of a channel (collab:*) and
// the camera/screen state that puts someone on everyone's Discover list (voice:stream-state,
// voice:screenshare-state). index.js mayCollabIn / enforceCollabAccess / inVoiceRoom.
//
// As in moderation.test.js, the timed-out person is played by raw sockets that ignore whatever the
// client would have stopped. Three things are checked for each: refused while timed out, allowed
// when not, and a timeout in one server changing nothing in another.
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
// Resolves true if the event does NOT arrive within the window.
const never = (socket, event, match = () => true, ms = 700) => once(socket, event, match, ms).then(() => false, () => true);

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

async function joinServer(socket, serverId) {
  const state = once(socket, 'server:state', (s) => s.server.id === serverId);
  const init = once(socket, 'messages:init', (m) => m.serverId === serverId);
  socket.emit('join', { serverId });
  return { state: await state, init: await init };
}

async function joinVoice(socket, serverId, channelId) {
  const peers = once(socket, 'voice:peers');
  socket.emit('voice:join', { serverId, channelId });
  await peers;
}

describe('timeouts: shared image canvases and stream state', () => {
  let server, call;
  const tok = {};
  const sock = {};
  // Quiet Room: tim is timed out here part-way through. Next Door: he never is.
  const A = {};
  const B = {};
  const IMAGE = 'https://example.test/uploads/1700000000000-cat.png';
  const SEGMENT = { x0: 0, y0: 0, x1: 1, y1: 1, color: '#f00', size: 3 };
  // Is this socket's entry (a screen share) on a Discover list?
  const listed = (socket, serverId) => (list) => list.some((s) => s.kind === 'screen' && s.id === socket.id && s.serverId === serverId);
  const delisted = (socket) => (list) => !list.some((s) => s.id === socket.id);

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'tim', 'mem', 'out']) tok[name] = await makeUser(server.base, name);
    A.id = (await call('POST', '/servers', { name: 'Quiet Room' }, tok.own)).data.server.id;
    B.id = (await call('POST', '/servers', { name: 'Next Door' }, tok.mem)).data.server.id;
    for (const who of ['tim', 'mem']) assert.equal((await call('POST', `/servers/${A.id}/invite`, { username: who }, tok.own)).status, 200);
    assert.equal((await call('POST', `/servers/${B.id}/invite`, { username: 'tim' }, tok.mem)).status, 200);
    for (const name of ['own', 'tim', 'mem']) {
      sock[name] = await connect(server.base, tok[name]);
      const { state } = await joinServer(sock[name], A.id);
      A.general = state.server.channels.find((c) => c.type === 'text').id;
      A.voice = state.server.channels.find((c) => c.type === 'voice').id;
    }
    // Next Door, on sockets of their own (a socket follows one server at a time, as the client does).
    for (const name of ['timB', 'memB']) {
      sock[name] = await connect(server.base, tok[name.slice(0, 3)]);
      const { state } = await joinServer(sock[name], B.id);
      B.general = state.server.channels.find((c) => c.type === 'text').id;
      B.voice = state.server.channels.find((c) => c.type === 'voice').id;
    }
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server.stop();
  });

  test('not timed out: anyone in the channel can start, join and draw, and go live from voice', async () => {
    // mem starts a canvas in Quiet Room's general, the way the client does: join, then announce.
    const invited = once(sock.own, 'collab:invite', (i) => i.sessionId === IMAGE);
    const memState = once(sock.mem, 'collab:state', (s) => s.sessionId === IMAGE);
    sock.mem.emit('collab:join', { sessionId: IMAGE, imageUrl: IMAGE, serverId: A.id, channelId: A.general });
    sock.mem.emit('collab:start', { serverId: A.id, channelId: A.general, sessionId: IMAGE, imageUrl: IMAGE });
    await memState;
    const invite = await invited;
    assert.deepEqual(invite, { sessionId: IMAGE, imageUrl: IMAGE, by: invite.by, serverId: A.id, channelId: A.general });

    // own and tim accept it.
    for (const name of ['own', 'tim']) {
      const state = once(sock[name], 'collab:state', (s) => s.sessionId === IMAGE);
      sock[name].emit('collab:join', { sessionId: IMAGE, imageUrl: IMAGE, serverId: invite.serverId, channelId: invite.channelId });
      await state;
    }
    // A stroke from tim reaches the others, and so does a clear.
    const drawn = once(sock.own, 'collab:draw');
    sock.tim.emit('collab:draw', { sessionId: IMAGE, segment: SEGMENT });
    assert.deepEqual((await drawn).segment, SEGMENT);
    const cleared = once(sock.mem, 'collab:clear');
    sock.tim.emit('collab:clear', { sessionId: IMAGE });
    await cleared;

    // tim goes live in Quiet Room's voice channel: on the Discover list, and the room is told.
    await joinVoice(sock.tim, A.id, A.voice);
    await joinVoice(sock.mem, A.id, A.voice);
    const live = once(sock.own, 'discover:update', listed(sock.tim, A.id));
    const sharing = once(sock.mem, 'voice:screenshare-state', (p) => p.id === sock.tim.id && p.sharing);
    sock.tim.emit('voice:screenshare-state', { serverId: A.id, channelId: A.voice, sharing: true });
    sock.tim.emit('voice:stream-state', { serverId: A.id, channelId: A.voice, camera: false, screen: true });
    await live;
    await sharing;
  });

  test('a timeout takes him out of the canvas and off the Discover list at once', async () => {
    const removed = once(sock.tim, 'collab:removed', (r) => r.sessionId === IMAGE);
    const delistedNow = once(sock.own, 'discover:update', delisted(sock.tim));
    const hungUp = once(sock.tim, 'voice:removed');
    const res = await call('POST', `/servers/${A.id}/timeouts/tim`, { minutes: 30 }, tok.own);
    assert.equal(res.status, 200);
    const told = await removed;
    assert.deepEqual(told, { sessionId: IMAGE, serverId: A.id, channelId: A.general, reason: 'timeout', until: res.data.timeout.until });
    await delistedNow;
    assert.equal((await hungUp).reason, 'timeout');

    // His long-lived socket draws into a session it is no longer in: nobody gets it.
    const nothing = never(sock.own, 'collab:draw');
    const noClear = never(sock.mem, 'collab:clear');
    sock.tim.emit('collab:draw', { sessionId: IMAGE, segment: SEGMENT });
    sock.tim.emit('collab:clear', { sessionId: IMAGE });
    assert.ok(await nothing, 'the stroke reached nobody');
    assert.ok(await noClear, 'the clear reached nobody');
    // The others carry on drawing together.
    const memDrawn = once(sock.own, 'collab:draw');
    sock.mem.emit('collab:draw', { sessionId: IMAGE, segment: SEGMENT });
    await memDrawn;
  });

  test('timed out, a raw socket can neither start, join, draw on nor clear a canvas there', async () => {
    const raw = await connect(server.base, tok.tim);
    try {
      await joinServer(raw, A.id);
      const OTHER = 'https://example.test/uploads/1700000000001-dog.png';
      const noInvite = never(sock.own, 'collab:invite');
      const refusedStart = once(raw, 'collab:removed', (r) => r.sessionId === OTHER);
      raw.emit('collab:start', { serverId: A.id, channelId: A.general, sessionId: OTHER, imageUrl: OTHER });
      assert.equal((await refusedStart).reason, 'timeout');
      assert.ok(await noInvite, 'the channel was not invited');

      // Joining the canvas everyone else is on: refused, and given nothing of it.
      const noState = never(raw, 'collab:state');
      const refusedJoin = once(raw, 'collab:removed', (r) => r.sessionId === IMAGE);
      raw.emit('collab:join', { sessionId: IMAGE, imageUrl: IMAGE, serverId: A.id, channelId: A.general });
      assert.equal((await refusedJoin).reason, 'timeout');
      assert.ok(await noState);

      // Not in it, so his strokes and clears go nowhere, however the session is named. A longer
      // window than usual: it has to cover every attempt below.
      const nothing = never(sock.own, 'collab:draw', () => true, 2500);
      const noClear = never(sock.own, 'collab:clear', () => true, 2500);
      raw.emit('collab:draw', { sessionId: IMAGE, segment: SEGMENT });
      raw.emit('collab:clear', { sessionId: IMAGE });
      // The direct-conversation form of the same image is a session of its own, and no session id
      // spells the channel's room: joining either way and drawing still reaches nobody there.
      for (const sessionId of [IMAGE, `${A.id}:${A.general}:${IMAGE}`, `${encodeURIComponent(A.id)}:${encodeURIComponent(A.general)}:${IMAGE}`]) {
        const state = once(raw, 'collab:state', (s) => s.sessionId === sessionId);
        raw.emit('collab:join', { sessionId, imageUrl: IMAGE });
        assert.deepEqual((await state).segments, [], 'an empty canvas of its own');
        raw.emit('collab:draw', { sessionId, segment: SEGMENT });
        raw.emit('collab:clear', { sessionId });
      }
      assert.ok(await nothing, 'no stroke reached the channel\'s canvas');
      assert.ok(await noClear, 'no clear reached the channel\'s canvas');

      // Stream state for a room he cannot be in: not listed, and the room is not told.
      const notListed = never(sock.own, 'discover:update', listed(raw, A.id));
      const notTold = never(sock.mem, 'voice:screenshare-state', (p) => p.id === raw.id);
      raw.emit('voice:join', { serverId: A.id, channelId: A.voice }); // refused at the door
      raw.emit('voice:stream-state', { serverId: A.id, channelId: A.voice, camera: true, screen: true });
      raw.emit('voice:screenshare-state', { serverId: A.id, channelId: A.voice, sharing: true });
      assert.ok(await notListed, 'not on anyone\'s Discover list');
      assert.ok(await notTold, 'the voice room heard nothing');
    } finally { raw.close(); }
  });

  test('the timeout is Quiet Room\'s alone: next door he starts, joins, draws and goes live', async () => {
    const IMAGE_B = 'https://example.test/uploads/1700000000002-bird.png';
    const invited = once(sock.memB, 'collab:invite', (i) => i.sessionId === IMAGE_B);
    const state = once(sock.timB, 'collab:state', (s) => s.sessionId === IMAGE_B);
    sock.timB.emit('collab:join', { sessionId: IMAGE_B, imageUrl: IMAGE_B, serverId: B.id, channelId: B.general });
    sock.timB.emit('collab:start', { serverId: B.id, channelId: B.general, sessionId: IMAGE_B, imageUrl: IMAGE_B });
    await state;
    const invite = await invited;
    assert.equal(invite.serverId, B.id);

    const memIn = once(sock.memB, 'collab:state', (s) => s.sessionId === IMAGE_B);
    sock.memB.emit('collab:join', { sessionId: IMAGE_B, imageUrl: IMAGE_B, serverId: B.id, channelId: B.general });
    await memIn;
    const drawn = once(sock.memB, 'collab:draw');
    sock.timB.emit('collab:draw', { sessionId: IMAGE_B, segment: SEGMENT });
    assert.deepEqual((await drawn).segment, SEGMENT);

    await joinVoice(sock.timB, B.id, B.voice);
    const live = once(sock.memB, 'discover:update', listed(sock.timB, B.id));
    sock.timB.emit('voice:stream-state', { serverId: B.id, channelId: B.voice, camera: false, screen: true });
    await live;
    const off = once(sock.memB, 'discover:update', delisted(sock.timB));
    sock.timB.emit('voice:stream-state', { serverId: B.id, channelId: B.voice, camera: false, screen: false });
    await off;
  });

  test('without a timeout the channel still decides: an outsider is refused, and so is a voice room you are not in', async () => {
    const outsider = await connect(server.base, tok.out);
    try {
      const noState = never(outsider, 'collab:state');
      const refused = once(outsider, 'collab:removed', (r) => r.sessionId === IMAGE);
      outsider.emit('collab:join', { sessionId: IMAGE, imageUrl: IMAGE, serverId: A.id, channelId: A.general });
      const told = await refused;
      assert.equal(told.reason, undefined, 'no timeout to speak of: just no access');
      assert.ok(await noState);
      const noInvite = never(sock.own, 'collab:invite');
      outsider.emit('collab:start', { serverId: A.id, channelId: A.general, sessionId: IMAGE, imageUrl: IMAGE });
      assert.ok(await noInvite);
    } finally { outsider.close(); }

    // own is a member in good standing but not in the voice channel: he cannot go live in it.
    const notListed = never(sock.mem, 'discover:update', listed(sock.own, A.id));
    sock.own.emit('voice:stream-state', { serverId: A.id, channelId: A.voice, camera: false, screen: true });
    assert.ok(await notListed);
  });

  test('a canvas opened from a direct conversation is unchanged: no channel, so no server to be timed out of', async () => {
    const DM_IMAGE = 'https://example.test/uploads/1700000000003-fish.png';
    const timIn = once(sock.tim, 'collab:state', (s) => s.sessionId === DM_IMAGE);
    sock.tim.emit('collab:join', { sessionId: DM_IMAGE, imageUrl: DM_IMAGE });
    await timIn;
    const memIn = once(sock.mem, 'collab:state', (s) => s.sessionId === DM_IMAGE);
    sock.mem.emit('collab:join', { sessionId: DM_IMAGE, imageUrl: DM_IMAGE });
    await memIn;
    const drawn = once(sock.mem, 'collab:draw');
    sock.tim.emit('collab:draw', { sessionId: DM_IMAGE, segment: SEGMENT });
    await drawn;
  });
});
