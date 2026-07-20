// Round-trips a direct message through the API so the message plumbing extracted into
// services/messages.js (row -> client shape, attachment/reaction/quote parsing) stays honest.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, apiFor, makeUser } = require('./helpers');

describe('direct messages', () => {
  let server, call, aliceToken, bobToken;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    aliceToken = await makeUser(call, 'alice');
    bobToken = await makeUser(call, 'bob');

    // Become friends: alice requests, bob accepts.
    await call('POST', '/friends/request', { username: 'bob' }, aliceToken);
    const incoming = await call('GET', '/friends/requests/incoming', undefined, bobToken);
    const requestId = incoming.data.requests[0].id;
    await call('POST', `/friends/requests/${requestId}/accept`, undefined, bobToken);
  });
  after(async () => { await server.stop(); });

  test('they are now friends', async () => {
    const res = await call('GET', '/friends', undefined, aliceToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.friends.map((f) => f.name), ['bob']);
  });

  test('a sent message comes back with its author and text intact', async () => {
    const sent = await call('POST', '/messages/send', { toUsername: 'bob', text: 'ready for the LAN?' }, aliceToken);
    assert.equal(sent.status, 200);

    const thread = await call('GET', '/messages/with/bob', undefined, aliceToken);
    assert.equal(thread.status, 200);
    const mine = thread.data.messages.find((m) => m.text === 'ready for the LAN?');
    assert.ok(mine, 'the sent message should appear in the thread');
    assert.equal(mine.author, 'alice');
    assert.ok(mine.id, 'message should carry an id');
    assert.ok(mine.ts, 'message should carry a timestamp');
  });

  test('the recipient sees the same message', async () => {
    const thread = await call('GET', '/messages/with/alice', undefined, bobToken);
    assert.equal(thread.status, 200);
    assert.ok(thread.data.messages.some((m) => m.text === 'ready for the LAN?'));
  });

  test('it shows up in the recipient conversation list', async () => {
    const res = await call('GET', '/messages/conversations', undefined, bobToken);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.conversations));
    assert.ok(res.data.conversations.some((c) => c.username === 'alice' || c.name === 'alice'));
  });

  test('an empty message is rejected', async () => {
    const res = await call('POST', '/messages/send', { toUsername: 'bob', text: '   ' }, aliceToken);
    assert.equal(res.status, 400);
  });

  test('messaging a non-friend is refused', async () => {
    const strangerToken = await makeUser(call, 'stranger');
    const res = await call('POST', '/messages/send', { toUsername: 'alice', text: 'hi' }, strangerToken);
    assert.equal(res.status, 403);
  });

  test('messages require authentication', async () => {
    const res = await call('GET', '/messages/with/bob');
    assert.equal(res.status, 401);
  });
});
