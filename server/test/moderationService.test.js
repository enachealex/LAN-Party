// Unit tests for services/moderation.js and services/blocks.js against an in-memory database.
// What the HTTP suites cannot do cheaply lives here: a clock the test owns (so a 28-day timeout can
// be watched running out), the audit log's size limit, and the rank rules as a plain table.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { migrate } = require('../db/schema');
const {
  createModeration, mayModerate, parseReason, parseMinutes, AUDIT,
  REASON_MAX, TIMEOUT_MIN_MINUTES, TIMEOUT_MAX_MINUTES, AUDIT_MAX_ROWS, AUDIT_PAGE_MAX,
} = require('../services/moderation');
const { createBlocks } = require('../services/blocks');

const MINUTE = 60_000;

async function setup() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await migrate(db);
  await db.run("INSERT INTO servers (id, name, owner) VALUES ('srv-a', 'A', 'owner')");
  await db.run("INSERT INTO servers (id, name, owner) VALUES ('srv-b', 'B', 'owner')");
  const clock = { at: 1_700_000_000_000 };
  const moderation = createModeration({ db, commonsId: 'demo', now: () => clock.at });
  return { db, clock, moderation };
}

describe('timeouts against a clock', () => {
  test('in force until the moment it ends, and over from that moment on', async () => {
    const { db, clock, moderation } = await setup();
    const placed = await moderation.setTimeoutFor('srv-a', 'tim', 'owner', 10, 'cool off');
    assert.equal(placed.until, clock.at + 10 * MINUTE);
    assert.deepEqual(await moderation.timeoutOf('srv-a', 'tim'), { until: placed.until, reason: 'cool off', by: 'owner' });
    assert.deepEqual([...(await moderation.timeoutsIn('srv-a'))], [['tim', placed.until]]);

    clock.at = placed.until - 1; // the last millisecond of it
    assert.ok(await moderation.timeoutOf('srv-a', 'tim'));
    clock.at = placed.until; // the moment it ends
    assert.equal(await moderation.timeoutOf('srv-a', 'tim'), null);
    assert.equal((await moderation.timeoutsIn('srv-a')).size, 0);
    // Nothing ran: the row is still there, it just no longer counts. Lifting it finds nothing to lift.
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM server_timeouts')).n, 1);
    assert.equal(await moderation.clearTimeoutFor('srv-a', 'tim'), false);
    await db.close();
  });

  test('the longest one allowed runs its full 28 days', async () => {
    const { clock, moderation } = await setup();
    const start = clock.at;
    await moderation.setTimeoutFor('srv-a', 'tim', 'owner', TIMEOUT_MAX_MINUTES, null);
    clock.at = start + 27 * 24 * 60 * MINUTE;
    assert.ok(await moderation.timeoutOf('srv-a', 'tim'));
    clock.at = start + 28 * 24 * 60 * MINUTE;
    assert.equal(await moderation.timeoutOf('srv-a', 'tim'), null);
  });

  test('per server and per person; a later one replaces an earlier one; expired rows are cleared on the next write', async () => {
    const { db, clock, moderation } = await setup();
    await moderation.setTimeoutFor('srv-a', 'tim', 'owner', 60, 'first');
    assert.equal(await moderation.timeoutOf('srv-b', 'tim'), null);
    assert.equal(await moderation.timeoutOf('srv-a', 'tom'), null);
    assert.equal(await moderation.timeoutOf('srv-a', ''), null);
    assert.equal(await moderation.timeoutOf('srv-a', null), null);

    const second = await moderation.setTimeoutFor('srv-a', 'tim', 'admin', 5, 'second');
    assert.deepEqual(await moderation.timeoutOf('srv-a', 'tim'), { until: second.until, reason: 'second', by: 'admin' });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM server_timeouts')).n, 1);

    clock.at += 6 * MINUTE; // tim's has run out
    await moderation.setTimeoutFor('srv-b', 'tom', 'owner', 5, null);
    assert.deepEqual((await db.all('SELECT username FROM server_timeouts')).map((r) => r.username), ['tom']);

    assert.equal(await moderation.clearTimeoutFor('srv-b', 'tom'), true);
    assert.equal(await moderation.timeoutOf('srv-b', 'tom'), null);
    await db.close();
  });

  test('the commons is never timed out or banned, whatever its tables hold', async () => {
    const { db, clock, moderation } = await setup();
    await db.run("INSERT INTO server_timeouts (server_id, username, until, timed_out_by, reason, created_at) VALUES ('demo', 'tim', ?, 'x', 'x', ?)", clock.at + MINUTE, clock.at);
    await db.run("INSERT INTO server_bans (server_id, username, banned_by, reason, banned_at) VALUES ('demo', 'tim', 'x', 'x', ?)", clock.at);
    assert.equal(await moderation.timeoutOf('demo', 'tim'), null);
    assert.equal((await moderation.timeoutsIn('demo')).size, 0);
    assert.equal(await moderation.banOf('demo', 'tim'), null);
    assert.deepEqual(await moderation.listBans('demo'), []);
    await moderation.audit('demo', 'tim', AUDIT.kick, 'tom');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM server_audit')).n, 0);
    assert.deepEqual(await moderation.auditPage('demo'), { entries: [], hasMore: false });
    await db.close();
  });
});

describe('bans', () => {
  test('placed, read back, replaced, lifted; one server at a time', async () => {
    const { clock, moderation } = await setup();
    assert.equal(await moderation.banOf('srv-a', 'bad'), null);
    await moderation.ban('srv-a', 'bad', 'owner', 'spam');
    assert.deepEqual(await moderation.banOf('srv-a', 'bad'), { username: 'bad', bannedBy: 'owner', reason: 'spam', bannedAt: clock.at });
    assert.equal(await moderation.banOf('srv-b', 'bad'), null);
    clock.at += MINUTE;
    await moderation.ban('srv-a', 'bad', 'admin', null);
    assert.deepEqual(await moderation.listBans('srv-a'), [{ username: 'bad', bannedBy: 'admin', reason: null, bannedAt: clock.at }]);
    assert.equal(await moderation.unban('srv-a', 'bad'), true);
    assert.equal(await moderation.unban('srv-a', 'bad'), false);
    assert.equal(await moderation.banOf('srv-a', 'bad'), null);
  });
});

describe('the rank rules', () => {
  const ask = (actorRole, targetRole, { self = false, targetIsOwner = false } = {}) => mayModerate({
    actor: 'actor', actorRole, target: self ? 'actor' : (targetIsOwner ? 'boss' : 'target'), targetRole, owner: actorRole === 'owner' ? 'actor' : 'boss',
  });

  test('the owner may act on anyone but themselves', () => {
    assert.equal(ask('owner', 'admin').ok, true);
    assert.equal(ask('owner', 'member').ok, true);
    assert.equal(ask('owner', null).ok, true, 'someone who is not a member (a ban)');
    assert.deepEqual([ask('owner', 'owner', { self: true }).ok, ask('owner', 'owner', { self: true }).status], [false, 400]);
  });

  test('an admin may act on plain members only: not sideways, not upwards, not on themselves', () => {
    assert.equal(ask('admin', 'member').ok, true);
    assert.equal(ask('admin', null).ok, true);
    assert.deepEqual([ask('admin', 'admin').ok, ask('admin', 'admin').status], [false, 403]);
    assert.deepEqual([ask('admin', 'owner', { targetIsOwner: true }).ok, ask('admin', 'owner', { targetIsOwner: true }).status], [false, 403]);
    assert.deepEqual([ask('admin', 'admin', { self: true }).ok, ask('admin', 'admin', { self: true }).status], [false, 400]);
  });

  test('the owner is protected by name as well as by role', () => {
    // A membership row that says 'member' for the account the server names as its owner.
    const res = mayModerate({ actor: 'admin1', actorRole: 'admin', target: 'boss', targetRole: 'member', owner: 'boss' });
    assert.deepEqual([res.ok, res.status], [false, 403]);
  });

  test('members and outsiders may do nothing, to anyone', () => {
    for (const actorRole of ['member', null, undefined, 'moderator', '']) {
      for (const targetRole of ['owner', 'admin', 'member', null]) {
        const res = ask(actorRole, targetRole);
        assert.deepEqual([res.ok, res.status], [false, 403], `${actorRole} on ${targetRole}`);
      }
    }
  });
});

describe('reason and length', () => {
  test('a reason is optional, trimmed, and at most 300 characters', () => {
    assert.deepEqual(parseReason(undefined), { reason: null });
    assert.deepEqual(parseReason(null), { reason: null });
    assert.deepEqual(parseReason('   '), { reason: null });
    assert.deepEqual(parseReason('  rude  '), { reason: 'rude' });
    assert.deepEqual(parseReason('x'.repeat(REASON_MAX)), { reason: 'x'.repeat(REASON_MAX) });
    assert.ok('error' in parseReason('x'.repeat(REASON_MAX + 1)));
    for (const bad of [42, true, {}, []]) assert.ok('error' in parseReason(bad), String(bad));
  });

  test('minutes is a whole number from 1 minute to 28 days', () => {
    assert.equal(TIMEOUT_MIN_MINUTES, 1);
    assert.equal(TIMEOUT_MAX_MINUTES, 28 * 24 * 60);
    for (const good of [1, 5, 60, 1440, 10080, TIMEOUT_MAX_MINUTES]) assert.deepEqual(parseMinutes(good), { minutes: good });
    for (const bad of [0, -1, 0.5, 1.5, TIMEOUT_MAX_MINUTES + 1, '5', null, undefined, NaN, Infinity, [5], {}]) {
      assert.ok('error' in parseMinutes(bad), String(bad));
    }
  });
});

describe('the audit log store', () => {
  test('entries come back newest first, with their detail, a page at a time', async () => {
    const { clock, moderation } = await setup();
    for (let i = 1; i <= 5; i++) {
      clock.at += 1000;
      await moderation.audit('srv-a', 'owner', AUDIT.kick, `user${i}`, { n: i });
    }
    await moderation.audit('srv-b', 'owner', AUDIT.left);
    const first = await moderation.auditPage('srv-a', { limit: 2 });
    assert.deepEqual(first.entries.map((e) => e.target), ['user5', 'user4']);
    assert.deepEqual(first.entries[0].detail, { n: 5 });
    assert.equal(first.hasMore, true);
    const rest = await moderation.auditPage('srv-a', { before: first.entries[1].id, limit: 10 });
    assert.deepEqual(rest.entries.map((e) => e.target), ['user3', 'user2', 'user1']);
    assert.equal(rest.hasMore, false);
    // Another server's log is its own.
    assert.deepEqual((await moderation.auditPage('srv-b')).entries.map((e) => [e.action, e.target, e.detail]), [['member.leave', null, null]]);
    // The page size has a ceiling whatever is asked for.
    for (let i = 0; i < AUDIT_PAGE_MAX + 5; i++) await moderation.audit('srv-a', 'owner', AUDIT.left);
    assert.equal((await moderation.auditPage('srv-a', { limit: 100000 })).entries.length, AUDIT_PAGE_MAX);
  });

  test('a server keeps its newest 5,000 entries and no more; other servers are not pruned for it', async () => {
    const { db, clock, moderation } = await setup();
    // Filled directly: 5,000 calls through audit() would test the same DELETE 5,000 times.
    await db.run('BEGIN');
    for (let i = 1; i <= AUDIT_MAX_ROWS; i++) {
      await db.run("INSERT INTO server_audit (server_id, ts, actor, action, target, detail) VALUES ('srv-a', ?, 'owner', 'member.kick', ?, NULL)", clock.at + i, `old${i}`);
    }
    await db.run("INSERT INTO server_audit (server_id, ts, actor, action, target, detail) VALUES ('srv-b', ?, 'owner', 'member.kick', 'theirs', NULL)", clock.at);
    await db.run('COMMIT');
    const count = async (id) => (await db.get('SELECT COUNT(*) AS n FROM server_audit WHERE server_id = ?', id)).n;
    assert.equal(await count('srv-a'), AUDIT_MAX_ROWS);

    await moderation.audit('srv-a', 'owner', AUDIT.ban, 'newest');
    assert.equal(await count('srv-a'), AUDIT_MAX_ROWS, 'still 5,000');
    assert.equal(await db.get("SELECT 1 AS one FROM server_audit WHERE target = 'old1'"), undefined, 'the oldest one went');
    assert.ok(await db.get("SELECT 1 AS one FROM server_audit WHERE target = 'old2'"), 'and only that one');
    assert.equal((await moderation.auditPage('srv-a', { limit: 1 })).entries[0].target, 'newest');

    for (let i = 0; i < 3; i++) await moderation.audit('srv-a', 'owner', AUDIT.unban, 'x');
    assert.equal(await count('srv-a'), AUDIT_MAX_ROWS);
    assert.equal(await count('srv-b'), 1, 'another server is left alone');
    await db.close();
  });

  test('recording never throws, and an unknown action is not written', async () => {
    const { db, moderation } = await setup();
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await moderation.audit('srv-a', 'owner', 'made.up', 'x');
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM server_audit')).n, 0);
      await db.exec('DROP TABLE server_audit');
      await moderation.audit('srv-a', 'owner', AUDIT.kick, 'x'); // must not reject
    } finally { console.error = original; }
    assert.equal(errors.length, 2);
    await db.close();
  });

  test('forgetting a server removes its bans, timeouts and log, and nobody else\'s', async () => {
    const { db, moderation } = await setup();
    for (const id of ['srv-a', 'srv-b']) {
      await moderation.ban(id, 'bad', 'owner', null);
      await moderation.setTimeoutFor(id, 'tim', 'owner', 5, null);
      await moderation.audit(id, 'owner', AUDIT.kick, 'x');
    }
    await moderation.forgetServer('srv-a');
    for (const table of ['server_bans', 'server_timeouts', 'server_audit']) {
      assert.deepEqual((await db.all(`SELECT server_id FROM ${table}`)).map((r) => r.server_id), ['srv-b'], table);
    }
    await db.close();
  });
});

describe('the block store', () => {
  async function people() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await migrate(db);
    const id = {};
    for (const name of ['ann', 'ben', 'cat']) {
      id[name] = (await db.run('INSERT INTO users (username, email, password_hash, settings) VALUES (?, ?, ?, ?)', name, `${name}@example.com`, 'x', '{}')).lastID;
    }
    return { db, id, blocks: createBlocks({ db }) };
  }

  test('one direction per row; "between" sees either; the name sets follow', async () => {
    const { db, id, blocks } = await people();
    assert.deepEqual(await blocks.block(id.ann, id.ben, 1000), { created: true, wereFriends: false });
    assert.equal(await blocks.hasBlocked(id.ann, id.ben), true);
    assert.equal(await blocks.hasBlocked(id.ben, id.ann), false);
    assert.equal(await blocks.between(id.ann, id.ben), true);
    assert.equal(await blocks.between(id.ben, id.ann), true);
    assert.equal(await blocks.between(id.ann, id.cat), false);
    assert.deepEqual([...(await blocks.blockedBy('ann'))], ['ben']);
    assert.deepEqual([...(await blocks.blockedBy('ben'))], []);
    assert.deepEqual([...(await blocks.blockersOf('ben'))], ['ann']);
    assert.deepEqual([...(await blocks.blockersOf('ann'))], []);
    assert.deepEqual([...(await blocks.blockedBy(null))], []);
    assert.deepEqual([...(await blocks.blockersOf('nobody'))], []);
    assert.deepEqual(await blocks.list(id.ann), [{ username: 'ben', userId: String(id.ben), blockedAt: 1000 }]);
    // Again: nothing new, and the first time stands.
    assert.deepEqual(await blocks.block(id.ann, id.ben, 2000), { created: false, wereFriends: false });
    assert.deepEqual(await blocks.list(id.ann), [{ username: 'ben', userId: String(id.ben), blockedAt: 1000 }]);
    assert.equal(await blocks.unblock(id.ann, id.ben), true);
    assert.equal(await blocks.unblock(id.ann, id.ben), false);
    assert.equal(await blocks.between(id.ann, id.ben), false);
    await db.close();
  });

  test('blocking removes the friendship and every request between the two, and nobody else\'s', async () => {
    const { db, id, blocks } = await people();
    for (const [a, b] of [['ann', 'ben'], ['ben', 'ann'], ['ann', 'cat'], ['cat', 'ann']]) {
      await db.run('INSERT INTO friendships (user_id, friend_user_id, created_at) VALUES (?, ?, 1)', id[a], id[b]);
    }
    await db.run("INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, 'accepted', 1)", id.ben, id.ann);
    await db.run("INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, 'accepted', 1)", id.cat, id.ann);
    await db.run('INSERT INTO direct_messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, 1)', id.ben, id.ann, 'unread from ben');
    await db.run('INSERT INTO direct_messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, 1)', id.cat, id.ann, 'unread from cat');

    assert.deepEqual(await blocks.block(id.ann, id.ben, 5000), { created: true, wereFriends: true });
    assert.deepEqual((await db.all('SELECT user_id, friend_user_id FROM friendships ORDER BY user_id')).map((r) => [r.user_id, r.friend_user_id]), [[id.ann, id.cat], [id.cat, id.ann]]);
    assert.deepEqual((await db.all('SELECT from_user_id FROM friend_requests')).map((r) => r.from_user_id), [id.cat]);
    // ben's unread message is marked read (no badge left behind); cat's is untouched.
    assert.deepEqual((await db.all('SELECT body, read_at FROM direct_messages ORDER BY id')).map((r) => [r.body, r.read_at]), [['unread from ben', 5000], ['unread from cat', null]]);
    await db.close();
  });

  test('unblocking drops a request that was withheld meanwhile, and only that', async () => {
    const { db, id, blocks } = await people();
    await blocks.block(id.ann, id.ben);
    await db.run("INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, 'withheld', 1)", id.ben, id.ann);
    await db.run("INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, 'pending', 1)", id.cat, id.ann);
    await blocks.unblock(id.ann, id.ben);
    assert.deepEqual((await db.all('SELECT from_user_id, status FROM friend_requests')).map((r) => [r.from_user_id, r.status]), [[id.cat, 'pending']]);
    await db.close();
  });
});
