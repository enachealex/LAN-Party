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
  {
    // Apps can be an external link (kind='link', the original behaviour) or an uploaded, LAN-Party-
    // hosted bundle (kind='bundle') whose files live in DATA_DIR/app-bundles/<bundle_dir>.
    name: '0003_app_bundles',
    up: async (db) => {
      await addColumn(db, 'apps', 'kind', `TEXT DEFAULT 'link'`);
      await addColumn(db, 'apps', 'bundle_dir', 'TEXT');
    },
  },
  {
    // Custom server tile icon (a /tile-icons/<file> url). Shared: set by owner/admin, seen by every
    // member, so it belongs on the server row rather than in each viewer's settings. NULL = fall back
    // to the coloured initials. The per-user Home tile image is settings.homeTileUrl instead.
    name: '0004_server_icon',
    up: async (db) => {
      await addColumn(db, 'servers', 'icon_url', 'TEXT');
    },
  },
  {
    // When a message was last edited (ms), NULL if never. Lets "(edited)" survive a reload and tells
    // other clients the text they have is stale.
    name: '0005_message_edits',
    up: async (db) => {
      await addColumn(db, 'messages', 'edited_at', 'INTEGER');
      await addColumn(db, 'direct_messages', 'edited_at', 'INTEGER');
    },
  },
  {
    // Group chats: a named conversation between 3+ people, stored on the server like DMs (they used
    // to exist only in the creator's browser tab). Ids are 'grp-…' strings so they can never collide
    // with a DM's key (the peer's numeric user id) in the client's per-conversation maps.
    // last_read_at is per member: unread = messages from others newer than it.
    name: '0006_group_chats',
    up: async (db) => {
      await db.exec(`CREATE TABLE IF NOT EXISTS group_chats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '',
        owner_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`);
      await db.exec(`CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        joined_at INTEGER NOT NULL,
        last_read_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, user_id)
      )`);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members (user_id)');
      await db.exec(`CREATE TABLE IF NOT EXISTS group_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id TEXT NOT NULL,
        sender_id INTEGER NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        attachment_json TEXT,
        reactions_json TEXT,
        quotes_json TEXT,
        edited_at INTEGER
      )`);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_group_messages_group ON group_messages (group_id, created_at)');
    },
  },
  {
    // Shareable invite links: a server admin hands out a URL instead of adding people by exact
    // username. The code IS the credential (random, unguessable), so it is the primary key and is
    // never derived from anything. expires_at / max_uses are NULL for "never" / "unlimited".
    // Revoking sets revoked_at rather than deleting the row, so the record of who minted a link
    // survives; a revoked code is refused exactly like one that never existed.
    name: '0007_server_invites',
    up: async (db) => {
      await db.exec(`CREATE TABLE IF NOT EXISTS server_invites (
        code TEXT PRIMARY KEY,
        server_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        max_uses INTEGER,
        uses INTEGER NOT NULL DEFAULT 0,
        revoked_at INTEGER
      )`);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_server_invites_server ON server_invites (server_id)');
    },
  },
  {
    // Web Push subscriptions: one row per browser/device that asked for notifications while the app
    // is closed. The endpoint is the push service's URL for that browser, unique to it and a secret
    // in its own right, so it is the primary key: the same browser subscribing again (or a second
    // person signing in on it) replaces the row instead of adding one. Keyed to the username like
    // the other per-user tables, so a rename has to carry it along (POST /user/username).
    // last_success_at is NULL until a push has actually been accepted for delivery.
    name: '0008_push_subscriptions',
    up: async (db) => {
      await db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at INTEGER NOT NULL,
        last_success_at INTEGER
      )`);
      await db.exec('CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (username)');
    },
  },
  {
    // People a server's staff removed. Until invite links existed, being kicked was final until
    // staff added the username again; with links, anyone holding a live one could walk straight back
    // in. A row here is what a link checks before it admits someone (routes/invites.js). It is
    // cleared when staff invite that username by hand, and never written when someone leaves of
    // their own accord. removed_by / removed_at are a record only; nothing reads them.
    name: '0009_server_removed',
    up: async (db) => {
      await db.exec(`CREATE TABLE IF NOT EXISTS server_removed (
        server_id TEXT NOT NULL,
        username TEXT NOT NULL,
        removed_by TEXT,
        removed_at INTEGER NOT NULL,
        PRIMARY KEY (server_id, username)
      )`);
    },
  },
  {
    // History is read a page at a time now (services/history.js): "the 50 messages of this
    // conversation just below id N". Without an index that leads with the conversation and ends in
    // the id, every page is a scan of the whole table, which is the cost paging exists to avoid.
    // Direct messages need both orders of the pair, since a conversation is the rows sent either way.
    // group_messages already had (group_id, created_at), but pages walk by id, not by time.
    name: '0010_history_paging_indexes',
    up: async (db) => {
      await db.exec('CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages (server_id, channel_id, id)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_direct_messages_sent ON direct_messages (sender_id, recipient_id, id)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_direct_messages_received ON direct_messages (recipient_id, sender_id, id)');
      await db.exec('CREATE INDEX IF NOT EXISTS idx_group_messages_group_id ON group_messages (group_id, id)');
    },
  },
  {
    // Publish approval for the app directory: an upload is a 'draft' only its uploader (and the
    // instance owners) can see until an instance owner publishes it. status is one of
    // 'draft' | 'pending' | 'published' | 'rejected'; the transitions live in routes/library.js.
    //
    // The column's own default is 'draft', so an insert that forgets to say is hidden, not public.
    // Every app that exists when this runs was already visible to everyone, and stays that way: they
    // are marked 'published' once, at the moment the column is created. The two steps share a
    // transaction because apart they are not safe to repeat — a crash between them would leave the
    // column in place, and the next boot (which only fills it in when it has just added it) would
    // leave every existing app hidden. Tied to the column being new, rather than run every time, so
    // that re-running this on a database that has lost its migration record cannot publish drafts.
    //
    // review_note is the instance owner's optional message on a rejection; reviewed_by/reviewed_at
    // record the last decision and submitted_at the last request for one.
    name: '0011_app_publish_approval',
    up: async (db) => {
      await db.exec('BEGIN');
      try {
        if (await addColumn(db, 'apps', 'status', `TEXT NOT NULL DEFAULT 'draft'`)) {
          await db.run(`UPDATE apps SET status = 'published'`);
        }
        await db.exec('COMMIT');
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => {});
        throw e;
      }
      await addColumn(db, 'apps', 'review_note', 'TEXT');
      await addColumn(db, 'apps', 'reviewed_by', 'TEXT');
      await addColumn(db, 'apps', 'reviewed_at', 'INTEGER');
      await addColumn(db, 'apps', 'submitted_at', 'INTEGER');
    },
  },
  {
    // "Run inside LAN Party" for a link app: with embed = 1 the app is HOSTED — framed on its own
    // origin in the viewer and startable in a voice room like a bundle, instead of only opening in a
    // new tab (services/hostedApps.js). 0 for every app that exists when this runs, so a link that
    // was approved as a link stays one; turning it on is an edit, and goes through review.
    // Meaningless for a bundle, where it stays 0.
    name: '0012_app_embed',
    up: async (db) => {
      await addColumn(db, 'apps', 'embed', 'INTEGER NOT NULL DEFAULT 0');
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
