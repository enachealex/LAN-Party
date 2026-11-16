// Custom emoji of a server (routes/library.js): who may add one, and who may take one away.
//   - add: a member of THAT server, not timed out there (and verified, which emailVerification.test.js
//     covers). An outsider, or someone timed out, is refused and nothing is written.
//   - remove: whoever added it, or someone with manage_server in that server. Another member is
//     refused, and so is a stranger, even with a name that exists.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, apiFor, makeUserFromOwnAddress: makeUser, dbAll } = require('./helpers');

const URL_OF = (n) => `/uploads/1700000000000-${n}.png`;

describe('custom emoji: adding and removing', () => {
  let server, call, sid, otherSid;
  const tok = {};
  const emojiNames = async (serverId) => (await dbAll(server.dataDir, 'SELECT name FROM server_emojis WHERE server_id = ? ORDER BY name', [serverId])).map((r) => r.name);
  const add = (who, name, serverId = sid) => call('POST', `/servers/${serverId}/emojis`, { url: URL_OF(name), name }, tok[who]);
  const remove = (who, name, serverId = sid) => call('DELETE', `/servers/${serverId}/emojis/${name}`, undefined, tok[who]);

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['own', 'mem', 'mgr', 'tim', 'out']) tok[name] = await makeUser(server.base, name);
    sid = (await call('POST', '/servers', { name: 'Emoji Club' }, tok.own)).data.server.id;
    for (const who of ['mem', 'mgr', 'tim']) assert.equal((await call('POST', `/servers/${sid}/invite`, { username: who }, tok.own)).status, 200);
    const role = await call('POST', `/servers/${sid}/roles`, { name: 'Managers', permissions: ['manage_server'] }, tok.own);
    assert.equal(role.status, 200, JSON.stringify(role.data));
    assert.equal((await call('PUT', `/servers/${sid}/members/mgr/roles/${role.data.role.id}`, undefined, tok.own)).status, 200);
    // A server of out's own, where nobody above but out is a member.
    otherSid = (await call('POST', '/servers', { name: 'Elsewhere' }, tok.out)).data.server.id;
  });

  after(async () => { await server?.stop(); });

  test('a member adds one; an outsider cannot add to a server they are not in', async () => {
    const ok = await add('mem', 'wave');
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.name, 'wave');
    const refused = await add('out', 'spam');
    assert.equal(refused.status, 403);
    assert.deepEqual(await emojiNames(sid), ['wave']);
    // In their own server it works.
    assert.equal((await add('out', 'mine', otherSid)).status, 200);
  });

  test('someone timed out in the server cannot add one there', async () => {
    assert.equal((await add('tim', 'before')).status, 200, 'allowed before the timeout');
    assert.equal((await call('POST', `/servers/${sid}/timeouts/tim`, { minutes: 30 }, tok.own)).status, 200);
    assert.equal((await add('tim', 'during')).status, 403);
    assert.deepEqual(await emojiNames(sid), ['before', 'wave']);
  });

  test('only whoever added it, or someone with manage_server, can remove it', async () => {
    assert.equal((await add('mem', 'keep')).status, 200);
    assert.equal((await add('mem', 'gone')).status, 200);
    assert.equal((await add('own', 'owners')).status, 200);
    // Another member, and a stranger, are refused.
    assert.equal((await remove('tim', 'keep')).status, 403);
    assert.equal((await remove('out', 'keep')).status, 403);
    assert.equal((await remove('mem', 'owners')).status, 403, "a member cannot remove the owner's emoji");
    // A stranger cannot reach another server's emoji through their own server's id either.
    assert.equal((await remove('out', 'keep', otherSid)).status, 404);
    // The one who added it can.
    assert.equal((await remove('mem', 'gone')).status, 200);
    // manage_server can remove anyone's, and so can the owner.
    assert.equal((await remove('mgr', 'keep')).status, 200);
    assert.equal((await remove('own', 'wave')).status, 200);
    assert.deepEqual(await emojiNames(sid), ['before', 'owners']);
    assert.equal((await remove('own', 'nothing-here')).status, 404);
  });
});
