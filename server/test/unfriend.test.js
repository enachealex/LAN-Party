// Removing a friend (DELETE /friends/:username). The case that matters most is the last one: an
// accepted request stays in friend_requests, which is UNIQUE per direction, so removal has to clear
// it or the same two people could never become friends again.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, apiFor, makeUser } = require('./helpers');

async function befriend(call, fromToken, toToken, toUsername) {
  const req = await call('POST', '/friends/request', { username: toUsername }, fromToken);
  assert.equal(req.status, 200, `friend request should succeed: ${JSON.stringify(req.data)}`);
  const incoming = await call('GET', '/friends/requests/incoming', undefined, toToken);
  const res = await call('POST', `/friends/requests/${incoming.data.requests[0].id}/accept`, undefined, toToken);
  assert.equal(res.status, 200);
}

const friendNames = async (call, token) => (await call('GET', '/friends', undefined, token)).data.friends.map((f) => f.name);

describe('removing a friend', () => {
  let server, call, aliceToken, bobToken;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    aliceToken = await makeUser(call, 'alice');
    bobToken = await makeUser(call, 'bob');
    await befriend(call, aliceToken, bobToken, 'bob');
    await call('POST', '/messages/send', { toUsername: 'bob', text: 'remember this' }, aliceToken);
  });
  after(async () => { await server.stop(); });

  test('removes the friendship for both people', async () => {
    const res = await call('DELETE', '/friends/bob', undefined, aliceToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await friendNames(call, aliceToken), []);
    assert.deepEqual(await friendNames(call, bobToken), []);
  });

  test("removing someone who isn't a friend is a 404", async () => {
    assert.equal((await call('DELETE', '/friends/bob', undefined, aliceToken)).status, 404);
    assert.equal((await call('DELETE', '/friends/nobody-here', undefined, aliceToken)).status, 404);
  });

  test('needs authentication', async () => {
    assert.equal((await call('DELETE', '/friends/bob')).status, 401);
  });

  test('the same two people can become friends again, from either side, with history intact', async () => {
    await befriend(call, bobToken, aliceToken, 'alice'); // the reverse direction this time
    assert.deepEqual(await friendNames(call, aliceToken), ['bob']);
    await call('DELETE', '/friends/alice', undefined, bobToken);
    await befriend(call, aliceToken, bobToken, 'bob'); // and the original direction again
    assert.deepEqual(await friendNames(call, bobToken), ['alice']);
    const thread = await call('GET', '/messages/with/bob', undefined, aliceToken);
    assert.ok(thread.data.messages.some((m) => m.text === 'remember this'), 'old messages should still be there');
  });
});
