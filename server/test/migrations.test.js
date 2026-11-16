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

    // The boot that picks 0014 up. Run through 0014 and no further: this is about what THAT
    // migration does, and a later one is free to add a column to a table that was here before it
    // (0015 does, and has its own test below).
    const boot = async () => { await runMigrations(db, MIGRATIONS.slice(0, upTo + 1)); await seedDemo(db); };
    await boot();
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
    await boot();
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM user_blocks')).n, 2, 'and keeps what the new tables hold');
    await db.close();
  });

  test('0015 (roles and categories) adds four tables and two empty columns, and changes no existing row', async () => {
    // A database as production has it the moment before this migration: everything up to 0014
    // applied and recorded, with servers, channels (one private, with a member on its list),
    // members of every built-in standing, and moderation records.
    const db = await freshDb();
    const upTo = MIGRATIONS.findIndex((m) => m.name === '0015_roles_and_categories');
    assert.ok(upTo > 0, 'the migration exists, after the ones already shipped');
    assert.equal(MIGRATIONS[upTo - 1].name, '0014_blocks_and_moderation', 'appended directly after 0014');
    await runMigrations(db, MIGRATIONS.slice(0, upTo));
    await seedDemo(db);
    await db.run("INSERT INTO users (username, email, password_hash, settings) VALUES ('ann', 'ann@example.com', 'hash', '{}'), ('ben', 'ben@example.com', 'hash', '{}'), ('cat', 'cat@example.com', 'hash', '{}')");
    await db.run("INSERT INTO servers (id, name, owner, app_room_epoch) VALUES ('srv-1', 'Crew', 'ann', 4)");
    await db.run("INSERT INTO channels (id, server_id, name, type, privacy) VALUES ('ch-1', 'srv-1', 'general', 'text', 'public'), ('ch-2', 'srv-1', 'staff', 'text', 'private'), ('ch-3', 'srv-1', 'Voice 1', 'voice', NULL)");
    await db.run("INSERT INTO server_members (server_id, username, role) VALUES ('srv-1', 'ann', 'owner'), ('srv-1', 'ben', 'admin'), ('srv-1', 'cat', 'member')");
    await db.run("INSERT INTO channel_members (server_id, channel_id, username) VALUES ('srv-1', 'ch-2', 'cat')");
    await db.run("INSERT INTO messages (server_id, channel_id, author, text, ts) VALUES ('srv-1', 'ch-2', 'cat', 'hello', 1700000000001)");
    await db.run("INSERT INTO server_bans (server_id, username, banned_by, banned_at) VALUES ('srv-1', 'dan', 'ann', 1700000000000)");
    await db.run("INSERT INTO server_audit (server_id, ts, actor, action, target) VALUES ('srv-1', 1700000000000, 'ann', 'member.ban', 'dan')");

    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name")).map((r) => r.name);
    const ADDED_TO_CHANNELS = ['category_id', 'position'];
    // Every existing table as it stands, with the two new channel columns left out of the
    // comparison (they are checked on their own, below).
    const snapshot = async () => {
      const out = {};
      for (const t of tables) {
        const columns = (await columnNames(db, t)).filter((c) => !(t === 'channels' && ADDED_TO_CHANNELS.includes(c)));
        out[t] = { columns, rows: await db.all(`SELECT ${columns.join(', ')} FROM ${t} ORDER BY rowid`) };
      }
      return out;
    };
    const before = await snapshot();
    assert.equal(before.channels.rows.length, 5, 'the two commons channels and the three of srv-1');
    assert.ok(!(await columnNames(db, 'channels')).includes('category_id'));

    // The boot that picks 0015 up. Run through 0015 and no further, as the 0014 test above does:
    // this is about what THAT migration does, and a later one is free to add a column to a table
    // that was here before it (0016 does, and has its own test below).
    const boot = async () => { await runMigrations(db, MIGRATIONS.slice(0, upTo + 1)); await seedDemo(db); };
    await boot();
    assert.deepEqual(await snapshot(), before, 'no existing row or column changed');
    assert.deepEqual((await columnNames(db, 'channels')).slice(-2), ADDED_TO_CHANNELS, 'channels gained exactly these, at the end');
    assert.deepEqual(
      await db.all('SELECT DISTINCT category_id, position FROM channels'), [{ category_id: null, position: null }],
      'every existing channel is in no category and has never been moved'
    );

    const NEW = {
      server_roles: ['id', 'server_id', 'name', 'color', 'position', 'permissions', 'created_at'],
      server_member_roles: ['server_id', 'username', 'role_id'],
      channel_roles: ['server_id', 'channel_id', 'role_id'],
      channel_categories: ['id', 'server_id', 'name', 'position'],
    };
    for (const [table, columns] of Object.entries(NEW)) {
      assert.ok(!tables.includes(table), `${table} is new`);
      assert.deepEqual(await columnNames(db, table), columns);
      assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0, `${table} starts empty: no server has a role or a category`);
    }
    // A member holds a role once, and a channel lists a role once.
    await db.run("INSERT INTO server_member_roles (server_id, username, role_id) VALUES ('srv-1', 'cat', 'role-1')");
    await assert.rejects(() => db.run("INSERT INTO server_member_roles (server_id, username, role_id) VALUES ('srv-1', 'cat', 'role-1')"));
    await db.run("INSERT INTO server_member_roles (server_id, username, role_id) VALUES ('srv-1', 'cat', 'role-2')");
    await db.run("INSERT INTO channel_roles (server_id, channel_id, role_id) VALUES ('srv-1', 'ch-2', 'role-1')");
    await assert.rejects(() => db.run("INSERT INTO channel_roles (server_id, channel_id, role_id) VALUES ('srv-1', 'ch-2', 'role-1')"));

    // The channel list is in the order it always was: the order the channels were created in.
    const { createChannels } = require('../services/channels');
    assert.deepEqual((await createChannels({ db }).listChannels('srv-1')).map((c) => [c.id, c.privacy, c.categoryId]), [
      ['ch-1', 'public', null], ['ch-2', 'private', null], ['ch-3', 'public', null],
    ]);

    // Running it again (a database that lost its migration record) changes nothing either.
    await db.exec('DROP TABLE schema_migrations');
    await boot();
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM server_member_roles')).n, 2, 'and keeps what the new tables hold');
    await db.close();
  });

  test('0016 (notification levels and link previews) adds two tables and one empty column per message table, and changes no existing row', async () => {
    // A database as production has it the moment before this migration: everything up to 0015
    // applied and recorded, with messages of all three kinds, read markers, blocks and roles.
    const db = await freshDb();
    const upTo = MIGRATIONS.findIndex((m) => m.name === '0016_notification_levels_and_link_previews');
    assert.ok(upTo > 0, 'the migration exists, after the ones already shipped');
    assert.equal(MIGRATIONS[upTo - 1].name, '0015_roles_and_categories', 'appended directly after 0015');
    await runMigrations(db, MIGRATIONS.slice(0, upTo));
    await seedDemo(db);
    await db.run("INSERT INTO users (username, email, password_hash, settings) VALUES ('ann', 'ann@example.com', 'hash', '{}'), ('ben', 'ben@example.com', 'hash', '{}'), ('cat', 'cat@example.com', 'hash', '{}')");
    await db.run("INSERT INTO servers (id, name, owner) VALUES ('srv-1', 'Crew', 'ann')");
    await db.run("INSERT INTO channels (id, server_id, name, type, privacy, category_id, position) VALUES ('ch-1', 'srv-1', 'general', 'text', 'public', NULL, 2), ('ch-2', 'srv-1', 'staff', 'text', 'private', 'cat-1', NULL)");
    await db.run("INSERT INTO channel_categories (id, server_id, name, position) VALUES ('cat-1', 'srv-1', 'Staff', 0)");
    await db.run("INSERT INTO server_members (server_id, username, role) VALUES ('srv-1', 'ann', 'owner'), ('srv-1', 'ben', 'member')");
    await db.run("INSERT INTO channel_reads (username, server_id, channel_id, last_read_ts) VALUES ('ben', 'srv-1', 'ch-1', 1700000000000)");
    await db.run(`INSERT INTO messages (server_id, channel_id, author, text, ts, attachment_json, reactions_json, quotes_json, pinned_at, pinned_by, edited_at)
      VALUES ('srv-1', 'ch-1', 'ben', 'see https://example.com/page', 1700000000001, NULL, '{"👍":["ann"]}', NULL, 1700000000002, 'ann', 1700000000003),
             ('srv-1', 'ch-1', 'ann', '', 1700000000004, '{"url":"/uploads/1-ab-shot.png","name":"shot.png"}', NULL, NULL, NULL, NULL, NULL)`);
    await db.run("INSERT INTO direct_messages (sender_id, recipient_id, body, created_at, read_at, quotes_json, edited_at) VALUES (1, 2, 'psst https://example.com/dm', 1700000000000, NULL, '[{\"id\":\"1\",\"author\":\"ben\",\"text\":\"hi\"}]', 1700000000009)");
    await db.run("INSERT INTO group_chats (id, name, owner_id, created_at) VALUES ('grp-1', 'Trio', 1, 1700000000000)");
    await db.run("INSERT INTO group_members (group_id, user_id, joined_at, last_read_at) VALUES ('grp-1', 1, 1700000000000, 5), ('grp-1', 2, 1700000000001, 6), ('grp-1', 3, 1700000000002, 7)");
    await db.run("INSERT INTO group_messages (group_id, sender_id, body, created_at, reactions_json) VALUES ('grp-1', 2, 'in the group https://example.com/g', 1700000000000, '{\"🎉\":[\"cat\"]}')");
    await db.run('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (3, 2, 1700000000000)');
    await db.run("INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, created_at) VALUES ('https://push.example.com/x', 'ben', 'p', 'a', 1700000000000)");

    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name")).map((r) => r.name);
    const GAINED = ['messages', 'direct_messages', 'group_messages'];
    // Every existing table as it stands, with the one new column of the three message tables left
    // out of the comparison (it is checked on its own, below).
    const snapshot = async () => {
      const out = {};
      for (const t of tables) {
        const columns = (await columnNames(db, t)).filter((c) => !(GAINED.includes(t) && c === 'preview_json'));
        out[t] = { columns, rows: await db.all(`SELECT ${columns.join(', ')} FROM ${t} ORDER BY rowid`) };
      }
      return out;
    };
    const before = await snapshot();
    assert.equal(before.messages.rows.length, 2);
    for (const t of GAINED) assert.ok(!(await columnNames(db, t)).includes('preview_json'));

    // The boot that picks 0016 up. Run through 0016 and no further, as the 0015 test above does:
    // a later migration is free to add a column to a table that was here before it (0017 adds one
    // to users, and has its own test below).
    const boot = async () => { await runMigrations(db, MIGRATIONS.slice(0, upTo + 1)); await seedDemo(db); };
    await boot();
    assert.deepEqual(await snapshot(), before, 'no existing row or column changed');
    for (const t of GAINED) {
      assert.equal((await columnNames(db, t)).at(-1), 'preview_json', `${t} gained exactly this, at the end`);
      assert.deepEqual(await db.all(`SELECT DISTINCT preview_json FROM ${t}`), [{ preview_json: null }], `no existing row of ${t} has a preview`);
    }

    const NEW = {
      notification_settings: ['user_id', 'scope', 'target', 'server_id', 'level', 'updated_at'],
      link_previews: ['url', 'status', 'data', 'fetched_at', 'expires_at'],
    };
    for (const [table, columns] of Object.entries(NEW)) {
      assert.ok(!tables.includes(table), `${table} is new`);
      assert.deepEqual(await columnNames(db, table), columns);
      assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0, `${table} starts empty: nobody has changed a level, and nothing has been fetched`);
    }
    // One setting per person per thing, and one cache row per URL.
    await db.run("INSERT INTO notification_settings (user_id, scope, target, server_id, level, updated_at) VALUES (2, 'channel', 'ch-1', 'srv-1', 'all', 1)");
    await assert.rejects(() => db.run("INSERT INTO notification_settings (user_id, scope, target, server_id, level, updated_at) VALUES (2, 'channel', 'ch-1', 'srv-1', 'none', 2)"));
    await db.run("INSERT INTO notification_settings (user_id, scope, target, server_id, level, updated_at) VALUES (2, 'server', 'srv-1', 'srv-1', 'none', 1), (3, 'channel', 'ch-1', 'srv-1', 'none', 1), (2, 'dm', '1', NULL, 'none', 1)");
    await db.run("INSERT INTO link_previews (url, status, data, fetched_at, expires_at) VALUES ('https://example.com/page', 'ok', '{}', 1, 2)");
    await assert.rejects(() => db.run("INSERT INTO link_previews (url, status, data, fetched_at, expires_at) VALUES ('https://example.com/page', 'none', NULL, 3, 4)"));

    // With nothing set, everyone is where they were before levels existed.
    const { createNotificationSettings, effectiveChannelLevel } = require('../services/notificationSettings');
    const settings = createNotificationSettings({ db });
    assert.deepEqual(await settings.settingsOf(1), { servers: {}, channels: {}, dms: {}, groups: {} });
    assert.equal(effectiveChannelLevel(await settings.settingsOf(1), 'srv-1', 'ch-1'), 'mentions');
    assert.deepEqual(await settings.settingsOf(2), { servers: { 'srv-1': 'none' }, channels: { 'srv-1': { 'ch-1': 'all' } }, dms: { 1: true }, groups: {} });
    assert.deepEqual([...await settings.channelLevels('srv-1', 'ch-1')].sort(), [['ben', 'all'], ['cat', 'none']], 'a channel\'s own level wins over the server\'s');
    assert.deepEqual([...await settings.channelLevels('srv-1', 'ch-2')], [['ben', 'none']], 'and a channel with none follows the server');
    // The old messages read back exactly as they did, with no preview.
    const { createMessages } = require('../services/messages');
    const { channelHistory } = require('../services/history');
    const source = channelHistory('srv-1', 'ch-1');
    const rows = await db.all(`SELECT ${source.columns} FROM ${source.from} WHERE ${source.where} ORDER BY id`, ...source.params);
    const mapped = rows.map((r) => createMessages({ db }).mapMessageRow(r, 'ann'));
    assert.deepEqual(mapped.map((m) => [m.text, 'preview' in m, m.pinnedBy, m.edited]), [['see https://example.com/page', false, 'ann', true], ['', false, null, false]]);

    // Running it again (a database that lost its migration record) changes nothing either.
    await db.exec('DROP TABLE schema_migrations');
    await boot();
    assert.deepEqual(await snapshot(), before);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM notification_settings')).n, 4, 'and keeps what the new tables hold');
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM link_previews')).n, 1);
    await db.close();
  });

  test('0017 (two-factor and email verification) marks every existing account verified, turns two-factor on for nobody, and changes nothing else', async () => {
    // A database as production has it the moment before this migration: everything up to 0016
    // applied and recorded, with accounts, a pending password reset and some messages.
    const db = await freshDb();
    const upTo = MIGRATIONS.findIndex((m) => m.name === '0017_two_factor_and_email_verification');
    assert.ok(upTo > 0, 'the migration exists, after the ones already shipped');
    assert.equal(MIGRATIONS[upTo - 1].name, '0016_notification_levels_and_link_previews', 'appended directly after 0016');
    await runMigrations(db, MIGRATIONS.slice(0, upTo));
    await seedDemo(db);
    await db.run("INSERT INTO users (username, email, password_hash, settings, presence_status) VALUES ('ann', 'ann@example.com', 'hash-a', '{\"profile\":{}}', 'away'), ('ben', 'ben@example.com', 'hash-b', '{}', 'offline'), ('cat', NULL, 'hash-c', NULL, NULL)");
    await db.run("INSERT INTO auth_tokens (token, user_id, purpose, expires_at) VALUES ('reset-token', 1, 'reset', 1900000000000)");
    await db.run("INSERT INTO revoked_tokens (token, expires_at) VALUES ('old-session', 1900000000000)");
    await db.run("INSERT INTO messages (server_id, channel_id, author, text, ts) VALUES ('demo', 'general', 'ann', 'hello', 1700000000000)");
    await db.run("INSERT INTO direct_messages (sender_id, recipient_id, body, created_at) VALUES (1, 2, 'psst', 1700000000000)");
    await db.run('INSERT INTO friendships (user_id, friend_user_id, created_at) VALUES (1, 2, 1700000000000), (2, 1, 1700000000000)');
    assert.equal((await columnNames(db, 'users')).includes('email_verified'), false, 'the column is new');

    const usersBefore = await db.all('SELECT id, username, email, password_hash, settings, presence_status FROM users ORDER BY id');
    const others = ['auth_tokens', 'revoked_tokens', 'messages', 'direct_messages', 'friendships', 'servers', 'channels'];
    const snapshot = async () => Object.fromEntries(await Promise.all(others.map(async (t) => [t, await db.all(`SELECT * FROM ${t} ORDER BY rowid`)])));
    const before = await snapshot();

    assert.deepEqual(await runMigrations(db, MIGRATIONS.slice(0, upTo + 1)), ['0017_two_factor_and_email_verification']);

    // Grandfathering: everyone who had an account is verified, whatever their row looked like.
    assert.deepEqual(await db.all('SELECT username, email_verified FROM users ORDER BY id'), [
      { username: 'ann', email_verified: 1 }, { username: 'ben', email_verified: 1 }, { username: 'cat', email_verified: 1 },
    ]);
    assert.deepEqual(await db.all('SELECT id, username, email, password_hash, settings, presence_status FROM users ORDER BY id'), usersBefore, 'and nothing else about them changed');
    assert.deepEqual(await snapshot(), before, 'no other table was touched');

    // Two-factor: the tables exist and are empty, so nobody is asked for a code they never set up.
    for (const table of ['user_two_factor', 'two_factor_recovery_codes', 'login_tickets']) {
      assert.equal((await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n, 0, table);
    }
    assert.deepEqual(await columnNames(db, 'user_two_factor'), ['user_id', 'secret_enc', 'enabled_at', 'pending_enc', 'pending_expires_at', 'last_step', 'failures', 'locked_until']);
    assert.deepEqual(await columnNames(db, 'two_factor_recovery_codes'), ['user_id', 'code_hash', 'used_at']);
    assert.deepEqual(await columnNames(db, 'login_tickets'), ['jti', 'user_id', 'expires_at', 'failures']);

    // An account inserted from now on without saying otherwise is NOT verified: the default fails
    // closed, and only the registration route (which knows whether there is a mailer) decides.
    await db.run("INSERT INTO users (username, email, password_hash, settings) VALUES ('dee', 'dee@example.com', 'hash-d', '{}')");
    assert.equal((await db.get("SELECT email_verified FROM users WHERE username = 'dee'")).email_verified, 0);

    // Running it again (a database that lost its migration record) must not verify dee, who
    // signed up after the migration: the grandfathering happens once, when the column is added.
    await db.run("INSERT INTO user_two_factor (user_id, secret_enc, enabled_at) VALUES (1, 'v1.x.y.z', 1700000000000)");
    await db.exec('DROP TABLE schema_migrations');
    await migrate(db);
    assert.equal((await db.get("SELECT email_verified FROM users WHERE username = 'dee'")).email_verified, 0);
    assert.equal((await db.get("SELECT email_verified FROM users WHERE username = 'ann'")).email_verified, 1);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM user_two_factor')).n, 1, 'and keeps what the new tables hold');
    await db.close();
  });

  test('0018 (GIF library search) adds empty tags and no hash to every GIF, and changes nothing else', async () => {
    const db = await freshDb();
    const upTo = MIGRATIONS.findIndex((m) => m.name === '0018_gif_library_search');
    assert.equal(MIGRATIONS[upTo - 1].name, '0017_two_factor_and_email_verification', 'appended directly after 0017');
    assert.equal(upTo, MIGRATIONS.length - 1, 'and it is the one new migration');
    await runMigrations(db, MIGRATIONS.slice(0, upTo));
    await db.run("INSERT INTO gifs (name, url, type, created_by, created_at) VALUES ('wave', '/gifs/1-a.gif', 'image/gif', 'ann', 1700000000000), ('nope', '/gifs/2-b.png', 'image/png', 'ben', 1700000000001)");
    const before = await db.all('SELECT id, name, url, type, created_by, created_at FROM gifs ORDER BY id');

    assert.deepEqual(await runMigrations(db, MIGRATIONS), ['0018_gif_library_search']);
    assert.deepEqual(await db.all('SELECT id, name, url, type, created_by, created_at FROM gifs ORDER BY id'), before);
    assert.deepEqual(await db.all('SELECT tags, sha256 FROM gifs ORDER BY id'), [{ tags: '', sha256: null }, { tags: '', sha256: null }]);
    // Run again (a lost migration record): nothing breaks and nothing changes.
    await db.exec('DROP TABLE schema_migrations');
    await migrate(db);
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM gifs')).n, 2);
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
