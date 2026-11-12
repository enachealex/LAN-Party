// Shareable invite links (routes/invites.js). The link is a bearer credential handed to people who
// may not have an account, so most of this is about what must NOT happen: a member minting links,
// the public lookup telling a dead code from one that never existed, a 1-use link admitting two
// people, a link outliving its server, or a link undoing a kick.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');

const INVALID = { valid: false, error: 'This invite link is invalid or has expired.' };

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

describe('server invite links', () => {
  // /auth/register allows 10 accounts an hour per caller, and every test here shares one server, so
  // the cast is fixed and people step back out when a later test needs a newcomer. They LEAVE rather
  // than get kicked: a kick is remembered and would keep them out of every later link (see 'removal').
  let server, call, owner, admin, member, outsider, racerA, racerB, other, serverId;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    owner = await makeUser(call, 'linkowner');
    admin = await makeUser(call, 'linkadmin');
    member = await makeUser(call, 'linkmember');
    outsider = await makeUser(call, 'linkoutsider');
    racerA = await makeUser(call, 'racera');
    racerB = await makeUser(call, 'racerb');
    other = await makeUser(call, 'otherowner');

    const made = await call('POST', '/servers', { name: 'Link Test' }, owner);
    serverId = made.data.server.id;
    await call('POST', `/servers/${serverId}/invite`, { username: 'linkadmin' }, owner);
    await call('PATCH', `/servers/${serverId}/members/linkadmin`, { role: 'admin' }, owner);
    await call('POST', `/servers/${serverId}/invite`, { username: 'linkmember' }, owner);
  });
  after(async () => { await server.stop(); });

  const create = (body, token, sid = serverId) => call('POST', `/servers/${sid}/invites`, body, token);
  const list = (token, sid = serverId) => call('GET', `/servers/${sid}/invites`, undefined, token);
  const revoke = (code, token, sid = serverId) => call('DELETE', `/servers/${sid}/invites/${code}`, undefined, token);
  const lookup = (code) => call('GET', `/invites/${code}`);
  const accept = (code, token) => call('POST', `/invites/${code}/accept`, {}, token);
  const kick = (username) => call('DELETE', `/servers/${serverId}/members/${username}`, undefined, owner);
  const leave = async (token) => {
    const res = await call('POST', `/servers/${serverId}/leave`, {}, token);
    assert.equal(res.status, 200, JSON.stringify(res.data));
  };
  const roster = async () => (await call('GET', `/servers/${serverId}/members`, undefined, owner)).data.members.map((m) => m.username).sort();
  const row = async (code) => (await dbAll(server.dataDir, 'SELECT * FROM server_invites WHERE code = ?', [code]))[0];
  const mint = async (body = {}) => {
    const res = await create(body, owner);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.invite.code;
  };

  describe('creating', () => {
    test('the owner gets a random URL-safe code and the path the client links to', async () => {
      const res = await create({}, owner);
      assert.equal(res.status, 200);
      const inv = res.data.invite;
      // 16 base64url characters = 96 bits. Anything shorter than 10 would be under the 60-bit floor.
      assert.match(inv.code, /^[A-Za-z0-9_-]{16}$/);
      assert.equal(inv.path, `/app/?invite=${inv.code}`);
      assert.equal(inv.createdBy, 'linkowner');
      assert.equal(inv.uses, 0);
      assert.equal(inv.expiresAt, null, 'no expiry unless asked for');
      assert.equal(inv.maxUses, null, 'unlimited unless asked for');
    });

    test('an admin can create one too', async () => {
      const res = await create({ expiresInHours: 24, maxUses: 5 }, admin);
      assert.equal(res.status, 200);
      assert.equal(res.data.invite.maxUses, 5);
      const ttl = res.data.invite.expiresAt - Date.now();
      assert.ok(ttl > 23 * 3_600_000 && ttl <= 24 * 3_600_000, `expiry should be ~24h out, got ${ttl}ms`);
      // Persisted, not just echoed.
      const saved = await row(res.data.invite.code);
      assert.equal(saved.server_id, serverId);
      assert.equal(saved.created_by, 'linkadmin');
      assert.equal(saved.max_uses, 5);
      assert.equal(saved.expires_at, res.data.invite.expiresAt);
    });

    test('codes are not sequential or repeated', async () => {
      const codes = new Set();
      for (let i = 0; i < 5; i++) codes.add(await mint());
      assert.equal(codes.size, 5);
    });

    test('a plain member cannot', async () => {
      const res = await create({}, member);
      assert.equal(res.status, 403);
    });

    test('someone outside the server cannot', async () => {
      const res = await create({}, outsider);
      assert.equal(res.status, 403);
    });

    test('nor can anyone without a token', async () => {
      const res = await create({}, undefined);
      assert.equal(res.status, 401);
    });

    test('the public demo server is refused, even though everyone is a member of it', async () => {
      const res = await create({}, owner, 'demo');
      assert.equal(res.status, 400);
      assert.deepEqual(await dbAll(server.dataDir, "SELECT code FROM server_invites WHERE server_id = 'demo'"), []);
    });

    test('an unknown server is a 404', async () => {
      const res = await create({}, owner, 'srv-nope');
      assert.equal(res.status, 404);
    });

    test('expiry and max uses are bounded, and must be whole numbers', async () => {
      for (const body of [
        { expiresInHours: 0 }, { expiresInHours: -1 }, { expiresInHours: 1.5 }, { expiresInHours: 24 * 30 + 1 }, { expiresInHours: '24' },
        { maxUses: 0 }, { maxUses: -3 }, { maxUses: 2.5 }, { maxUses: 1001 }, { maxUses: '5' },
      ]) {
        const res = await create(body, owner);
        assert.equal(res.status, 400, `should reject ${JSON.stringify(body)}`);
        assert.match(res.data.error, /^(Expiry|Max uses) must be/);
      }
      // The largest values allowed, and an explicit "no limit".
      assert.equal((await create({ expiresInHours: 24 * 30, maxUses: 1000 }, owner)).status, 200);
      assert.equal((await create({ expiresInHours: null, maxUses: null }, owner)).status, 200);
    });
  });

  describe('listing', () => {
    test('staff see the active links with their uses and expiry', async () => {
      const code = await mint({ expiresInHours: 168, maxUses: 3 });
      for (const token of [owner, admin]) {
        const res = await list(token);
        assert.equal(res.status, 200);
        const mine = res.data.invites.find((i) => i.code === code);
        assert.ok(mine, 'the new link is listed');
        assert.deepEqual(Object.keys(mine).sort(), ['code', 'createdAt', 'createdBy', 'expiresAt', 'maxUses', 'path', 'uses']);
        assert.equal(mine.uses, 0);
        assert.equal(mine.maxUses, 3);
        assert.ok(mine.expiresAt > Date.now());
      }
    });

    test('members and outsiders cannot list them', async () => {
      assert.equal((await list(member)).status, 403);
      assert.equal((await list(outsider)).status, 403);
      assert.equal((await list(undefined)).status, 401);
    });
  });

  describe('public lookup', () => {
    test('works with no token and returns only the name, icon and member count', async () => {
      const code = await mint();
      const res = await lookup(code);
      assert.equal(res.status, 200);
      // Exact shape: a new field here is a new thing a stranger can read, so it must be deliberate.
      assert.deepEqual(res.data, { valid: true, server: { name: 'Link Test', iconUrl: null, memberCount: (await roster()).length } });
      // In particular: no server id, no member names, no owner, nothing about the link itself.
      const raw = JSON.stringify(res.data);
      for (const secret of [serverId, 'linkowner', 'linkadmin', 'linkmember']) assert.ok(!raw.includes(secret), `must not expose ${secret}`);
    });

    test('revoked, expired, used up, unknown and malformed all get the same answer', async () => {
      const revoked = await mint();
      await revoke(revoked, owner);
      const expired = await mint({ expiresInHours: 1 });
      await dbAll(server.dataDir, 'UPDATE server_invites SET expires_at = ? WHERE code = ?', [Date.now() - 1000, expired]);
      const usedUp = await mint({ maxUses: 2 });
      await dbAll(server.dataDir, 'UPDATE server_invites SET uses = 2 WHERE code = ?', [usedUp]);
      const unknown = 'AAAAAAAAAAAAAAAA'; // right shape, never issued

      for (const [label, code] of [['revoked', revoked], ['expired', expired], ['used up', usedUp], ['unknown', unknown], ['malformed', 'x'], ['hostile', "'%20OR%201=1--"]]) {
        const res = await lookup(code);
        assert.equal(res.status, 404, `${label} should be a 404`);
        assert.deepEqual(res.data, INVALID, `${label} must be indistinguishable`);
      }
    });
  });

  describe('accepting', () => {
    let code;

    test('needs a token', async () => {
      code = await mint();
      const res = await accept(code, undefined);
      assert.equal(res.status, 401);
      assert.equal((await row(code)).uses, 0);
    });

    test('adds the caller as a member, counts the use, and tells both sides live', async () => {
      // The owner is looking at the server; the newcomer is connected but in no server yet.
      const ownerSock = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token: owner } });
      const joinSock = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token: outsider } });
      try {
        await Promise.all([once(ownerSock, 'connect'), once(joinSock, 'connect')]);
        const settled = once(ownerSock, 'server:state');
        ownerSock.emit('join', { serverId, name: 'linkowner' });
        await settled;

        const railRefresh = once(joinSock, 'servers:updated');
        const rosterGrew = once(ownerSock, 'server:state', (s) => (s.members || []).some((m) => m.username === 'linkoutsider'));
        const res = await accept(code, outsider);
        assert.equal(res.status, 200);
        assert.equal(res.data.success, true);
        assert.equal(res.data.alreadyMember, false);
        assert.deepEqual(res.data.server, { id: serverId, name: 'Link Test', iconUrl: null });
        await Promise.all([railRefresh, rosterGrew]);
      } finally {
        ownerSock.close();
        joinSock.close();
      }

      assert.ok((await roster()).includes('linkoutsider'));
      const members = (await call('GET', `/servers/${serverId}/members`, undefined, owner)).data.members;
      assert.equal(members.find((m) => m.username === 'linkoutsider').role, 'member', 'a link never grants more than member');
      const mine = (await call('GET', '/servers', undefined, outsider)).data.servers;
      assert.ok(mine.some((s) => s.id === serverId), 'the server is on their rail');
      assert.equal((await row(code)).uses, 1);
      assert.equal((await list(owner)).data.invites.find((i) => i.code === code).uses, 1);
    });

    test('accepting again succeeds without spending another use', async () => {
      const res = await accept(code, outsider);
      assert.equal(res.status, 200);
      assert.equal(res.data.alreadyMember, true);
      assert.equal(res.data.server.id, serverId);
      assert.equal((await row(code)).uses, 1);
      assert.equal((await roster()).filter((u) => u === 'linkoutsider').length, 1);
    });

    test('existing members and staff are not charged a use either', async () => {
      for (const token of [owner, admin, member]) {
        const res = await accept(code, token);
        assert.equal(res.status, 200);
        assert.equal(res.data.alreadyMember, true);
      }
      assert.equal((await row(code)).uses, 1);
      // The owner must still be the owner: accepting never rewrites a role.
      const members = (await call('GET', `/servers/${serverId}/members`, undefined, owner)).data.members;
      assert.equal(members.find((m) => m.username === 'linkowner').role, 'owner');
      assert.equal(members.find((m) => m.username === 'linkadmin').role, 'admin');
    });

    test('whoever used the last use can reopen the link; nobody new can', async () => {
      await leave(outsider);
      const single = await mint({ maxUses: 1 });
      assert.equal((await accept(single, outsider)).status, 200);
      assert.equal((await lookup(single)).status, 404, 'used up, so the public sees it as invalid');
      const again = await accept(single, outsider);
      assert.equal(again.status, 200);
      assert.equal(again.data.alreadyMember, true);
      const late = await accept(single, racerA);
      assert.equal(late.status, 404);
      assert.deepEqual(late.data, INVALID);
      assert.ok(!(await roster()).includes('racera'));
      assert.equal((await row(single)).uses, 1);
    });

    test('an expired link admits nobody', async () => {
      const expiring = await mint({ expiresInHours: 1 });
      await dbAll(server.dataDir, 'UPDATE server_invites SET expires_at = ? WHERE code = ?', [Date.now() - 1, expiring]);
      const res = await accept(expiring, racerA);
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, INVALID);
      assert.ok(!(await roster()).includes('racera'));
      assert.equal((await row(expiring)).uses, 0);
      assert.ok(!(await list(owner)).data.invites.some((i) => i.code === expiring), 'and drops out of the admin list');
    });

    test('an unknown code admits nobody', async () => {
      const res = await accept('AAAAAAAAAAAAAAAA', racerA);
      assert.equal(res.status, 404);
      assert.deepEqual(res.data, INVALID);
    });
  });

  describe('revoking', () => {
    test('only staff of that server can revoke', async () => {
      const code = await mint();
      assert.equal((await revoke(code, member)).status, 403);
      assert.equal((await revoke(code, racerA)).status, 403);
      assert.equal((await revoke(code, undefined)).status, 401);
      // Another server's owner, going through their own server: the code is not theirs to kill.
      const theirs = (await call('POST', '/servers', { name: 'Elsewhere' }, other)).data.server.id;
      assert.equal((await revoke(code, other, theirs)).status, 404);
      assert.equal((await lookup(code)).status, 200, 'still alive after every failed attempt');
      await call('DELETE', `/servers/${theirs}`, undefined, other);
    });

    test('a revoked link stops working everywhere, and the row is kept', async () => {
      const code = await mint();
      const res = await revoke(code, admin);
      assert.equal(res.status, 200);
      assert.equal((await lookup(code)).status, 404);
      const tried = await accept(code, racerA);
      assert.equal(tried.status, 404);
      assert.deepEqual(tried.data, INVALID);
      assert.ok(!(await roster()).includes('racera'));
      assert.ok(!(await list(owner)).data.invites.some((i) => i.code === code));
      const saved = await row(code);
      assert.ok(saved && saved.revoked_at > 0, 'revoked_at is stamped rather than the row deleted');
      // Revoking twice is harmless and does not move the timestamp.
      assert.equal((await revoke(code, owner)).status, 200);
      assert.equal((await row(code)).revoked_at, saved.revoked_at);
    });

    test('revoking a code that was never issued is a 404', async () => {
      assert.equal((await revoke('AAAAAAAAAAAAAAAA', owner)).status, 404);
    });
  });

  describe('max uses under concurrency', () => {
    test('two people racing for a 1-use link: exactly one gets in', async () => {
      // Several rounds, because a race that is lost only sometimes would pass a single attempt.
      for (let round = 0; round < 5; round++) {
        const code = await mint({ maxUses: 1 });
        const results = await Promise.all([accept(code, racerA), accept(code, racerB)]);
        const statuses = results.map((r) => r.status).sort();
        assert.deepEqual(statuses, [200, 404], `round ${round}: got ${statuses}`);
        const names = await roster();
        const inside = ['racera', 'racerb'].filter((u) => names.includes(u));
        assert.equal(inside.length, 1, `round ${round}: exactly one racer is a member`);
        assert.equal((await row(code)).uses, 1, `round ${round}: one use recorded`);
        await leave(inside[0] === 'racera' ? racerA : racerB);
      }
    });

    test('one person accepting twice at once is one member and one use', async () => {
      const code = await mint({ maxUses: 5 });
      const results = await Promise.all([accept(code, racerA), accept(code, racerA), accept(code, racerA)]);
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
      assert.equal(results.filter((r) => r.data.alreadyMember === false).length, 1, 'only one of them actually joined');
      assert.equal((await row(code)).uses, 1);
      assert.equal((await roster()).filter((u) => u === 'racera').length, 1);
      await leave(racerA);
    });

    test('and that holds when the link has a single use', async () => {
      // The case the conditional UPDATE cannot settle alone: the same person twice, one use to spend.
      // Whichever request loses must be told they are in, not that their own link is invalid.
      for (let round = 0; round < 5; round++) {
        const code = await mint({ maxUses: 1 });
        const results = await Promise.all([accept(code, racerA), accept(code, racerA)]);
        assert.deepEqual(results.map((r) => r.status), [200, 200], `round ${round}`);
        assert.equal(results.filter((r) => r.data.alreadyMember === false).length, 1);
        assert.equal((await row(code)).uses, 1);
        await leave(racerA);
      }
    });
  });

  describe('lifecycle', () => {
    test('deleting a server deletes its links', async () => {
      const made = await call('POST', '/servers', { name: 'Doomed' }, other);
      const doomed = made.data.server.id;
      const a = (await create({}, other, doomed)).data.invite.code;
      const b = (await create({ maxUses: 2 }, other, doomed)).data.invite.code;
      const kept = await mint(); // a different server's link must survive
      assert.equal((await lookup(a)).status, 200);

      assert.equal((await call('DELETE', `/servers/${doomed}`, undefined, other)).status, 200);
      assert.deepEqual(await dbAll(server.dataDir, 'SELECT code FROM server_invites WHERE server_id = ?', [doomed]), []);
      for (const code of [a, b]) {
        const res = await lookup(code);
        assert.equal(res.status, 404);
        assert.deepEqual(res.data, INVALID);
        assert.equal((await accept(code, racerA)).status, 404);
      }
      assert.equal((await lookup(kept)).status, 200);
    });

    test('the by-username invite still works alongside links', async () => {
      assert.ok(!(await roster()).includes('racerb'));
      const res = await call('POST', `/servers/${serverId}/invite`, { username: 'racerb' }, owner);
      assert.equal(res.status, 200);
      assert.ok((await roster()).includes('racerb'));
      await kick('racerb');
    });

    test('renaming the admin who minted a link carries the link with them', async () => {
      const made = await call('POST', '/servers', { name: 'Renamed Owner' }, other);
      const sid = made.data.server.id;
      const code = (await create({}, other, sid)).data.invite.code;
      const renamed = await call('POST', '/user/username', { username: 'otherowner2' }, other);
      assert.equal(renamed.status, 200);
      const listed = await list(renamed.data.token, sid);
      assert.equal(listed.data.invites.find((i) => i.code === code).createdBy, 'otherowner2');
    });

    test('a token whose account is gone cannot join through a link', async () => {
      // Deactivation deletes the user row but the JWT stays valid until it expires.
      const code = await mint();
      await dbAll(server.dataDir, "DELETE FROM users WHERE username = 'racerb'");
      const res = await accept(code, racerB);
      assert.equal(res.status, 401);
      assert.ok(!(await roster()).includes('racerb'));
      assert.equal((await row(code)).uses, 0);
    });
  });

  // Before links existed, a kicked person only came back if staff added their username again. A link
  // is a standing "anyone holding this may join", so each of these would otherwise be a way round
  // being removed, or a way to keep handing out a server you are no longer staff of.
  describe('removal', () => {
    const invite = (username) => call('POST', `/servers/${serverId}/invite`, { username }, owner);
    const setRole = async (username, role) => {
      const res = await call('PATCH', `/servers/${serverId}/members/${username}`, { role }, owner);
      assert.equal(res.status, 200, JSON.stringify(res.data));
    };
    const removedRows = (sid = serverId) => dbAll(server.dataDir, 'SELECT username, removed_by FROM server_removed WHERE server_id = ? ORDER BY username', [sid]);

    // Earlier groups in this file kick people too (the by-username invite test removes racerb), and
    // those kicks are remembered. Start from a clean slate so "exactly these rows" means this group's.
    before(async () => { await dbAll(server.dataDir, 'DELETE FROM server_removed WHERE server_id = ?', [serverId]); });

    test('a kicked member cannot walk back in through a live link', async () => {
      const code = await mint();
      assert.equal((await accept(code, racerA)).status, 200);
      assert.equal((await kick('racera')).status, 200);
      assert.deepEqual(await removedRows(), [{ username: 'racera', removed_by: 'linkowner' }]);

      const back = await accept(code, racerA);
      assert.equal(back.status, 404);
      assert.deepEqual(back.data, INVALID, 'the same answer as for a dead link');
      assert.ok(!(await roster()).includes('racera'));
      assert.equal((await row(code)).uses, 1, 'the refused attempt is not charged to the link');

      // Not through any other link either, and a refused attempt cannot use up a limited one.
      const single = await mint({ maxUses: 1 });
      assert.equal((await accept(single, racerA)).status, 404);
      assert.equal((await row(single)).uses, 0);
      // The links themselves are untouched: they still work for everyone else.
      assert.equal((await lookup(code)).status, 200);
      assert.equal((await lookup(single)).status, 200);
    });

    test('staff adding them back by username is what lets them in again', async () => {
      assert.equal((await invite('racera')).status, 200);
      assert.ok((await roster()).includes('racera'));
      assert.deepEqual(await removedRows(), [], 'the kick is forgotten');

      // From here on they are an ordinary member: having left of their own accord, a link works.
      await leave(racerA);
      assert.deepEqual(await removedRows(), [], 'leaving is not being removed');
      const res = await accept(await mint(), racerA);
      assert.equal(res.status, 200);
      assert.equal(res.data.alreadyMember, false);
      await leave(racerA);
    });

    test('kicking an admin revokes the links they minted, and no link lets them back in', async () => {
      await setRole('linkmember', 'admin');
      const theirs = (await create({}, member)).data.invite.code; // no expiry, no cap: the default
      const ownersLink = await mint();
      assert.equal((await lookup(theirs)).status, 200);

      assert.equal((await kick('linkmember')).status, 200);
      assert.equal((await lookup(theirs)).status, 404, 'their link died with their role');
      assert.ok((await row(theirs)).revoked_at > 0, 'revoked, with the row kept as a record');
      assert.ok(!(await list(owner)).data.invites.some((i) => i.code === theirs));
      // It admits nobody: not them, and not someone they passed it to.
      assert.deepEqual((await accept(theirs, member)).data, INVALID);
      assert.deepEqual((await accept(theirs, racerA)).data, INVALID);
      // And the kick itself holds against a link that is still alive.
      assert.deepEqual((await accept(ownersLink, member)).data, INVALID);
      assert.equal((await lookup(ownersLink)).status, 200, 'nobody else\'s link was touched');
      assert.deepEqual((await roster()).filter((u) => u === 'linkmember' || u === 'racera'), []);

      assert.equal((await invite('linkmember')).status, 200); // back for the tests below
    });

    test('demoting an admin revokes their links and leaves them a member', async () => {
      await setRole('linkmember', 'admin');
      const theirs = (await create({ maxUses: 50 }, member)).data.invite.code;
      const ownersLink = await mint();

      await setRole('linkmember', 'member');
      assert.equal((await lookup(theirs)).status, 404);
      assert.ok((await row(theirs)).revoked_at > 0);
      assert.deepEqual((await accept(theirs, racerA)).data, INVALID);
      assert.ok((await roster()).includes('linkmember'), 'demoted, not removed');
      assert.equal((await lookup(ownersLink)).status, 200);

      // Being promoted again does not bring the old links back to life.
      await setRole('linkmember', 'admin');
      assert.equal((await lookup(theirs)).status, 404);
      // A promotion on its own revokes nothing.
      const kept = (await create({}, member)).data.invite.code;
      await setRole('linkmember', 'admin');
      assert.equal((await lookup(kept)).status, 200);
      await setRole('linkmember', 'member');
      assert.equal((await lookup(kept)).status, 404);
    });

    test('an admin who leaves takes their links along, and may come back through someone else\'s', async () => {
      await setRole('linkmember', 'admin');
      const theirs = (await create({}, member)).data.invite.code;
      await leave(member);
      assert.equal((await lookup(theirs)).status, 404);
      assert.deepEqual((await accept(theirs, member)).data, INVALID);

      const res = await accept(await mint(), member);
      assert.equal(res.status, 200);
      assert.equal(res.data.alreadyMember, false);
      const members = (await call('GET', `/servers/${serverId}/members`, undefined, owner)).data.members;
      assert.equal(members.find((m) => m.username === 'linkmember').role, 'member', 'back as a member, not as the admin they were');
    });

    test('a kick follows the person through a rename, and is dropped with their account', async () => {
      const code = await mint();
      assert.equal((await accept(code, racerA)).status, 200);
      assert.equal((await kick('racera')).status, 200);

      const renamed = await call('POST', '/user/username', { username: 'racera2' }, racerA);
      assert.equal(renamed.status, 200);
      assert.deepEqual(await removedRows(), [{ username: 'racera2', removed_by: 'linkowner' }]);
      assert.deepEqual((await accept(code, renamed.data.token)).data, INVALID, 'a new name is not a way back in');

      // Deactivation frees the username; whoever registers it next must not inherit the kick. The
      // confirm token only exists in an email, so read it from the database as the link would carry it.
      assert.equal((await call('POST', '/account/deactivate', {}, renamed.data.token)).status, 200);
      const [pending] = await dbAll(server.dataDir, "SELECT token FROM auth_tokens WHERE purpose = 'deactivate' ORDER BY rowid DESC LIMIT 1");
      assert.equal((await call('POST', '/account/deactivate/confirm', { token: pending.token })).status, 200);
      assert.deepEqual(await removedRows(), []);
    });

    test('deleting a server forgets who was removed from it', async () => {
      const sid = (await call('POST', '/servers', { name: 'Short lived' }, owner)).data.server.id;
      assert.equal((await call('POST', `/servers/${sid}/invite`, { username: 'linkoutsider' }, owner)).status, 200);
      assert.equal((await call('DELETE', `/servers/${sid}/members/linkoutsider`, undefined, owner)).status, 200);
      assert.equal((await removedRows(sid)).length, 1);
      assert.equal((await call('DELETE', `/servers/${sid}`, undefined, owner)).status, 200);
      assert.deepEqual(await removedRows(sid), []);
    });
  });

  describe('rate limiting', () => {
    // The limiter keys on the forwarded address, so each check below gets a bucket of its own and
    // cannot starve (or be starved by) the tests above, which all arrive as 127.0.0.1.
    const from = (ip, route, init = {}) => fetch(server.base + route, { ...init, headers: { 'x-forwarded-for': ip, ...(init.headers || {}) } });

    test('the public lookup is limited per caller', async () => {
      const first = await from('203.0.113.7', '/invites/AAAAAAAAAAAAAAAA');
      const limit = Number(first.headers.get('x-ratelimit-limit'));
      assert.ok(limit > 0 && limit <= 120, `lookup should advertise a sane limit, got ${limit}`);
      let last = first;
      for (let i = 1; i <= limit; i++) last = await from('203.0.113.7', '/invites/AAAAAAAAAAAAAAAA');
      assert.equal(last.status, 429);
      assert.ok(Number(last.headers.get('retry-after')) > 0);
      // Somebody else is unaffected.
      assert.equal((await from('203.0.113.8', '/invites/AAAAAAAAAAAAAAAA')).status, 404);
    });

    test('accept is limited before auth is even checked', async () => {
      const first = await from('203.0.113.9', '/invites/AAAAAAAAAAAAAAAA/accept', { method: 'POST' });
      assert.equal(first.status, 401);
      const limit = Number(first.headers.get('x-ratelimit-limit'));
      assert.ok(limit > 0 && limit <= 60, `accept should advertise a sane limit, got ${limit}`);
      let last = first;
      for (let i = 1; i <= limit; i++) last = await from('203.0.113.9', '/invites/AAAAAAAAAAAAAAAA/accept', { method: 'POST' });
      assert.equal(last.status, 429);
    });
  });
});
