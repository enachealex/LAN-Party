// Covers server membership: who can read the roster, who can invite, and the duplicate/unknown-user
// paths the invite dialog relies on to show "✓ In server" vs "Add".
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, apiFor, makeUser } = require('./helpers');

describe('server membership', () => {
  let server, call, ownerToken, palToken, outsiderToken, serverId;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    ownerToken = await makeUser(call, 'owner');
    palToken = await makeUser(call, 'pal');
    outsiderToken = await makeUser(call, 'outsider');
    const created = await call('POST', '/servers', { name: 'Test Server' }, ownerToken);
    serverId = created.data.server?.id || created.data.id;
    assert.ok(serverId, 'server should be created');
  });
  after(async () => { await server.stop(); });

  const members = async (token) => call('GET', `/servers/${encodeURIComponent(serverId)}/members`, undefined, token);
  const invite = async (username, token) =>
    call('POST', `/servers/${encodeURIComponent(serverId)}/invite`, { username }, token);

  test('creator is the only member, as owner', async () => {
    const res = await members(ownerToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.members, [{ username: 'owner', role: 'owner' }]);
  });

  test('non-members cannot read the roster', async () => {
    const res = await members(outsiderToken);
    assert.equal(res.status, 403);
  });

  test('rejects a missing username', async () => {
    const res = await invite(undefined, ownerToken);
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Username required');
  });

  test('rejects a whitespace-only username', async () => {
    const res = await invite('   ', ownerToken);
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Username required');
  });

  test('rejects an unknown user', async () => {
    const res = await invite('ghost', ownerToken);
    assert.equal(res.status, 404);
  });

  test('invites a user, trimming padding, and adds them to the roster', async () => {
    const res = await invite('  pal  ', ownerToken);
    assert.equal(res.status, 200);
    const roster = await members(ownerToken);
    const names = roster.data.members.map((m) => m.username).sort();
    assert.deepEqual(names, ['owner', 'pal']);
  });

  test('rejects inviting someone already in the server', async () => {
    const res = await invite('pal', ownerToken);
    assert.equal(res.status, 400);
    assert.match(res.data.error, /already a member/);
  });

  test('a plain member cannot invite', async () => {
    const res = await invite('outsider', palToken);
    assert.equal(res.status, 403);
  });
});
