// @ts-check
// Database schema: table creation, additive column migrations, and the seed for the default
// public server. Split out of index.js so the boot sequence stays readable and the schema has a
// single home.
//
// Columns are added inside try/catch because SQLite has no `ADD COLUMN IF NOT EXISTS` — a
// rejection here normally just means the column is already present.

/**
 * Create tables, apply additive migrations, and seed the demo server.
 * @param {{
 *   exec: (sql: string) => Promise<any>,
 *   run: (sql: string, ...params: any[]) => Promise<any>,
 *   get: (sql: string, ...params: any[]) => Promise<any>,
 * }} db
 */
async function migrate(db) {
  // Create tables
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
  // Server membership + roles: owner | admin | member. The default 'demo' server is public (every
  // user is an implicit member) — user-created servers are members-only.
  await db.exec(`CREATE TABLE IF NOT EXISTS server_members (
    server_id TEXT,
    username TEXT,
    role TEXT DEFAULT 'member',
    PRIMARY KEY (server_id, username)
  )`);
  // Explicit access grants for PRIVATE channels. A private channel is visible to owner/admins
  // (who manage the server) plus any username listed here.
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
  // Audit trail for user-submitted feedback / bug reports. Every submission is stored here (so it's
  // never lost if Vaultline is down), then forwarded to Vaultline; status tracks the outcome.
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
  try {
    await db.run(`ALTER TABLE messages ADD COLUMN attachment_json TEXT`);
  } catch (err) {
    /* column already exists */
  }
  try {
    await db.run(`ALTER TABLE direct_messages ADD COLUMN attachment_json TEXT`);
  } catch (err) {
    /* column already exists */
  }
  try {
    await db.run(`ALTER TABLE users ADD COLUMN presence_status TEXT DEFAULT 'offline'`);
  } catch (err) {
    /* column already exists */
  }
  // Channel privacy: 'public' (everyone in the server) or 'private' (owner/admins only).
  try {
    await db.run(`ALTER TABLE channels ADD COLUMN privacy TEXT DEFAULT 'public'`);
  } catch (err) {
    /* column already exists */
  }
  // Server owner (creator). NULL for the public 'demo' server.
  try {
    await db.run(`ALTER TABLE servers ADD COLUMN owner TEXT`);
  } catch (err) {
    /* column already exists */
  }
  // Persisted reactions, stored as JSON { "👍": ["alice","bob"], ... } per message.
  try {
    await db.run(`ALTER TABLE messages ADD COLUMN reactions_json TEXT`);
  } catch (err) {
    /* column already exists */
  }
  try {
    await db.run(`ALTER TABLE direct_messages ADD COLUMN reactions_json TEXT`);
  } catch (err) {
    /* column already exists */
  }
  // Quoted replies (Teams-style): JSON array [{ id, author, ts, text }] per message.
  try {
    await db.run(`ALTER TABLE messages ADD COLUMN quotes_json TEXT`);
  } catch (err) {
    /* column already exists */
  }
  try {
    await db.run(`ALTER TABLE direct_messages ADD COLUMN quotes_json TEXT`);
  } catch (err) {
    /* column already exists */
  }
  // Pinned channel messages: pinned_at (ms, NULL = not pinned) + who pinned it.
  try {
    await db.run(`ALTER TABLE messages ADD COLUMN pinned_at INTEGER`);
  } catch (err) {
    /* column already exists */
  }
  try {
    await db.run(`ALTER TABLE messages ADD COLUMN pinned_by TEXT`);
  } catch (err) {
    /* column already exists */
  }

  // Seed demo server and channels if missing
  const demo = await db.get('SELECT id FROM servers WHERE id = ?', 'demo');
  if (!demo) {
    await db.run('INSERT INTO servers (id, name) VALUES (?, ?)', 'demo', 'LAN Party');
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', 'general', 'demo', 'general', 'text');
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', 'voice1', 'demo', 'Voice 1', 'voice');
  }
}

module.exports = { migrate };
