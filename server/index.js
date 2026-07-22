const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mailer = require('./email');
const vaultline = require('./vaultline');
const { feedbackInput, inviteInput, validate } = require('./validation');
const { migrate } = require('./db/schema');
const { createActivities } = require('./services/activities');
const { createMessages } = require('./services/messages');
const { createSfu } = require('./services/sfu');
const { registerMediaRoutes } = require('./routes/media');
const { registerAuthRoutes } = require('./routes/auth');
const { registerSocialRoutes } = require('./routes/social');
const { registerServerRoutes } = require('./routes/servers');
const { registerLibraryRoutes } = require('./routes/library');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const PORT = process.env.PORT || 3000;
// Deployment config (all optional — defaults keep the local dev setup working):
//  DATA_DIR       persistent dir for the SQLite db + uploads/gifs/sounds (mount a volume here)
//  CLIENT_DIST    path to the built client (client/dist) to serve; enables single-origin hosting
//  CLIENT_ORIGIN  comma-separated allowed origins for CORS/Socket.IO ('*' = any, the default)
//  STUN_URLS / TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL  WebRTC ICE servers sent to clients
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '..', 'client', 'dist');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const corsOrigin = CLIENT_ORIGIN === '*' ? '*' : CLIENT_ORIGIN.split(',').map((s) => s.trim());
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // uploads are deleted 7 days after upload
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // sweep hourly
const SOUND_NAME_MAX = 12; // keep soundboard names short enough to fit a tile

function isStrongPassword(pw) {
  if (typeof pw !== 'string') return false;
  // at least 8 chars, 1 lower, 1 upper, 1 digit, 1 special char
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(pw);
}

async function main() {
  const app = express();
  app.set('trust proxy', 1); // we sit behind an HTTPS reverse proxy in production
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const uploadDir = path.join(DATA_DIR, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  // GIF library files live outside /uploads so they are NOT swept by the 7-day cleanup.
  const gifsDir = path.join(DATA_DIR, 'gifs');
  fs.mkdirSync(gifsDir, { recursive: true });
  // Soundboard clips are also persistent (outside /uploads).
  const soundsDir = path.join(DATA_DIR, 'sounds');
  fs.mkdirSync(soundsDir, { recursive: true });
  // Desktop installer + auto-update feed (LAN-Party-Setup.exe, latest.yml, .blockmap).
  // Lives on the data volume (the big files are pushed here out-of-band), NOT swept by cleanup.
  const downloadsDir = path.join(DATA_DIR, 'downloads');
  fs.mkdirSync(downloadsDir, { recursive: true });
  // Screenshots attached to feedback/bug reports. Persistent (outside /uploads) so the links we hand
  // to Vaultline don't 404 after the 7-day upload sweep.
  const feedbackDir = path.join(DATA_DIR, 'feedback-media');
  fs.mkdirSync(feedbackDir, { recursive: true });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadDir),
      filename: (_req, file, cb) => {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_SIZE },
  });

  // Separate storage for the persistent GIF library (not subject to upload expiry).
  const gifUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, gifsDir),
      filename: (_req, file, cb) => {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_SIZE },
  });

  // Persistent storage for soundboard clips.
  const soundUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, soundsDir),
      filename: (_req, file, cb) => {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
      },
    }),
    limits: { fileSize: MAX_UPLOAD_SIZE },
  });

  // Screenshots on feedback/bug reports — images only, capped at 15 MB, stored persistently.
  const feedbackUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, feedbackDir),
      filename: (_req, file, cb) => {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
      },
    }),
    limits: { fileSize: 15 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype || '')),
  });

  // Uploaded files are named `<timestamp>-<rand>-<name>`; derive the upload time from the name.
  function uploadTimestampFromName(filename) {
    const match = /^(\d+)-/.exec(filename);
    return match ? Number(match[1]) : null;
  }

  // Delete uploads older than FILE_TTL_MS. The chat note for expired files is rendered
  // client-side from the same embedded timestamp, so no DB update is needed here.
  async function cleanupExpiredUploads() {
    let files;
    try {
      files = await fs.promises.readdir(uploadDir);
    } catch (err) {
      return;
    }
    const now = Date.now();
    for (const name of files) {
      const full = path.join(uploadDir, name);
      try {
        let ts = uploadTimestampFromName(name);
        if (ts == null) ts = (await fs.promises.stat(full)).mtimeMs; // fall back to mtime
        if (now - ts > FILE_TTL_MS) {
          await fs.promises.unlink(full);
          console.log('Removed expired upload', name);
        }
      } catch (err) {
        /* skip files we can't stat/remove */
      }
    }
  }

  app.use(cors({ origin: corsOrigin }));
  // WebRTC ICE config (STUN + optional TURN from env) — served to clients so TURN creds aren't
  // baked into the public JS bundle and can be rotated without a rebuild.
  app.get('/webrtc/ice', (_req, res) => {
    const iceServers = [{ urls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()) }];
    if (process.env.TURN_URLS) {
      iceServers.push({ urls: process.env.TURN_URLS.split(',').map((s) => s.trim()), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
    }
    res.json({ iceServers });
  });
  app.use('/uploads', express.static(uploadDir));
  // redirect:false so a bare `GET /gifs` isn't turned into a directory redirect,
  // letting it fall through to the GIF-list API route below.
  app.use('/gifs', express.static(gifsDir, { redirect: false }));
  app.use('/sounds', express.static(soundsDir, { redirect: false }));
  // Desktop installer + electron-updater feed. The updater fetches /downloads/latest.yml at startup.
  app.use('/downloads', express.static(downloadsDir, { redirect: false }));
  // Feedback/bug-report screenshots — linked from Vaultline tickets, so served publicly (read-only).
  app.use('/feedback-media', express.static(feedbackDir, { redirect: false }));
  // Static images used by the landing page (app screenshots). Committed with the repo.
  app.use('/landing-assets', express.static(path.join(__dirname, 'landing-assets'), { redirect: false }));
  // Serve the built client (single-origin hosting) UNDER /app; a landing page sits at /.
  // Enabled when CLIENT_DIST exists (i.e. the client has been built + is present).
  const serveClient = fs.existsSync(path.join(CLIENT_DIST, 'index.html'));
  const LANDING_PAGE = path.join(__dirname, 'landing.html');
  const hasLanding = fs.existsSync(LANDING_PAGE);
  if (serveClient) {
    // Landing page at the root (only when we have one; otherwise fall back to the app at /).
    if (hasLanding) {
      app.get('/', (req, res) => res.sendFile(LANDING_PAGE));
    }
    // The app + its assets live under /app.
    app.use('/app', express.static(CLIENT_DIST));
  }
  // parse json with error handling for invalid JSON
  app.use(express.json());
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.parse.failed') {
      console.warn('Invalid JSON received for', req.method, req.url);
      return res.status(400).json({ error: 'Invalid JSON' });
    }
    next(err);
  });
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: corsOrigin } });

  const db = await open({ filename: path.join(DATA_DIR, 'data.sqlite'), driver: sqlite3.Database });
  await migrate(db);

  const clients = {}; // socketId -> { name, username, serverId }
  const collabSessions = {}; // sessionId (image url) -> { imageUrl, segments: [] } for shared image editing
  const liveStreams = {}; // socketId -> { name, serverId, channelId, camera, screen } for Watch/Discover
  const externalStreams = {}; // socketId -> { name, platform, channel, title, game } — "I'm live on Twitch/YouTube/Kik"
  const EXTERNAL_PLATFORMS = ['twitch', 'youtube', 'kik'];
  const mockEmails = [];

  // The list of people currently "live" for the Watch/Discover panel: in-app screen shares
  // (kind:'screen') plus external Twitch/YouTube/Kik streams (kind:'external').
  // Camera-on is NOT a discoverable stream — only Go Live (screen share) is.
  function discoverList() {
    const out = [];
    for (const [id, s] of Object.entries(liveStreams)) {
      if (!s || !s.screen) continue;
      const size = (io.sockets.adapter.rooms.get(`voice:${s.serverId}:${s.channelId}`) || new Set()).size;
      out.push({ id, kind: 'screen', name: s.name, serverId: s.serverId, channelId: s.channelId, camera: !!s.camera, screen: !!s.screen, viewers: size, genres: s.genres || [] });
    }
    for (const [id, s] of Object.entries(externalStreams)) {
      out.push({ id: `ext-${id}`, kind: 'external', name: s.name, platform: s.platform, channel: s.channel, title: s.title, game: s.game, genres: s.genres || [] });
    }
    return out;
  }
  function broadcastDiscover() { io.emit('discover:update', discoverList()); }

  // --- Activities: one shared activity per voice room, synced to everyone in it ---
  const activities = {}; // room -> { type, state, by }
  // Activity state machine + per-socket views (services/activities.js).
  const { ACTIVITY_TYPES, activityInit, applyActivityEvent, activityViewFor, broadcastActivity } = createActivities({ io, clients });

  // Message parsing/serialisation + reaction & pin storage (services/messages.js).
  const {
    parseAttachment, normalizeAttachment, parseReactions, formatReactions,
    sanitizeQuotes, parseQuotes, mapMessageRow, channelPins, toggleReaction,
  } = createMessages({ db });

  // Return deduped members for a server: prefer username when available, keep latest connection per key
  function getMembersForServer(serverId) {
    const raw = Object.keys(clients).filter(id => clients[id].serverId === serverId).map(id => ({ id, name: clients[id].name, username: clients[id].username }));
    const map = new Map();
    for (const m of raw) {
      const key = m.username || m.name || m.id;
      // overwrite to prefer the latest occurrence (most recent connection)
      map.set(key, m);
    }
    return Array.from(map.values());
  }

  const VALID_PRESENCE = ['available', 'busy', 'away', 'offline'];

  function normalizePresence(status) {
    return VALID_PRESENCE.includes(status) ? status : 'offline';
  }

  async function getUserByUsername(username) {
    return db.get(
      `SELECT id, username, COALESCE(presence_status, 'offline') AS presence_status
       FROM users WHERE username = ?`,
      username
    );
  }

  async function getFriendUsernames(userId) {
    const rows = await db.all(
      `SELECT u.username FROM friendships f
       JOIN users u ON u.id = f.friend_user_id
       WHERE f.user_id = ?`,
      userId
    );
    return rows.map((r) => r.username);
  }

  async function setUserPresenceByUsername(username, status) {
    const normalized = normalizePresence(status);
    await db.run('UPDATE users SET presence_status = ? WHERE username = ?', normalized, username);
    return normalized;
  }

  async function broadcastPresenceToFriends(username, status) {
    const me = await getUserByUsername(username);
    if (!me) return;
    const friends = await getFriendUsernames(me.id);
    const payload = { username, status: normalizePresence(status) };
    for (const friendUsername of friends) {
      io.to(`user:${friendUsername}`).emit('friend:presence-updated', payload);
    }
  }

  async function getPendingCountForUserId(userId) {
    const row = await db.get(
      'SELECT COUNT(*) AS count FROM friend_requests WHERE to_user_id = ? AND status = ?',
      userId,
      'pending'
    );
    return row?.count || 0;
  }

  async function emitPendingUpdate(username) {
    const user = await getUserByUsername(username);
    if (!user) return;
    const pendingCount = await getPendingCountForUserId(user.id);
    io.to(`user:${username}`).emit('friend:pending-updated', { pendingCount });
  }

  async function emitFriendsListUpdate(username) {
    io.to(`user:${username}`).emit('friend:list-updated', {});
  }

  async function getDmUnreadSummary(userId) {
    const rows = await db.all(
      `SELECT u.id AS peerId, u.username AS peerUsername, COUNT(dm.id) AS unreadCount
       FROM direct_messages dm
       JOIN users u ON u.id = dm.sender_id
       WHERE dm.recipient_id = ? AND dm.read_at IS NULL
       GROUP BY u.id, u.username`,
      userId
    );
    const totalUnread = rows.reduce((sum, r) => sum + r.unreadCount, 0);
    return { totalUnread, byPeer: rows };
  }

  async function emitDmUnreadUpdate(username) {
    const me = await getUserByUsername(username);
    if (!me) return;
    const summary = await getDmUnreadSummary(me.id);
    io.to(`user:${username}`).emit('dm:unread-updated', {
      totalUnread: summary.totalUnread,
      byPeer: summary.byPeer.map((r) => ({
        peerId: String(r.peerId),
        peerUsername: r.peerUsername,
        unreadCount: r.unreadCount,
      })),
    });
  }

  async function areFriends(userIdA, userIdB) {
    const row = await db.get(
      'SELECT 1 FROM friendships WHERE user_id = ? AND friend_user_id = ?',
      userIdA,
      userIdB
    );
    return !!row;
  }

  async function hasPendingRequestBetween(userIdA, userIdB) {
    const row = await db.get(
      `SELECT id FROM friend_requests
       WHERE status = 'pending'
         AND ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))`,
      userIdA,
      userIdB,
      userIdB,
      userIdA
    );
    return !!row;
  }

  const AVATAR_COLORS = ['#5865f2', '#3ba55c', '#faa61a', '#eb459e', '#ed4245', '#747f8d'];

  function avatarColorForUsername(username) {
    let hash = 0;
    for (let i = 0; i < username.length; i++) hash = (hash + username.charCodeAt(i)) % AVATAR_COLORS.length;
    return AVATAR_COLORS[hash];
  }

  // The display-safe profile bits other users need to render someone's avatar (uploaded picture,
  // border, overlay, name styling) in friend/DM/member lists. Parsed from a user's settings JSON.
  function displayProfileFromSettings(settingsJson) {
    let s = {};
    try { s = JSON.parse(settingsJson || '{}') || {}; } catch { s = {}; }
    const p = s.profile || {};
    return {
      avatarUrl: p.avatarUrl || '',
      border: p.border || null,
      overlay: p.overlay || null,
      nameStyle: p.nameStyle || null,
      nameFont: p.nameFont || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
    };
  }

  function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      // check if token has been revoked
      db.get('SELECT token FROM revoked_tokens WHERE token = ?', token).then(row => {
        if (row) return res.status(401).json({ error: 'Token revoked' });
        req.user = payload;
        next();
      }).catch(err => {
        console.error('Failed to check revoked tokens', err);
        return res.status(500).json({ error: 'Server error' });
      });
    } catch (err) {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  // Auth + account lifecycle (routes/auth.js).
  registerAuthRoutes({ app, db, authMiddleware, JWT_SECRET, isStrongPassword, mockEmails });

  app.get('/user/settings', authMiddleware, async (req, res) => {
    const username = req.user.username;
    const user = await db.get('SELECT settings FROM users WHERE username = ?', username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ settings: JSON.parse(user.settings || '{}') });
  });

  app.post('/user/settings', authMiddleware, async (req, res) => {
    const username = req.user.username;
    const settings = req.body.settings || {};
    const user = await db.get('SELECT id FROM users WHERE username = ?', username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(settings), username);
    return res.json({ success: true, settings });
  });

  // Change the current user's username. Username is used as a natural key across many tables, so the
  // rename must cascade in a transaction; then we issue a fresh JWT (it carries the username).
  app.post('/user/username', authMiddleware, async (req, res) => {
    const oldUsername = req.user.username;
    const newUsername = String(req.body?.username || '').trim();
    if (!newUsername) return res.status(400).json({ error: 'Username is required' });
    if (newUsername.length < 3 || newUsername.length > 20) return res.status(400).json({ error: 'Username must be 3–20 characters' });
    if (!/^[A-Za-z0-9_.-]+$/.test(newUsername)) return res.status(400).json({ error: 'Only letters, numbers, and _ . - are allowed' });
    if (newUsername === oldUsername) return res.status(400).json({ error: 'That is already your username' });
    const me = await db.get('SELECT id FROM users WHERE username = ?', oldUsername);
    if (!me) return res.status(404).json({ error: 'User not found' });
    if (await db.get('SELECT id FROM users WHERE username = ?', newUsername)) return res.status(409).json({ error: 'Username already taken' });
    try {
      await db.run('BEGIN');
      // Every table that stores the username as a natural key (IDs-based tables need no change).
      await db.run('UPDATE users SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE server_members SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE channel_members SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE channel_reads SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE music_playlists SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE messages SET author = ? WHERE author = ?', newUsername, oldUsername);
      await db.run('UPDATE messages SET pinned_by = ? WHERE pinned_by = ?', newUsername, oldUsername);
      await db.run('UPDATE servers SET owner = ? WHERE owner = ?', newUsername, oldUsername);
      await db.run('UPDATE server_emojis SET created_by = ? WHERE created_by = ?', newUsername, oldUsername);
      await db.run('UPDATE apps SET created_by = ? WHERE created_by = ?', newUsername, oldUsername);
      await db.run('UPDATE gifs SET created_by = ? WHERE created_by = ?', newUsername, oldUsername);
      await db.run('UPDATE sounds SET created_by = ? WHERE created_by = ?', newUsername, oldUsername);
      await db.run('COMMIT');
    } catch (e) {
      await db.run('ROLLBACK').catch(() => {});
      console.error('username change failed', e);
      return res.status(409).json({ error: 'Could not change username — it may already be taken' });
    }
    const token = jwt.sign({ username: newUsername }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ success: true, username: newUsername, token });
  });

  // Public profile of any user (for the click-a-member profile card) — only display-safe fields.
  app.get('/users/:username/public', authMiddleware, async (req, res) => {
    const row = await db.get("SELECT username, settings, COALESCE(presence_status,'offline') AS presence_status FROM users WHERE username = ?", req.params.username);
    if (!row) return res.status(404).json({ error: 'User not found' });
    let s = {};
    try { s = JSON.parse(row.settings || '{}') || {}; } catch { s = {}; }
    const p = s.profile || {};
    return res.json({
      username: row.username,
      status: row.presence_status,
      profile: {
        avatarUrl: p.avatarUrl || '', border: p.border || null, overlay: p.overlay || null,
        nameStyle: p.nameStyle || null, nameFont: p.nameFont || null, tags: Array.isArray(p.tags) ? p.tags : [],
        statusMessage: p.statusMessage || '', bio: p.bio || '',
      },
      gamingProfile: {
        genres: Array.isArray(s.gamingProfile?.genres) ? s.gamingProfile.genres : [],
        currentGames: s.gamingProfile?.currentGames || '',
      },
    });
  });

  // --- Servers & channels ---
  const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const DEMO_ID = 'demo';

  // --- Membership & roles ---
  const isStaffRole = (role) => role === 'owner' || role === 'admin';
  const roleRank = (role) => (role === 'owner' ? 0 : role === 'admin' ? 1 : 2);
  async function roleOf(serverId, username) {
    if (!username) return null;
    if (serverId === DEMO_ID) return 'member'; // everyone belongs to the public commons
    const row = await db.get('SELECT role FROM server_members WHERE server_id = ? AND username = ?', serverId, username);
    return row ? row.role : null;
  }
  async function isMember(serverId, username) { return (await roleOf(serverId, username)) != null; }
  // demo: anyone can create public channels (open commons). Otherwise owner/admins only.
  async function canManageChannels(serverId, username) {
    if (serverId === DEMO_ID) return true;
    return isStaffRole(await roleOf(serverId, username));
  }
  // Full member roster with roles + online flag. demo has no rows → show connected users.
  async function serverRoster(serverId) {
    const onlineUsers = new Set(Object.values(clients).filter((c) => c.serverId === serverId && c.username).map((c) => c.username));
    let roster;
    if (serverId === DEMO_ID) {
      const seen = new Map();
      for (const c of Object.values(clients)) {
        if (c.serverId !== serverId) continue;
        const key = c.username || c.name;
        if (!seen.has(key)) seen.set(key, { username: c.username || null, name: c.name, role: 'member', online: true });
      }
      roster = Array.from(seen.values());
    } else {
      const rows = await db.all(
        `SELECT sm.username, sm.role, u.settings FROM server_members sm
         LEFT JOIN users u ON u.username = sm.username WHERE sm.server_id = ?`,
        serverId
      );
      roster = rows.map((r) => ({ username: r.username, name: r.username, role: r.role, online: onlineUsers.has(r.username), profile: displayProfileFromSettings(r.settings) }));
    }
    roster.sort((a, b) => roleRank(a.role) - roleRank(b.role) || (b.online - a.online) || String(a.name).localeCompare(String(b.name)));
    return roster;
  }
  // Is a user explicitly granted access to a private channel?
  async function inChannelMembers(serverId, channelId, username) {
    if (!username) return false;
    const row = await db.get('SELECT 1 FROM channel_members WHERE server_id = ? AND channel_id = ? AND username = ?', serverId, channelId, username);
    return !!row;
  }
  // Can this user see/use the channel? Public → any member. Private → owner/admins or an explicit grant.
  async function canAccessChannel(serverId, channelId, username, privacy, role) {
    if (!role) return false;                 // not a member of the server
    if (privacy !== 'private') return true;  // public channel
    if (isStaffRole(role)) return true;      // owner/admins manage everything
    return inChannelMembers(serverId, channelId, username);
  }
  // Channels a given user can see: staff see all; others see public channels + the private ones
  // they've been explicitly added to.
  async function visibleChannelsFor(serverId, channels, username, role) {
    if (isStaffRole(role)) return channels;
    const grantedRows = await db.all('SELECT channel_id FROM channel_members WHERE server_id = ? AND username = ?', serverId, username);
    const granted = new Set(grantedRows.map((r) => r.channel_id));
    return channels.filter((c) => c.privacy !== 'private' || granted.has(c.id));
  }

  // --- Unreads ---
  async function markChannelRead(username, serverId, channelId) {
    if (!username) return;
    await db.run(
      `INSERT INTO channel_reads (username, server_id, channel_id, last_read_ts) VALUES (?, ?, ?, ?)
       ON CONFLICT(username, server_id, channel_id) DO UPDATE SET last_read_ts = excluded.last_read_ts`,
      username, serverId, channelId, Date.now()
    );
  }
  // Tell members a channel has a new message so their badges bump live. Private channels only
  // notify staff. The author is skipped (demo broadcasts include them; clients filter by author).
  // Carries channel/server names + @mentions so clients can raise desktop notifications.
  async function emitUnreadBump(serverId, channelId, privacy, author, text) {
    const srv = await db.get('SELECT name FROM servers WHERE id = ?', serverId);
    const ch = await db.get('SELECT name FROM channels WHERE id = ?', channelId);
    const mentions = [...String(text || '').matchAll(/@(\w[\w.-]*)/g)].map((m) => m[1]);
    const payload = {
      serverId, channelId, author,
      serverName: srv?.name, channelName: ch?.name,
      preview: String(text || '').slice(0, 120), mentions,
    };
    if (serverId === DEMO_ID) { io.emit('unread:bump', payload); return; } // public commons: everyone's a member
    // For a private channel, only staff + explicitly-granted members should be nudged.
    const granted = privacy === 'private'
      ? new Set((await db.all('SELECT username FROM channel_members WHERE server_id = ? AND channel_id = ?', serverId, channelId)).map((r) => r.username))
      : null;
    const members = await db.all('SELECT username, role FROM server_members WHERE server_id = ?', serverId);
    for (const m of members) {
      if (m.username === author) continue;
      if (privacy === 'private' && !isStaffRole(m.role) && !granted.has(m.username)) continue;
      io.to(`user:${m.username}`).emit('unread:bump', payload);
    }
  }

  // Broadcast a server's state to everyone in its room, filtered per-socket (private channels are
  // only sent to owner/admins; each socket also learns its own role).
  async function broadcastServerState(serverId) {
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
    if (!srv) return;
    const allChannels = await db.all("SELECT id, name, type, COALESCE(privacy, 'public') AS privacy FROM channels WHERE server_id = ?", serverId);
    const roster = await serverRoster(serverId);
    const room = io.sockets.adapter.rooms.get(`server:${serverId}`) || new Set();
    for (const sid of room) {
      const username = clients[sid]?.username;
      const role = await roleOf(serverId, username);
      const channels = await visibleChannelsFor(serverId, allChannels, username, role);
      io.to(sid).emit('server:state', { server: { id: srv.id, name: srv.name, owner: srv.owner || null, channels }, members: roster, myRole: role });
    }
  }

  // Servers / channels / membership (routes/servers.js).
  registerServerRoutes({ app, db, io, authMiddleware, DEMO_ID, newId, roleOf, isMember, isStaffRole, canManageChannels, visibleChannelsFor, broadcastServerState, validate, inviteInput });

  // Emojis / app directory / GIF library / soundboard (routes/library.js).
  registerLibraryRoutes({ app, db, io, authMiddleware, upload, gifUpload, soundUpload, gifsDir, soundsDir, SOUND_NAME_MAX });

  // Giphy / YouTube+yt-dlp / playlists / Spotify (routes/media.js).
  registerMediaRoutes({ app, db, authMiddleware, io, JWT_SECRET });

  // Presence / friends / direct messages (routes/social.js).
  registerSocialRoutes({ app, db, io, authMiddleware, getUserByUsername, areFriends, hasPendingRequestBetween, emitPendingUpdate, emitFriendsListUpdate, getDmUnreadSummary, emitDmUnreadUpdate, getPendingCountForUserId, setUserPresenceByUsername, broadcastPresenceToFriends, normalizePresence, displayProfileFromSettings, avatarColorForUsername, mapMessageRow, normalizeAttachment, sanitizeQuotes });

  app.post('/files/upload', authMiddleware, (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File is larger than 100 MB' });
        }
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing file' });
      return res.json({
        success: true,
        attachment: {
          url: `/uploads/${req.file.filename}`,
          name: req.file.originalname,
          size: req.file.size,
          type: req.file.mimetype || 'application/octet-stream',
        },
      });
    });
  });

  // Submit user feedback / feature request / bug report. Stored locally (audit trail + safety net if
  // the upstream is down) and forwarded to Vaultline, which turns it into a ticket. The Vaultline API
  // key stays on the server; the client only ever calls this endpoint. Bugs -> /reports (high prio),
  // feedback + feature requests -> /feedback (Vaultline has no separate "requests" endpoint).
  const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || 'https://lanparty.thejumpvault.com').replace(/\/$/, '');
  const FEEDBACK_LABELS = { feedback: 'Feedback', request: 'Feature request', bug: 'Bug report' };
  app.post('/feedback', authMiddleware, (req, res) => {
    feedbackUpload.single('screenshot')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Screenshot is larger than 15 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      try {
        const username = req.user.username;
        const input = validate(feedbackInput, req.body);
        if (!input.ok) return res.status(400).json({ error: input.error });
        const { type, message: rawMessage } = input.data;
        const userTitle = input.data.title || '';

        const userRow = await db.get('SELECT email FROM users WHERE username = ?', username);
        const email = userRow && userRow.email;
        if (!email) return res.status(400).json({ error: 'Your account has no email on file' });

        // Parse client diagnostics (best-effort; never trust it for anything security-sensitive).
        let diag = {};
        try { diag = JSON.parse(req.body.diagnostics || '{}') || {}; } catch (_) { /* ignore malformed */ }

        const screenshotUrl = req.file ? `${PUBLIC_APP_URL}/feedback-media/${req.file.filename}` : null;

        // Fold everything Vaultline has no dedicated field for (diagnostics + screenshot link) into the
        // message body, which Vaultline renders as HTML on the ticket.
        const meta = [];
        meta.push(`Submitted by ${username} (${email}) via LAN Party`);
        if (diag.appVersion || diag.desktopApp != null) {
          meta.push(`App: LAN Party ${diag.desktopApp ? 'desktop' : 'web'}${diag.appVersion ? ` v${diag.appVersion}` : ''}`);
        }
        if (diag.platform) meta.push(`Platform: ${diag.platform}`);
        if (diag.userAgent) meta.push(`Browser: ${diag.userAgent}`);
        if (diag.viewport) meta.push(`Viewport: ${diag.viewport}${diag.screen ? ` · Screen ${diag.screen}` : ''}`);
        if (diag.locale) meta.push(`Locale: ${diag.locale}`);
        if (screenshotUrl) meta.push(`Screenshot: ${screenshotUrl}`);

        let message = `${rawMessage}\n\n—— ${FEEDBACK_LABELS[type]} · submitted via LAN Party ——\n${meta.join('\n')}`;
        if (message.length > 10000) message = message.slice(0, 9990) + '…';

        // Feature requests share Vaultline's feedback endpoint, so mark them in the title/summary.
        let title = userTitle || null;
        if (type === 'request') title = userTitle ? `Feature request: ${userTitle}` : 'Feature request';

        const now = Date.now();
        const ins = await db.run(
          `INSERT INTO feedback (username, email, type, title, message, diagnostics, screenshot_url, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          username, email, type, title, rawMessage, JSON.stringify(diag), screenshotUrl, now
        );
        const rowId = ins.lastID;

        if (!vaultline.isConfigured()) {
          // No upstream key here (e.g. local dev). Keep the stored copy and tell the client it's queued.
          await db.run(`UPDATE feedback SET status = 'queued' WHERE id = ?`, rowId);
          return res.json({ ok: true, queued: true, key: null });
        }

        try {
          const result = await vaultline.submit({ type, username, email, message, title });
          await db.run(`UPDATE feedback SET status = 'sent', issue_key = ?, sent_at = ? WHERE id = ?`, result.key, Date.now(), rowId);
          return res.json({ ok: true, key: result.key });
        } catch (sendErr) {
          console.error('[feedback] forward to Vaultline failed:', sendErr.message);
          await db.run(`UPDATE feedback SET status = 'failed', error = ? WHERE id = ?`, sendErr.message, rowId);
          // The submission is safely stored; surface a soft failure so the user knows it was received.
          return res.status(502).json({ ok: false, saved: true, error: 'Could not reach the feedback service, but your report was saved.' });
        }
      } catch (e) {
        console.error('[feedback] error:', e);
        return res.status(500).json({ error: 'Server error' });
      }
    });
  });

  // Sync endpoint: return servers, channels, and messages
  app.get('/user/sync', authMiddleware, async (req, res) => {
    // for demo return full demo server
    const rows = await db.all('SELECT * FROM servers');
    const result = {};
    for (const s of rows) {
      const channels = await db.all("SELECT id, name, type, COALESCE(privacy, 'public') AS privacy FROM channels WHERE server_id = ?", s.id);
      const messagesByChannel = {};
      for (const ch of channels) {
        const msgs = await db.all('SELECT id, author, text, ts, attachment_json, reactions_json, quotes_json FROM messages WHERE server_id = ? AND channel_id = ? ORDER BY ts ASC', s.id, ch.id);
        messagesByChannel[ch.id] = msgs.map((m) => mapMessageRow(m, req.user.username));
      }
      result[s.id] = { id: s.id, name: s.name, channels, messages: messagesByChannel };
    }
    return res.json({ servers: result });
  });

  // SFU (mediasoup) for voice rooms — feature-detected by clients via sfu:caps; when disabled or
  // unsupported they fall back to the P2P mesh. Media flows on its own port, not the tunnel.
  const sfu = createSfu({ io });

  // Socket.IO handlers
  io.on('connection', (socket) => {
    console.log('socket connected', socket.id);
    // The voice room this socket currently occupies (sockets join at most one voice room).
    const voiceRoomOf = (s) => { for (const r of s.rooms) if (r.startsWith('voice:')) return r; return null; };
    sfu.bindSocket(socket, voiceRoomOf);
    // try to read token from handshake
    const token = socket.handshake.auth && socket.handshake.auth.token;
    let socketUser = null;
    if (token) {
      try { socketUser = jwt.verify(token, JWT_SECRET).username; } catch (e) { socketUser = null }
    }
    if (socketUser) {
      socket.join(`user:${socketUser}`);
      setUserPresenceByUsername(socketUser, 'available')
        .then((status) => broadcastPresenceToFriends(socketUser, status))
        .catch((err) => console.warn('presence on connect failed', err));
    }

    socket.on('join', async ({ serverId = 'demo', name = 'Anonymous' } = {}) => {
      const serverRow = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
      if (!serverRow) return; // unknown server id (e.g. stale client state) — ignore
      // Membership gate: only the public commons is open to everyone; others require membership.
      const myRole = await roleOf(serverId, socketUser);
      if (!myRole) { socket.emit('server:denied', { serverId }); return; }
      const nick = socketUser || name || 'Anonymous';
      clients[socket.id] = { name: nick, username: socketUser, serverId };
      // Switching servers: leave the previous server + text-channel rooms so messages from other
      // servers/channels never reach this socket. Voice/user/collab rooms are left untouched.
      for (const room of socket.rooms) {
        if (room !== socket.id && (room.startsWith('server:') || room.startsWith('channel:'))) socket.leave(room);
      }
      socket.join(`server:${serverId}`);
      const allChannels = await db.all("SELECT id, name, type, COALESCE(privacy, 'public') AS privacy FROM channels WHERE server_id = ?", serverId);
      await broadcastServerState(serverId); // role-filtered state to everyone (incl. this newcomer)

      // Enter the first text channel this user can actually see, and send its history.
      const firstText = (await visibleChannelsFor(serverId, allChannels, socketUser, myRole)).find((c) => c.type === 'text');
      if (firstText) {
        socket.join(`channel:${serverId}:${firstText.id}`);
        socket.emit('channel:joined', { serverId, channelId: firstText.id });
        const messages = await db.all('SELECT id, author, text, ts, attachment_json, reactions_json, quotes_json FROM messages WHERE server_id = ? AND channel_id = ? ORDER BY ts ASC', serverId, firstText.id);
        socket.emit('messages:init', { serverId, channelId: firstText.id, messages: (messages || []).map((m) => mapMessageRow(m, socketUser)) });
        await markChannelRead(socketUser, serverId, firstText.id); // history was just shown
      } else {
        socket.emit('messages:init', { serverId, channelId: null, messages: [] });
      }
    });

    socket.on('joinChannel', async ({ serverId = 'demo', channelId = 'general' } = {}) => {
      // Only join channels that belong to the server AND that this user is allowed to see.
      const ch = await db.get("SELECT id, type, COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
      if (!ch) return;
      const myRole = await roleOf(serverId, socketUser);
      if (!(await canAccessChannel(serverId, channelId, socketUser, ch.privacy, myRole))) return; // not a member / not granted
      for (const room of socket.rooms) {
        if (room !== socket.id && room.startsWith('channel:')) socket.leave(room);
      }
      socket.join(`channel:${serverId}:${channelId}`);
      socket.emit('channel:joined', { serverId, channelId });
      if (ch.type === 'text') {
        const messages = await db.all('SELECT id, author, text, ts, attachment_json, reactions_json, quotes_json, pinned_at, pinned_by FROM messages WHERE server_id = ? AND channel_id = ? ORDER BY ts ASC', serverId, channelId);
        socket.emit('messages:init', { serverId, channelId, messages: (messages || []).map((m) => mapMessageRow(m, socketUser)) });
        socket.emit('pins:updated', { serverId, channelId, pins: await channelPins(serverId, channelId, socketUser) });
      }
      await markChannelRead(socketUser, serverId, channelId);
    });

    // Client saw new messages in the channel it's viewing — advance its read marker.
    socket.on('channel:read', async ({ serverId, channelId } = {}) => {
      if (!socketUser || !serverId || !channelId) return;
      const ch = await db.get("SELECT id, COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
      if (!ch) return;
      const myRole = await roleOf(serverId, socketUser);
      if (!(await canAccessChannel(serverId, channelId, socketUser, ch.privacy, myRole))) return;
      await markChannelRead(socketUser, serverId, channelId);
    });

    socket.on('message', async ({ serverId = 'demo', channelId = 'general', text, attachment, quotes } = {}) => {
      // Refuse writes to channels the user can't see (belongs to server + private-access check).
      // Rejections are answered with message:error (echoing the text) instead of a silent drop,
      // so a client with a stale server/channel pairing can recover the message and resync.
      const ch = await db.get("SELECT id, COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
      if (!ch) { socket.emit('message:error', { serverId, channelId, text: (text || '').trim(), reason: 'unknown-channel' }); return; }
      const myRole = await roleOf(serverId, socketUser);
      if (!(await canAccessChannel(serverId, channelId, socketUser, ch.privacy, myRole))) { socket.emit('message:error', { serverId, channelId, text: (text || '').trim(), reason: 'no-access' }); return; }
      const author = clients[socket.id]?.name || 'Anon';
      const body = (text || '').trim();
      const fileAttachment = normalizeAttachment(attachment);
      if (!body && !fileAttachment) return;
      const cleanQuotes = sanitizeQuotes(quotes);
      const ts = Date.now();
      await db.run('INSERT INTO messages (server_id, channel_id, author, text, ts, attachment_json, quotes_json) VALUES (?, ?, ?, ?, ?, ?, ?)', serverId, channelId, author, body, ts, fileAttachment ? JSON.stringify(fileAttachment) : null, cleanQuotes ? JSON.stringify(cleanQuotes) : null);
      const msgRow = await db.get('SELECT id, author, text, ts, attachment_json, reactions_json, quotes_json FROM messages WHERE rowid = last_insert_rowid()');
      // Tag the broadcast with its server/channel so clients can filter (belt & braces on top of rooms).
      io.to(`channel:${serverId}:${channelId}`).emit('message', { ...mapMessageRow(msgRow), serverId, channelId });
      await emitUnreadBump(serverId, channelId, ch.privacy, author, body);
    });

    // Delete a channel message — only the author may delete it. Broadcast removal to the channel.
    socket.on('message:delete', async ({ id } = {}) => {
      if (!id) return;
      const info = clients[socket.id];
      if (!info) return;
      const row = await db.get('SELECT author, server_id, channel_id FROM messages WHERE id = ?', id);
      if (!row || row.author !== info.name) return; // not found or not the author
      await db.run('DELETE FROM messages WHERE id = ?', id);
      io.to(`channel:${row.server_id}:${row.channel_id}`).emit('message:deleted', { id });
    });

    // Pin / unpin a channel message. Any member who can see the channel may pin (party app). The
    // pinned list is broadcast to the channel; newest pin is first so the bar shows the latest.
    const pinGate = async (id) => {
      const row = await db.get('SELECT id, server_id, channel_id FROM messages WHERE id = ?', id);
      if (!row) return null;
      const ch = await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", row.channel_id, row.server_id);
      if (!ch) return null;
      const myRole = await roleOf(row.server_id, socketUser);
      if (!(await canAccessChannel(row.server_id, row.channel_id, socketUser, ch.privacy, myRole))) return null;
      return row;
    };
    socket.on('message:pin', async ({ id } = {}) => {
      if (!id) return;
      const row = await pinGate(id);
      if (!row) return;
      await db.run('UPDATE messages SET pinned_at = ?, pinned_by = ? WHERE id = ?', Date.now(), socketUser, id);
      io.to(`channel:${row.server_id}:${row.channel_id}`).emit('pins:updated', { serverId: row.server_id, channelId: row.channel_id, pins: await channelPins(row.server_id, row.channel_id, socketUser) });
    });
    socket.on('message:unpin', async ({ id } = {}) => {
      if (!id) return;
      const row = await pinGate(id);
      if (!row) return;
      await db.run('UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?', id);
      io.to(`channel:${row.server_id}:${row.channel_id}`).emit('pins:updated', { serverId: row.server_id, channelId: row.channel_id, pins: await channelPins(row.server_id, row.channel_id, socketUser) });
    });

    // Toggle a persisted reaction. scope 'channel' (broadcast to channel) or 'dm' (both peers).
    socket.on('reaction:toggle', async ({ scope = 'channel', messageId, emoji } = {}) => {
      if (!socketUser || !messageId || typeof emoji !== 'string' || !emoji) return;
      if (scope === 'dm') {
        const dm = await db.get('SELECT sender_id, recipient_id FROM direct_messages WHERE id = ?', messageId);
        if (!dm) return;
        const me = await getUserByUsername(socketUser);
        if (!me || (dm.sender_id !== me.id && dm.recipient_id !== me.id)) return; // only participants
        const raw = await toggleReaction('direct_messages', messageId, socketUser, emoji);
        if (raw == null) return;
        const otherId = dm.sender_id === me.id ? dm.recipient_id : dm.sender_id;
        const other = await db.get('SELECT username FROM users WHERE id = ?', otherId);
        io.to(`user:${socketUser}`).emit('reaction:updated', { scope: 'dm', messageId, reactions: raw });
        if (other) io.to(`user:${other.username}`).emit('reaction:updated', { scope: 'dm', messageId, reactions: raw });
        return;
      }
      const row = await db.get('SELECT server_id, channel_id FROM messages WHERE id = ?', messageId);
      if (!row) return;
      const raw = await toggleReaction('messages', messageId, socketUser, emoji);
      if (raw == null) return;
      io.to(`channel:${row.server_id}:${row.channel_id}`).emit('reaction:updated', { scope: 'channel', messageId, reactions: raw });
    });

    // Soundboard is voice-only: relay a play trigger to everyone else IN THE VOICE ROOM so all
    // call participants hear it too.
    socket.on('soundboard:play', ({ serverId = 'demo', channelId = 'voice1', soundId, url, name, emoji } = {}) => {
      if (typeof url !== 'string' || !url.startsWith('/sounds/')) return;
      const by = clients[socket.id]?.name || 'Anon';
      socket.to(`voice:${serverId}:${channelId}`).emit('soundboard:play', { soundId, url, name, emoji, by });
    });

    // Stop the currently-playing soundboard clip for others in the voice room.
    socket.on('soundboard:stop', ({ serverId = 'demo', channelId = 'voice1' } = {}) => {
      socket.to(`voice:${serverId}:${channelId}`).emit('soundboard:stop');
    });

    // Tell the voice room whether this peer is currently sharing their screen (so others can
    // offer a "view full screen" affordance only for screen shares).
    socket.on('voice:screenshare-state', ({ serverId = 'demo', channelId = 'voice1', sharing } = {}) => {
      socket.to(`voice:${serverId}:${channelId}`).emit('voice:screenshare-state', { id: socket.id, sharing: !!sharing });
    });

    // Global stream state for Watch/Discover: is this user currently sending camera and/or screen?
    socket.on('voice:stream-state', ({ serverId = 'demo', channelId = 'voice1', camera, screen, genres } = {}) => {
      if (camera || screen) {
        liveStreams[socket.id] = { name: clients[socket.id]?.name || 'Anon', serverId, channelId, camera: !!camera, screen: !!screen, genres: Array.isArray(genres) ? genres.slice(0, 12) : [] };
      } else {
        delete liveStreams[socket.id];
      }
      broadcastDiscover();
    });

    // A client (re)opening the Discover panel asks for the current list.
    socket.on('discover:list', () => socket.emit('discover:update', discoverList()));

    // "I'm live on Twitch/YouTube/Kik" — announce an external stream so friends can watch in-app.
    socket.on('stream:announce', ({ platform, channel, title, game, genres } = {}) => {
      if (!EXTERNAL_PLATFORMS.includes(platform)) return;
      const ch = String(channel || '').trim().slice(0, 120);
      if (!ch) return;
      externalStreams[socket.id] = {
        name: clients[socket.id]?.name || 'Anon',
        platform,
        channel: ch,
        title: String(title || '').trim().slice(0, 80),
        game: String(game || '').trim().slice(0, 60),
        genres: Array.isArray(genres) ? genres.slice(0, 12) : [],
      };
      broadcastDiscover();
    });
    socket.on('stream:unannounce', () => {
      if (externalStreams[socket.id]) { delete externalStreams[socket.id]; broadcastDiscover(); }
    });

    // Activities: start one for the voice room (everyone in it gets it), relay events, or stop.
    socket.on('activity:start', ({ serverId = 'demo', channelId = 'voice1', type } = {}) => {
      if (!ACTIVITY_TYPES.includes(type)) return;
      const room = `voice:${serverId}:${channelId}`;
      activities[room] = { type, state: activityInit(type), by: clients[socket.id]?.name || 'Anon' };
      broadcastActivity(room, activities[room]);
    });
    socket.on('activity:event', ({ serverId = 'demo', channelId = 'voice1', event } = {}) => {
      const room = `voice:${serverId}:${channelId}`;
      const act = activities[room];
      if (!act || !event || typeof event !== 'object') return;
      applyActivityEvent(act, event, clients[socket.id]?.name || 'Anon', { room });
      broadcastActivity(room, act);
    });
    socket.on('activity:stop', ({ serverId = 'demo', channelId = 'voice1' } = {}) => {
      const room = `voice:${serverId}:${channelId}`;
      delete activities[room];
      io.to(room).emit('activity:update', null);
    });

    // --- Collaborative image editing (shared annotation canvas, session keyed by image url) ---
    // Announce a collaboration so others in the channel can join.
    socket.on('collab:start', ({ serverId = 'demo', channelId = 'general', sessionId, imageUrl } = {}) => {
      if (!sessionId) return;
      if (!collabSessions[sessionId]) collabSessions[sessionId] = { imageUrl, segments: [] };
      const by = clients[socket.id]?.name || 'Anon';
      socket.to(`channel:${serverId}:${channelId}`).emit('collab:invite', { sessionId, imageUrl, by });
    });
    // Join a session and receive the current canvas state.
    socket.on('collab:join', ({ sessionId, imageUrl } = {}) => {
      if (!sessionId) return;
      socket.join(`collab:${sessionId}`);
      const sess = collabSessions[sessionId] || (collabSessions[sessionId] = { imageUrl, segments: [] });
      socket.emit('collab:state', { sessionId, segments: sess.segments });
    });
    // A drawn segment: store it and relay to everyone else in the session.
    socket.on('collab:draw', ({ sessionId, segment } = {}) => {
      const sess = collabSessions[sessionId];
      if (!sess || !segment || typeof segment !== 'object') return;
      sess.segments.push(segment);
      if (sess.segments.length > 20000) sess.segments.splice(0, sess.segments.length - 20000); // cap memory
      socket.to(`collab:${sessionId}`).emit('collab:draw', { segment });
    });
    socket.on('collab:clear', ({ sessionId } = {}) => {
      const sess = collabSessions[sessionId];
      if (!sess) return;
      sess.segments = [];
      socket.to(`collab:${sessionId}`).emit('collab:clear');
    });
    socket.on('collab:leave', ({ sessionId } = {}) => { if (sessionId) socket.leave(`collab:${sessionId}`); });

    // Voice signaling: simple mesh signaling via server
    socket.on('voice:join', ({ serverId = 'demo', channelId = 'voice1' } = {}) => {
      const room = `voice:${serverId}:${channelId}`;
      socket.join(room);
      const roomSet = io.sockets.adapter.rooms.get(room) || new Set();
      const peers = Array.from(roomSet).filter(id => id !== socket.id).map(id => ({ id, name: clients[id]?.name || 'Anon' }));
      socket.emit('voice:peers', peers);
      socket.to(room).emit('voice:peer-joined', { id: socket.id, name: clients[socket.id]?.name });
      socket.emit('activity:update', activityViewFor(activities[room], socket.id) || null); // late-joiners get the current activity (word redacted)
    });

    socket.on('voice:leave', ({ serverId = 'demo', channelId = 'voice1' } = {}) => {
      const room = `voice:${serverId}:${channelId}`;
      socket.leave(room);
      socket.to(room).emit('voice:peer-left', { id: socket.id });
      sfu.removePeer(room, socket.id); // close their SFU transports + notify consumers
      if (liveStreams[socket.id]) { delete liveStreams[socket.id]; broadcastDiscover(); }
      if (activities[room] && (io.sockets.adapter.rooms.get(room) || new Set()).size === 0) delete activities[room];
    });

    socket.on('voice:signal', ({ to, signal } = {}) => {
      if (!to) return;
      io.to(to).emit('voice:signal', { from: socket.id, signal });
    });

    // ---- Direct 1:1 calls between friends (ring/accept/decline + WebRTC relay) ----
    // Invite/accept/decline/cancel/end route by user room or peer socket id; call:signal relays
    // WebRTC offers/answers/ICE by socket id (like voice:signal, but on a separate channel so it
    // never collides with server-voice-channel signaling).
    socket.on('call:invite', ({ to, video } = {}) => {
      if (!socketUser || !to) return;
      const room = io.sockets.adapter.rooms.get(`user:${to}`);
      if (!room || room.size === 0) { socket.emit('call:unavailable', { to }); return; }
      io.to(`user:${to}`).emit('call:incoming', { from: socketUser, fromSocket: socket.id, video: !!video });
    });
    socket.on('call:accept', ({ to } = {}) => { // to = caller's socket id
      if (!to) return;
      io.to(to).emit('call:accepted', { from: socketUser, fromSocket: socket.id });
      // Tell this user's OTHER devices to stop ringing.
      socket.to(`user:${socketUser}`).emit('call:handled');
    });
    socket.on('call:decline', ({ to } = {}) => { // to = caller's socket id
      if (to) io.to(to).emit('call:declined', { from: socketUser });
      socket.to(`user:${socketUser}`).emit('call:handled');
    });
    socket.on('call:cancel', ({ to } = {}) => { // to = callee username (caller hangs up before answer)
      if (to) io.to(`user:${to}`).emit('call:canceled', { from: socketUser });
    });
    socket.on('call:end', ({ to } = {}) => { // to = peer socket id (during a connected call)
      if (to) io.to(to).emit('call:ended', { from: socketUser });
    });
    socket.on('call:signal', ({ to, signal } = {}) => { // WebRTC relay, to = peer socket id
      if (to) io.to(to).emit('call:signal', { from: socket.id, signal });
    });

    // NOTE: emit voice:peer-left from 'disconnecting' (not 'disconnect') — Socket.IO clears
    // socket.rooms before 'disconnect' fires, so iterating rooms there finds nothing and peers
    // never learn someone left (ghost tiles pile up). 'disconnecting' still has the rooms intact.
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room.startsWith('voice:')) {
          socket.to(room).emit('voice:peer-left', { id: socket.id });
          sfu.removePeer(room, socket.id);
          // If this socket is the last one in the room, drop its activity.
          if (activities[room] && (io.sockets.adapter.rooms.get(room) || new Set()).size <= 1) delete activities[room];
        }
      }
      if (liveStreams[socket.id] || externalStreams[socket.id]) {
        delete liveStreams[socket.id];
        delete externalStreams[socket.id];
        broadcastDiscover();
      }
    });

    socket.on('disconnect', () => {
      const info = clients[socket.id];
      delete clients[socket.id];
      if (info) {
        const serverId = info.serverId;
        const members = getMembersForServer(serverId);
        io.to(`server:${serverId}`).emit('server:state', { server: { id: serverId }, members });
        if (info.username) {
          setUserPresenceByUsername(info.username, 'offline')
            .then((status) => broadcastPresenceToFriends(info.username, status))
            .catch((err) => console.warn('presence on disconnect failed', err));
        }
      }
    });
  });

  // Sweep expired uploads on startup, then hourly.
  cleanupExpiredUploads().catch((err) => console.warn('upload cleanup failed', err));
  setInterval(() => {
    cleanupExpiredUploads().catch((err) => console.warn('upload cleanup failed', err));
  }, CLEANUP_INTERVAL_MS).unref();

  // SPA fallback for the app: any /app/* GET returns the app's index.html so client-side routes
  // boot (must be LAST, after all API routes + static mounts). API paths stay at root and are
  // untouched. When there's no landing page, / also falls through to the app for compatibility.
  if (serveClient) {
    app.get('*', (req, res, next) => {
      if (req.method !== 'GET') return next();
      const p = req.path;
      if (p.startsWith('/app')) return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
      // Without a landing page, keep the old behavior (app at root); with one, don't swallow other paths.
      if (!hasLanding && !p.startsWith('/uploads') && !p.startsWith('/gifs') && !p.startsWith('/sounds') && !p.startsWith('/socket.io')) {
        return res.sendFile(path.join(CLIENT_DIST, 'index.html'));
      }
      return next();
    });
  }

  server.listen(PORT, () => console.log(`LAN Party server on ${PORT}${serveClient ? ' (serving client)' : ''}`));
}

main().catch(err => { console.error('Server failed to start', err); process.exit(1) });
