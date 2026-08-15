// Who may direct-message whom. The member list in a server offers "Private message", so sharing a
// server has to be sufficient — but a stranger with no connection at all must still be refused.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, apiFor, makeUser, PASSWORD } = require('./helpers');

describe('private messages', () => {
  let server, call, owner, member, stranger, friend, serverId;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    owner = await makeUser(call, 'pmowner');
    member = await makeUser(call, 'pmmember');
    stranger = await makeUser(call, 'pmstranger');
    friend = await makeUser(call, 'pmfriend');

    const made = await call('POST', '/servers', { name: 'PM Test' }, owner);
    serverId = made.data.server.id;
    await call('POST', `/servers/${serverId}/invite`, { username: 'pmmember' }, owner);

    // A friend who shares NO server, to prove friendship alone still works.
    await call('POST', '/friends/request', { username: 'pmfriend' }, owner);
    const incoming = await call('GET', '/friends/requests/incoming', undefined, friend);
    const list = Array.isArray(incoming.data) ? incoming.data : (incoming.data.requests || incoming.data.incoming || []);
    const req = list.find((r) => (r.fromUsername || r.from) === 'pmowner');
    await call('POST', `/friends/requests/${req.id}/accept`, {}, friend);
  });
  after(async () => { await server.stop(); });

  test('a server co-member can be messaged without being a friend', async () => {
    // The whole point: the Members list offers this, so it must not demand a friend request first.
    const res = await call('POST', '/messages/send', { toUsername: 'pmmember', text: 'welcome aboard' }, owner);
    assert.equal(res.status, 200);
    assert.equal(res.data.message.text, 'welcome aboard');
  });

  test('and the resulting thread is readable by both sides', async () => {
    // Sending but not being able to open the conversation would be worse than not sending at all.
    const mine = await call('GET', '/messages/with/pmmember', undefined, owner);
    assert.equal(mine.status, 200);
    const theirs = await call('GET', '/messages/with/pmowner', undefined, member);
    assert.equal(theirs.status, 200);
    assert.ok(theirs.data.messages.some((m) => m.text === 'welcome aboard'));
  });

  test('the co-member can reply', async () => {
    const res = await call('POST', '/messages/send', { toUsername: 'pmowner', text: 'glad to be here' }, member);
    assert.equal(res.status, 200);
  });

  test('friendship alone is still enough, with no shared server', async () => {
    const res = await call('POST', '/messages/send', { toUsername: 'pmfriend', text: 'hello friend' }, owner);
    assert.equal(res.status, 200);
  });

  test('a stranger — no friendship, no shared server — is still refused', async () => {
    const res = await call('POST', '/messages/send', { toUsername: 'pmstranger', text: 'spam' }, owner);
    assert.equal(res.status, 403);
    assert.match(res.data.error, /friends or people you share a server with/i);

    const thread = await call('GET', '/messages/with/pmstranger', undefined, owner);
    assert.equal(thread.status, 403, 'and cannot read a thread with them either');
  });

  test('leaving the shared server withdraws the ability to message', async () => {
    // Authorisation is evaluated per request, not cached at first contact.
    const left = await call('POST', `/servers/${serverId}/leave`, {}, member);
    assert.equal(left.status, 200);

    const res = await call('POST', '/messages/send', { toUsername: 'pmmember', text: 'still there?' }, owner);
    assert.equal(res.status, 403);
  });

  test('an empty message is rejected regardless of permission', async () => {
    // The modal disables Send for blank input; the server must not depend on that.
    for (const text of ['', '   ', '\n\t ']) {
      const res = await call('POST', '/messages/send', { toUsername: 'pmfriend', text }, owner);
      assert.equal(res.status, 400, `blank text ${JSON.stringify(text)} refused`);
    }
  });

  test('messaging requires auth', async () => {
    const res = await call('POST', '/messages/send', { toUsername: 'pmfriend', text: 'anon' });
    assert.equal(res.status, 401);
  });

  test('a message to a user who does not exist 404s', async () => {
    const res = await call('POST', '/messages/send', { toUsername: 'nobody-here', text: 'hi' }, owner);
    assert.equal(res.status, 404);
  });
});
