// Unit tests for the migration runner (db/migrate.js) and the schema it applies (db/schema.js).
// Uses an in-memory SQLite DB so nothing touches disk.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { migrate, MIGRATIONS } = require('../db/schema');
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
