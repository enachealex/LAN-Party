// @ts-check
// The database schema, expressed as an ordered list of named migrations run by db/migrate.js.
//
// Adding a schema change = append a new migration to MIGRATIONS (never edit an already-shipped one,
// or existing databases won't pick it up). The whole thing is idempotent and safe to run against an
// already-populated database: on first boot after this change lands, the baseline migrations run as
// no-ops (tables already exist, columns already present) and get recorded, so later boots skip them.

const { addColumn, runMigrations } = require('./migrate');

/** @typedef {import('./migrate').Db} Db */

/** @type {import('./migrate').Migration[]} */
const MIGRATIONS = [
  {
    name: '0001_core_tables',
    up: async (db) => {
      await db.exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password_hash TEXT,
        settings TEXT
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        server_id TEXT,
        name TEXT,
        type TEXT
      )`);
      // Server membership + roles: owner | admin | member. The default 'demo' server is public
      // (every user is an implicit member) — user-created servers are members-only.
      await db.exec(`CREATE TABLE IF NOT EXISTS server_members (
        server_id TEXT,
        username TEXT,
        role TEXT DEFAULT 'member',
        PRIMARY KEY (server_id, username)
      )`);
      // Explicit access grants for PRIVATE channels: visible to owner/admins plus listed usernames.
      await db.exec(`CREATE TABLE IF NOT EXISTS channel_members (
        server_id TEXT,
        channel_id TEXT,
        username TEXT,
        PRIMARY KEY (server_id, channel_id, username)
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT,
        channel_id TEXT,
        author TEXT,
        text TEXT,
        ts INTEGER
      )`);
      // Saved music queues, per user (Music activity "playlists").
      await db.exec(`CREATE TABLE IF NOT EXISTS music_playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        name TEXT NOT NULL,
        tracks_json TEXT NOT NULL,
        updated_at INTEGER
      )`);
      // Per-user channel read markers — unread count = messages newer than last_read_ts.
      await db.exec(`CREATE TABLE IF NOT EXISTS channel_reads (
        username TEXT,
        server_id TEXT,
        channel_id TEXT,
        last_read_ts INTEGER DEFAULT 0,
        PRIMARY KEY (username, server_id, channel_id)
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS revoked_tokens (
        token TEXT PRIMARY KEY,
        expires_at INTEGER
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS friend_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL,
        to_user_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        UNIQUE(from_user_id, to_user_id)
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS friendships (
        user_id INTEGER NOT NULL,
        friend_user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, friend_user_id)
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS direct_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        recipient_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS server_emojis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(server_id, name)
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        url TEXT,
        icon_url TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL
      )`);
      // Shared GIF library: any user can add, everyone can use in any channel/DM.
      await db.exec(`CREATE TABLE IF NOT EXISTS gifs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        type TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL
      )`);
      // Shared soundboard: any user can add a clip, everyone can trigger it.
      await db.exec(`CREATE TABLE IF NOT EXISTS sounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        emoji TEXT,
        color TEXT,
        url TEXT NOT NULL,
        type TEXT,
        created_by TEXT,
        created_at INTEGER NOT NULL
      )`);
      // Short-lived one-time tokens for password reset + account-deactivation confirmation.
      await db.exec(`CREATE TABLE IF NOT EXISTS auth_tokens (
        token TEXT PRIMARY KEY,
        user_id INTEGER,
        purpose TEXT,
        expires_at INTEGER
      )`);
      // Audit trail for user-submitted feedback / bug reports. Every submission is stored (so it's
      // never lost if Vaultline is down), then forwarded; status tracks the outcome.
      await db.exec(`CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        email TEXT,
        type TEXT,
        title TEXT,
        message TEXT,
        diagnostics TEXT,
        screenshot_url TEXT,
        status TEXT,
        issue_key TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      )`);
    },
  },
  {
    // Columns added to the base tables after their initial ship. Each is skipped if already present.
    name: '0002_message_and_profile_columns',
    up: async (db) => {
      await addColumn(db, 'messages', 'attachment_json', 'TEXT');
      await addColumn(db, 'direct_messages', 'attachment_json', 'TEXT');
      await addColumn(db, 'users', 'presence_status', `TEXT DEFAULT 'offline'`);
      // Channel privacy: 'public' (everyone in the server) or 'private' (owner/admins only).
      await addColumn(db, 'channels', 'privacy', `TEXT DEFAULT 'public'`);
      // Server owner (creator). NULL for the public 'demo' server.
      await addColumn(db, 'servers', 'owner', 'TEXT');
      // Persisted reactions, stored as JSON { "👍": ["alice","bob"], ... } per message.
      await addColumn(db, 'messages', 'reactions_json', 'TEXT');
      await addColumn(db, 'direct_messages', 'reactions_json', 'TEXT');
      // Quoted replies (Teams-style): JSON array [{ id, author, ts, text }] per message.
      await addColumn(db, 'messages', 'quotes_json', 'TEXT');
      await addColumn(db, 'direct_messages', 'quotes_json', 'TEXT');
      // Pinned channel messages: pinned_at (ms, NULL = not pinned) + who pinned it.
      await addColumn(db, 'messages', 'pinned_at', 'INTEGER');
      await addColumn(db, 'messages', 'pinned_by', 'TEXT');
    },
  },
];

/**
 * Seed the default public 'demo' server + its channels. Data (not schema), and idempotent, so it
 * runs after migrations rather than as one.
 * @param {Db} db
 */
async function seedDemo(db) {
  const demo = await db.get('SELECT id FROM servers WHERE id = ?', 'demo');
  if (!demo) {
    await db.run('INSERT INTO servers (id, name) VALUES (?, ?)', 'demo', 'LAN Party');
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', 'general', 'demo', 'general', 'text');
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', 'voice1', 'demo', 'Voice 1', 'voice');
  }
}

/**
 * Bring the database up to date: run pending migrations, then seed the demo server.
 * @param {Db} db
 */
async function migrate(db) {
  const ran = await runMigrations(db, MIGRATIONS);
  if (ran.length) console.log('[db] applied migrations:', ran.join(', '));
  await seedDemo(db);
}

module.exports = { migrate, MIGRATIONS, seedDemo };
