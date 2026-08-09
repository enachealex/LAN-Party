// Accepting a friend request notifies the ORIGINAL SENDER with a dedicated event carrying who
// accepted. friend:list-updated can't serve this: it is emitted to BOTH parties and carries no
// payload, so a client keyed off it would also celebrate on the accepter's own side and would have
// no name to show.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');

function once(socket, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

// Resolves null if the event does NOT arrive within the window (used to assert silence).
function notWithin(socket, event, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

describe('friend request accepted event', () => {
  let server, call, base, senderToken, accepterToken;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    senderToken = await makeUser(call, 'sender');
    accepterToken = await makeUser(call, 'accepter');
  });
  after(async () => { await server.stop(); });

  test('the sender is told who accepted; the accepter is not', async () => {
    const sender = await connect(base, senderToken);
    const accepter = await connect(base, accepterToken);
    try {
      await call('POST', '/friends/request', { username: 'accepter' }, senderToken);
      const incoming = await call('GET', '/friends/requests/incoming', undefined, accepterToken);
      const requestId = incoming.data.requests[0].id;

      const senderNotified = once(sender, 'friend:request-accepted');
      // The accepter performed the action, so celebrating on their side would be wrong.
      const accepterSilent = notWithin(accepter, 'friend:request-accepted', 1200);

      const res = await call('POST', `/friends/requests/${requestId}/accept`, undefined, accepterToken);
      assert.equal(res.status, 200);

      const payload = await senderNotified;
      assert.equal(payload.by, 'accepter', 'sender learns who accepted');
      assert.equal(await accepterSilent, null, 'accepter gets no acceptance event');
    } finally {
      sender.close();
      accepter.close();
    }
  });

  test('declining does NOT emit the accepted event', async () => {
    const declinerToken = await makeUser(call, 'decliner');
    const sender = await connect(base, senderToken);
    try {
      await call('POST', '/friends/request', { username: 'decliner' }, senderToken);
      const incoming = await call('GET', '/friends/requests/incoming', undefined, declinerToken);
      const requestId = incoming.data.requests[0].id;

      const quiet = notWithin(sender, 'friend:request-accepted', 1200);
      const res = await call('POST', `/friends/requests/${requestId}/decline`, undefined, declinerToken);
      assert.equal(res.status, 200);
      assert.equal(await quiet, null, 'no acceptance event when the request is declined');
    } finally {
      sender.close();
    }
  });

});
