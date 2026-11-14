// Unit tests for the migration runner (db/migrate.js) and the schema it applies (db/schema.js).
// Uses an in-memory SQLite DB so nothing touches disk.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { migrate, MIGRATIONS, seedDemo } = require('../db/schema');
const { addColumn, runMigrations } = require('../db/migrate');

const freshDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
const columnNames = async (db, table) => (await db.all(`PRAGMA table_info(${table})`)).map((c) => c.name);

describe('schema migrations', () => {
  test('a fresh database gets every table, column and the demo seed', async () => {
    const db = await freshDb();
    await migrate(db);

    const applied = (await db.all('SELECT name FROM schema_migrations ORDER BY name')).map((r) => r.name);
    assert.deepEqual(applied, MIGRATIONS.map((m) => m.name), 'all migrations recorded');

    // Columns added by 0002 must be present on a fresh DB (base tables + later ALTERs).
    const msg = await columnNames(db, 'messages');
    for (const c of ['attachment_json', 'reactions_json', 'quotes_json', 'pinned_at', 'pinned_by']) {
      assert.ok(msg.includes(c), `messages.${c} should exist`);
    }
    assert.ok((await columnNames(db, 'users')).includes('presence_status'));
    assert.ok((await columnNames(db, 'channels')).includes('privacy'));

    const demo = await db.get("SELECT id FROM servers WHERE id = 'demo'");
    assert.ok(demo, 'demo server seeded');
    const chans = await db.all("SELECT id FROM channels WHERE server_id = 'demo' ORDER BY id");
    assert.deepEqual(chans.map((c) => c.id).sort(), ['general', 'voice1']);
    await db.close();
  });

  test('running migrate twice is a no-op (idempotent, no duplicate records)', async () => {
    const db = await freshDb();
    await migrate(db);
    await migrate(db); // must not throw or double-apply
    const count = await db.get('SELECT COUNT(*) AS n FROM schema_migrations');
    assert.equal(count.n, MIGRATIONS.length);
    await db.close();
  });

  test('adopts an existing database that has the schema but no migration record', async () => {
    // Simulate the production DB at deploy time: full schema already present (from the old
    // ALTER-in-try/catch era), but schema_migrations doesn't exist yet.
    const db = await freshDb();
    await migrate(db);
    await db.exec('DROP TABLE schema_migrations');

    const ran = await runMigrations(db, MIGRATIONS); // should re-run as no-ops, no error
    assert.deepEqual(ran, MIGRATIONS.map((m) => m.name), 'baseline re-recorded');
    // Data survived (CREATE IF NOT EXISTS / addColumn skipped, didn't drop anything).
    assert.ok(await db.get("SELECT id FROM servers WHERE id = 'demo'"), 'demo still present');
    await db.close();
  });

  test('0014 (blocks and moderation) adds its four tables and leaves every existing row as it was', async () => {
    // A database as production has it the moment before this migration: everything up to 0013
    // applied and recorded, with data in the tables the new features sit next to.
    const db = await freshDb();
    const upTo = MIGRATIONS.findIndex((m) => m.name === '0014_blocks_and_moderation');
    assert.ok(upTo > 0, 'the migration exists, after the ones already shipped');
    assert.equal(MIGRATIONS[upTo - 1].name, '0013_app_room_epoch', 'appended directly after 0013');
    await runMigrations(db, MIGRATIONS.slice(0, upTo));
    await seedDemo(db);
    await db.run("INSERT INTO users (username, email, password_hash, settings, presence_status) VALUES ('ann', 'ann@example.com', 'hash', '{\"profile\":{}}', 'away')");
    await db.run("INSERT INTO users (username, email, password_hash, settings) VALUES ('ben', 'ben@example.com', 'hash', '{}')");
    await db.run("INSERT INTO servers (id, name, owner, icon_url, app_room_epoch) VALUES ('srv-1', 'Crew', 'ann', '/tile-icons/x.png', 3)");
    await db.run("INSERT INTO channels (id, server_id, name, type, privacy) VALUES ('ch-1', 'srv-1', 'general', 'text', 'private')");
    await db.run("INSERT INTO server_members (server_id, username, role) VALUES ('srv-1', 'ann', 'owner'), ('srv-1', 'ben', 'member')");
    await db.run("INSERT INTO channel_members (server_id, channel_id, username) VALUES ('srv-1', 'ch-1', 'ben')");
    await db.run("INSERT INTO server_removed (server_id, username, removed_by, removed_at) VALUES ('srv-1', 'cat', 'ann', 1700000000000)");
    await db.run("INSERT INTO server_invites (code, server_id, created_by, created_at, uses) VALUES ('abcdefghijkl', 'srv-1', 'ann', 1700000000000, 2)");
    await db.run("INSERT INTO messages (server_id, channel_id, author, text, ts, pinned_at, pinned_by, edited_at) VALUES ('srv-1', 'ch-1', 'ben', 'hello', 1700000000001, 1700000000002, 'ann', 1700000000003)");
    await db.run("INSERT INTO friendships (user_id, friend_user_id, created_at) VALUES (1, 2, 1700000000000), (2, 1, 1700000000000)");
    await db.run("INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (1, 2, 'accepted', 1700000000000)");
    await db.run("INSERT INTO direct_messages (sender_id, recipient_id, body, created_at) VALUES (1, 2, 'psst', 1700000000000)");
    await db.run("INSERT INTO group_chats (id, name, owner_id, created_at) VALUES ('grp-1', 'Trio', 1, 1700000000000)");
    await db.run("INSERT INTO group_members (group_id, user_id, joined_at, last_read_at) VALUES ('grp-1', 1, 1700000000000, 5), ('grp-1', 2, 1700000000001, 6)");
    await db.run("INSERT INTO group_messages (group_id, sender_id, body, created_at) VALUES ('grp-1', 2, 'in the group', 1700000000000)");

    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name")).map((r) => r.name);
    const snapshot = async () => {
      const out = {};
      for (const t of tables) out[t] = { columns: await columnNames(db, t), rows: await db.all(`SELECT * FROM ${t} ORDER BY rowid`) };
      return out;
    };
    const before = await snapshot();
    assert.equal(before.messages.rows.length, 1);

    await migrate(db); // the boot that picks 0014 up
    assert.deepEqual(await snapshot(), before, 'no existing table gained, lost or changed anything');

    const applied = (await db.all('SELECT name FROM schema_migrations')).map((r) => r.name);
    assert.ok(applied.includes('0014_blocks_and_moderation'));
    const NEW = {
      user_blocks: ['blocker_id', 'blocked_id', 'created_at'],
      server_bans: ['server_id', 'username', 'banned_by', 'reason', 'banned_at'],
      server_timeouts: ['server_id', 'username', 'until', 'timed_out_by', 'reason', 'created_at'],
      server_audit: ['id', 'server_id', 'ts', 'actor', 'action', 'target', 'detail'],
    };
    for (const [table, columns] of Object.entries(NEW)) {
      assert.ok(!tables.includes(table), `${table} is new`);
      assert.deepEqual(await columnNames(db, table), columns);
      assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0, `${table} starts empty`);
    }
    // One block per pair and per direction, one ban and one timeout per person per server.
    await db.run('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (1, 2, 1)');
    await assert.rejects(() => db.run('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (1, 2, 2)'));
    await db.run('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (2, 1, 1)');
    await db.run("INSERT INTO server_bans (server_id, username, banned_at) VALUES ('srv-1', 'cat', 1)");
    await assert.rejects(() => db.run("INSERT INTO server_bans (server_id, username, banned_at) VALUES ('srv-1', 'cat', 2)"));
    await db.run("INSERT INTO server_timeouts (server_id, username, until, created_at) VALUES ('srv-1', 'ben', 9, 1)");
    await assert.rejects(() => db.run("INSERT INTO server_timeouts (server_id, username, until, created_at) VALUES ('srv-1', 'ben', 10, 2)"));

    // Running it again (a database that lost its migration record) changes nothing either.
    await db.exec('DROP TABLE schema_migrations');
    await migrate(db);
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM user_blocks')).n, 2, 'and keeps what the new tables hold');
    await db.close();
  });

  test('only pending migrations run on the next boot', async () => {
    const db = await freshDb();
    await migrate(db);
    let extraRan = false;
    const withExtra = [...MIGRATIONS, { name: '9999_probe', up: async () => { extraRan = true; } }];
    const ran = await runMigrations(db, withExtra);
    assert.deepEqual(ran, ['9999_probe'], 'only the new migration runs');
    assert.ok(extraRan);
    await db.close();
  });
});

describe('addColumn', () => {
  test('adds a missing column once, then reports it already exists', async () => {
    const db = await freshDb();
    await db.exec('CREATE TABLE t (id INTEGER)');
    assert.equal(await addColumn(db, 't', 'note', 'TEXT'), true, 'added the first time');
    assert.equal(await addColumn(db, 't', 'note', 'TEXT'), false, 'skipped the second time');
    assert.ok((await columnNames(db, 't')).includes('note'));
    await db.close();
  });

  test('surfaces a real error instead of swallowing it (unlike the old try/catch)', async () => {
    const db = await freshDb();
    await assert.rejects(() => addColumn(db, 'no_such_table', 'x', 'TEXT'));
    await db.close();
  });
});
