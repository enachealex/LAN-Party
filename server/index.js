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
  const ACTIVITY_TYPES = ['watch', 'whiteboard', 'poll', 'ttt', 'sketch', 'music'];
  const SKETCH_WORDS = ['pizza', 'dragon', 'controller', 'headset', 'wizard', 'castle', 'laptop', 'zombie', 'racecar', 'treasure', 'ninja', 'robot', 'campfire', 'spaceship', 'sword', 'shield', 'potion', 'dungeon', 'goblin', 'keyboard', 'trophy', 'boss fight', 'power up', 'game over', 'rage quit', 'speedrun', 'loot box', 'health bar', 'respawn', 'lan party', 'energy drink', 'mechanical keyboard', 'graphics card', 'blue screen', 'lag spike', 'victory royale', 'minecart', 'creeper', 'portal', 'joystick', 'arcade', 'pixel', 'avatar', 'guild', 'quest', 'checkpoint', 'combo', 'headshot', 'stealth', 'sniper', 'race track', 'finish line', 'monster truck', 'alien', 'meteor', 'volcano', 'pirate ship', 'skeleton', 'campaign', 'final boss'];
  function activityInit(type) {
    if (type === 'watch') return { videoId: null, playing: false, time: 0, ts: Date.now() };
    if (type === 'whiteboard') return { strokes: [] };
    if (type === 'poll') return { question: '', options: [], closed: false };
    if (type === 'ttt') return { board: Array(9).fill(''), turn: 'X', players: {}, winner: null, scores: {}, draws: 0, round: 1 };
    if (type === 'sketch') return { phase: 'lobby', players: [], turnIdx: 0, totalTurns: 0, word: null, wordMask: '', strokes: [], guesses: [], solvedBy: [], lastResult: null };
    // music: shared queue + synced playback (pos anchored to server time ts, like 'watch').
    // dj: null = everyone controls; a claimed DJ is the only one who can drive playback.
    if (type === 'music') return { queue: [], index: -1, playing: false, pos: 0, ts: Date.now(), history: [], dj: null };
    return {};
  }

  // --- Sketch & Guess helpers ---
  const sketchNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function sketchDrawer(s) { return s.players.length ? s.players[s.turnIdx % s.players.length].name : null; }
  function sketchNewTurn(s) {
    if (s.turnIdx >= s.totalTurns) { s.phase = 'end'; s.word = null; s.wordMask = ''; return; }
    s.word = SKETCH_WORDS[Math.floor(Math.random() * SKETCH_WORDS.length)];
    s.wordMask = s.word.replace(/[a-z0-9]/gi, '_');
    s.strokes = [];
    s.guesses = [];
    s.solvedBy = [];
  }
  function sketchAdvance(s, resultMsg) {
    s.lastResult = resultMsg;
    s.turnIdx += 1;
    sketchNewTurn(s);
  }
  function tttWinner(b) {
    const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a, c, d] of L) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    return b.every((x) => x) ? 'draw' : null;
  }
  // Music track validation + sanitization, shared by the activity reducer and the playlist API.
  // Only YouTube video ids and Spotify track URIs are accepted; text fields are length-capped.
  const musicTrackValid = (t) => t && typeof t.id === 'string' &&
    (/^[a-zA-Z0-9_-]{6,20}$/.test(t.id) || /^spotify:track:[a-zA-Z0-9]{22}$/.test(t.id));
  const musicTrackClean = (t) => ({
    id: t.id,
    service: t.id.startsWith('spotify:') ? 'spotify' : 'youtube',
    title: String(t.title || '').slice(0, 120),
    artist: String(t.artist || '').slice(0, 80),
    thumbnail: String(t.thumbnail || '').slice(0, 300),
    durationMs: Number.isFinite(Number(t.durationMs)) ? Number(t.durationMs) : undefined,
  });
  function applyActivityEvent(act, ev, user, ctx) {
    const s = act.state;
    if (act.type === 'watch') {
      if (ev.kind === 'load' && typeof ev.videoId === 'string') { s.videoId = ev.videoId.slice(0, 20); s.playing = true; s.time = 0; s.ts = Date.now(); }
      else if (ev.kind === 'play') { s.playing = true; s.time = Number(ev.time) || 0; s.ts = Date.now(); }
      else if (ev.kind === 'pause') { s.playing = false; s.time = Number(ev.time) || 0; s.ts = Date.now(); }
      else if (ev.kind === 'seek') { s.time = Number(ev.time) || 0; s.ts = Date.now(); }
    } else if (act.type === 'whiteboard') {
      if (ev.kind === 'stroke' && ev.seg && typeof ev.seg === 'object') { s.strokes.push(ev.seg); if (s.strokes.length > 20000) s.strokes.splice(0, s.strokes.length - 20000); }
      else if (ev.kind === 'clear') s.strokes = [];
    } else if (act.type === 'poll') {
      if (ev.kind === 'create') { s.question = String(ev.question || '').slice(0, 140); s.options = (Array.isArray(ev.options) ? ev.options : []).slice(0, 6).map((t) => ({ text: String(t).slice(0, 60), votes: [] })); s.closed = false; }
      else if (ev.kind === 'vote' && !s.closed && s.options[ev.index]) { s.options.forEach((o) => { o.votes = o.votes.filter((u) => u !== user); }); s.options[ev.index].votes.push(user); }
      else if (ev.kind === 'close') s.closed = true;
    } else if (act.type === 'ttt') {
      if (ev.kind === 'join') { if (!s.players.X) s.players.X = user; else if (!s.players.O && s.players.X !== user) s.players.O = user; }
      else if (ev.kind === 'move' && s.winner == null) {
        const mark = s.players.X === user ? 'X' : (s.players.O === user ? 'O' : null);
        if (mark && mark === s.turn && ev.i >= 0 && ev.i < 9 && !s.board[ev.i]) {
          s.board[ev.i] = mark; s.turn = mark === 'X' ? 'O' : 'X'; s.winner = tttWinner(s.board);
          // Round just ended — put it on the scoreboard (moves are rejected once winner is set,
          // so this runs exactly once per round).
          if (s.winner === 'X' || s.winner === 'O') { const name = s.players[s.winner]; if (name) s.scores[name] = (s.scores[name] || 0) + 1; }
          else if (s.winner === 'draw') s.draws = (s.draws || 0) + 1;
        }
      } else if (ev.kind === 'reset') { s.board = Array(9).fill(''); s.turn = 'X'; s.winner = null; s.round = (s.round || 1) + 1; }
    } else if (act.type === 'sketch') {
      const drawer = sketchDrawer(s);
      if (ev.kind === 'join' && s.phase === 'lobby' && s.players.length < 8 && !s.players.some((p) => p.name === user)) {
        s.players.push({ name: user, score: 0 });
      } else if (ev.kind === 'start' && s.phase === 'lobby' && s.players.length >= 2) {
        s.phase = 'play';
        s.turnIdx = 0;
        s.totalTurns = s.players.length * 2; // everyone draws twice
        s.lastResult = null;
        sketchNewTurn(s);
      } else if (ev.kind === 'stroke' && s.phase === 'play' && user === drawer && ev.seg && typeof ev.seg === 'object') {
        s.strokes.push(ev.seg);
        if (s.strokes.length > 20000) s.strokes.splice(0, s.strokes.length - 20000);
      } else if (ev.kind === 'clear' && s.phase === 'play' && user === drawer) {
        s.strokes = [];
      } else if (ev.kind === 'guess' && s.phase === 'play' && user !== drawer && !s.solvedBy.includes(user)) {
        const text = String(ev.text || '').slice(0, 60).trim();
        if (!text) return;
        if (sketchNorm(text) === sketchNorm(s.word)) {
          s.solvedBy.push(user);
          const guesser = s.players.find((p) => p.name === user);
          const dp = s.players.find((p) => p.name === drawer);
          if (guesser) guesser.score += 100;
          if (dp) dp.score += 25;
          s.guesses.push({ by: user, text: null, correct: true }); // never leak the word
          const nonDrawers = s.players.filter((p) => p.name !== drawer).map((p) => p.name);
          if (nonDrawers.every((n) => s.solvedBy.includes(n))) {
            sketchAdvance(s, `Everyone guessed it! The word was "${s.word}".`);
          }
        } else {
          s.guesses.push({ by: user, text, correct: false });
          if (s.guesses.length > 200) s.guesses.splice(0, s.guesses.length - 200);
        }
      } else if (ev.kind === 'skip' && s.phase === 'play' && user === drawer) {
        sketchAdvance(s, `${drawer} skipped — the word was "${s.word}".`);
      } else if (ev.kind === 'reset' && s.phase === 'end') {
        s.players.forEach((p) => { p.score = 0 });
        s.phase = 'lobby';
        s.turnIdx = 0;
        s.word = null; s.wordMask = ''; s.strokes = []; s.guesses = []; s.solvedBy = []; s.lastResult = null;
      }
    } else if (act.type === 'music') {
      const now = Date.now();
      const validTrack = musicTrackValid;
      const cleanTrack = (t) => ({ ...musicTrackClean(t), addedBy: user });
      // With a DJ on deck, only they drive playback — including 'next' (auto-advance), so a
      // non-DJ can't force-skip by emitting it. The DJ's own client still fires next on track end.
      // Adding song requests stays open to everyone.
      const DJ_ONLY = ['play', 'pause', 'seek', 'skip', 'jump', 'remove', 'clear', 'shuffle', 'playNow', 'loadList', 'next'];
      if (s.dj && user !== s.dj && DJ_ONLY.includes(ev.kind)) return;
      if (ev.kind === 'djClaim') {
        // Free seat, or the current DJ left the voice room — take over.
        const room = ctx && ctx.room;
        const djStillHere = s.dj && room && [...(io.sockets.adapter.rooms.get(room) || [])].some((id) => clients[id]?.name === s.dj);
        if (!s.dj || !djStillHere) s.dj = user;
        return;
      }
      if (ev.kind === 'djRelease') { if (s.dj === user) s.dj = null; return; }
      const pushHistory = (t) => { if (!t) return; s.history.unshift({ id: t.id, title: t.title, artist: t.artist, thumbnail: t.thumbnail, playedAt: now }); if (s.history.length > 100) s.history.length = 100; };
      const startAt = (i) => {
        if (i >= 0 && i < s.queue.length) { s.index = i; s.pos = 0; s.ts = now; s.playing = true; }
        else { s.index = -1; s.pos = 0; s.ts = now; s.playing = false; }
      };
      if (ev.kind === 'add' && validTrack(ev.track) && s.queue.length < 200) {
        s.queue.push(cleanTrack(ev.track));
        if (s.index === -1) startAt(s.queue.length - 1); // nothing playing → start what was just added
      } else if (ev.kind === 'loadList' && Array.isArray(ev.tracks)) {
        const before = s.queue.length;
        for (const t of ev.tracks.slice(0, 200)) {
          if (s.queue.length >= 200) break;
          if (validTrack(t)) s.queue.push(cleanTrack(t));
        }
        if (s.index === -1 && s.queue.length > before) startAt(before); // idle → start the loaded list
      } else if (ev.kind === 'playNow' && validTrack(ev.track)) {
        pushHistory(s.queue[s.index]);
        s.queue.splice(s.index + 1, 0, cleanTrack(ev.track));
        startAt(s.index + 1);
      } else if (ev.kind === 'jump' && Number.isInteger(ev.i) && ev.i >= 0 && ev.i < s.queue.length) {
        pushHistory(s.queue[s.index]);
        startAt(ev.i);
      } else if (ev.kind === 'remove' && Number.isInteger(ev.i) && ev.i >= 0 && ev.i < s.queue.length) {
        const removingCurrent = ev.i === s.index;
        s.queue.splice(ev.i, 1);
        if (ev.i < s.index) s.index -= 1;
        else if (removingCurrent) startAt(s.index < s.queue.length ? s.index : -1);
      } else if (ev.kind === 'clear') {
        // Clear upcoming + played; keep only what's on right now.
        const current = s.queue[s.index];
        s.queue = current ? [current] : [];
        s.index = current ? 0 : -1;
        if (!current) { s.playing = false; s.pos = 0; s.ts = now; }
      } else if (ev.kind === 'shuffle' && s.queue.length > s.index + 2) {
        // Shuffle only the not-yet-played tail so history/current stay put.
        const tail = s.queue.splice(s.index + 1);
        for (let i = tail.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tail[i], tail[j]] = [tail[j], tail[i]]; }
        s.queue.push(...tail);
      } else if (ev.kind === 'skip' || ev.kind === 'next') {
        // 'next' comes from every client's audio 'ended' event — the fromId guard makes sure
        // only the first one advances the queue (the rest see a changed track and no-op).
        if (ev.kind === 'next' && (!s.queue[s.index] || s.queue[s.index].id !== ev.fromId)) return;
        pushHistory(s.queue[s.index]);
        startAt(s.index + 1 < s.queue.length ? s.index + 1 : -1);
      } else if (ev.kind === 'play') {
        if (s.index !== -1) { s.playing = true; s.pos = Number(ev.pos) || 0; s.ts = now; }
      } else if (ev.kind === 'pause') {
        s.playing = false; s.pos = Number(ev.pos) || 0; s.ts = now;
      } else if (ev.kind === 'seek') {
        s.pos = Math.max(0, Number(ev.pos) || 0); s.ts = now;
      }
      warmMusicQueue(s.queue, s.index); // pre-resolve upcoming audio so skips start instantly
    }
  }

  // What a given socket is allowed to see of an activity: in Sketch & Guess the secret word only
  // goes to the current drawer — everyone else gets a redacted copy (mask only).
  function activityViewFor(act, socketId) {
    if (!act || act.type !== 'sketch') return act;
    const s = act.state;
    if (s.phase !== 'play' || !s.word) return act;
    if (clients[socketId]?.name === sketchDrawer(s)) return act;
    return { ...act, state: { ...s, word: null } };
  }
  function broadcastActivity(room, act) {
    if (!act) { io.to(room).emit('activity:update', null); return; }
    const ids = io.sockets.adapter.rooms.get(room) || new Set();
    for (const id of ids) io.to(id).emit('activity:update', activityViewFor(act, id));
  }

  function parseAttachment(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function normalizeAttachment(value) {
    if (!value || typeof value !== 'object') return null;
    const url = typeof value.url === 'string' ? value.url : '';
    const name = typeof value.name === 'string' ? value.name : 'Attachment';
    // Allow ephemeral uploads and persistent GIF-library files.
    if (!url || !(url.startsWith('/uploads/') || url.startsWith('/gifs/'))) return null;
    return {
      url,
      name,
      size: Number(value.size) || 0,
      type: typeof value.type === 'string' ? value.type : 'application/octet-stream',
    };
  }

  // Raw stored reactions: { emoji: [username, ...] }.
  function parseReactions(value) {
    if (!value) return {};
    try {
      const obj = JSON.parse(value);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  // Format raw reactions for a given viewer: { emoji: { count, mine } }, dropping empties.
  function formatReactions(raw, forUsername) {
    const out = {};
    for (const [emoji, users] of Object.entries(raw || {})) {
      const list = Array.isArray(users) ? users : [];
      if (list.length === 0) continue;
      out[emoji] = { count: list.length, mine: forUsername ? list.includes(forUsername) : false };
    }
    return out;
  }

  function mapMessageRow(row, forUsername) {
    return {
      id: row.id,
      author: row.author,
      text: row.text || '',
      ts: row.ts,
      attachment: parseAttachment(row.attachment_json),
      reactions: formatReactions(parseReactions(row.reactions_json), forUsername),
      pinnedAt: row.pinned_at || null,
      pinnedBy: row.pinned_by || null,
    };
  }

  // Pinned messages of a channel, newest pin first (so pins[0] is what the pinned bar shows).
  async function channelPins(serverId, channelId, forUsername) {
    const rows = await db.all(
      'SELECT id, author, text, ts, attachment_json, reactions_json, pinned_at, pinned_by FROM messages WHERE server_id = ? AND channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC',
      serverId, channelId
    );
    return (rows || []).map((m) => mapMessageRow(m, forUsername));
  }

  // Toggle a user's reaction on a message row (table = 'messages' | 'direct_messages').
  // Returns the raw reactions object after toggling.
  async function toggleReaction(table, id, username, emoji) {
    const idCol = 'id';
    const row = await db.get(`SELECT reactions_json FROM ${table} WHERE ${idCol} = ?`, id);
    if (!row) return null;
    const raw = parseReactions(row.reactions_json);
    const list = Array.isArray(raw[emoji]) ? raw[emoji] : [];
    const idx = list.indexOf(username);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(username);
    if (list.length === 0) delete raw[emoji];
    else raw[emoji] = list;
    await db.run(`UPDATE ${table} SET reactions_json = ? WHERE ${idCol} = ?`, JSON.stringify(raw), id);
    return raw;
  }

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

  app.post('/auth/register', async (req, res) => {
    const { username, email, password, passwordConfirm } = req.body || {};
    if (!username || !email || !password || !passwordConfirm) return res.status(400).json({ error: 'Missing fields' });
    if (password !== passwordConfirm) return res.status(400).json({ error: 'Passwords do not match' });
    if (!isStrongPassword(password)) return res.status(400).json({ error: 'Password must be at least 8 characters and include 1 uppercase letter, 1 lowercase letter, 1 number, and 1 special character.' });
    // basic email format check
    if (!/\S+@\S+\.\S+/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
    // ensure username and email are unique with specific feedback
    const byUsername = await db.get('SELECT id FROM users WHERE username = ?', username);
    if (byUsername) return res.status(409).json({ error: 'Username already exists', field: 'username' });
    const byEmail = await db.get('SELECT id FROM users WHERE email = ?', email);
    if (byEmail) return res.status(409).json({ error: 'Email already exists', field: 'email' });
    const defaultSettings = {
      railColor: '#7a0d0d', sidebarColor: '#0f1418', panelColor: '#111417', headerColor: '#7a0d0d', accentStart: '#2bc3ff', accentEnd: '#0b86ff', fontColor: '#edf6ff', leftTileColor: '#1f2933',
      // Gaming profile (favorite genres + what they're playing lately) is now collected on first
      // login via the welcome/onboarding flow, not at signup. Start empty until then.
      gamingProfile: { genres: [], currentGames: '', updatedAt: 0 },
      // New accounts see the first-login welcome + gaming-profile onboarding. Existing users don't
      // have this flag, so `=== false` is false for them and they skip it.
      onboardingComplete: false,
    };
    const hash = bcrypt.hashSync(password, 10);
    await db.run('INSERT INTO users (username, email, password_hash, settings) VALUES (?, ?, ?, ?)', username, email, hash, JSON.stringify(defaultSettings));
    mockEmails.push({ to: email, subject: 'Welcome to LAN Party', body: `Welcome ${username}!` });
    console.log('Mock welcome email queued for', email);
    return res.json({ success: true });
  });

  app.post('/auth/check-availability', async (req, res) => {
    const { username, email } = req.body || {};
    if (!username && !email) return res.status(400).json({ error: 'Missing username or email' });
    if (username) {
      const byUsername = await db.get('SELECT id FROM users WHERE username = ?', username);
      if (byUsername) return res.json({ username: false });
    }
    if (email) {
      const byEmail = await db.get('SELECT id FROM users WHERE email = ?', email);
      if (byEmail) return res.json({ email: false });
    }
    return res.json({ username: username ? true : undefined, email: email ? true : undefined });
  });

  app.post('/auth/login', async (req, res) => {
    const { username, password, remember } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const user = await db.get('SELECT * FROM users WHERE username = ?', username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const settings = user.settings ? JSON.parse(user.settings) : {};
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: remember ? '90d' : '7d' });
    return res.json({ success: true, token, user: { username: user.username, email: user.email, settings } });
  });

  app.get('/auth/me', authMiddleware, async (req, res) => {
    const username = req.user.username;
    const user = await db.get('SELECT username, email, settings FROM users WHERE username = ?', username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ success: true, user: { username: user.username, email: user.email, settings: JSON.parse(user.settings || '{}') } });
  });

  app.post('/auth/forgot', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Missing email' });
    const user = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!user) return res.status(404).json({ error: 'Email not found' });
    const token = Math.random().toString(36).slice(2, 10);
    mockEmails.push({ to: email, subject: 'Password Reset', body: `Use this mock token to reset: ${token}` });
    console.log('Mock password reset email queued for', email);
    return res.json({ success: true, message: 'Reset email sent (mock)' });
  });

  // Logout: revoke the presented token so it cannot be used again
  app.post('/auth/logout', authMiddleware, async (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(400).json({ error: 'Missing token' });
    // try to read expiry from token payload
    let exp = Date.now();
    try {
      const payload = jwt.decode(token) || {};
      exp = payload.exp ? payload.exp * 1000 : Date.now();
    } catch (e) { /* ignore */ }
    try {
      await db.run('INSERT OR REPLACE INTO revoked_tokens (token, expires_at) VALUES (?, ?)', token, exp);
      return res.json({ success: true });
    } catch (err) {
      console.error('Failed to revoke token', err);
      return res.status(500).json({ error: 'Failed to revoke token' });
    }
  });

  app.get('/mock-emails', (req, res) => res.json({ emails: mockEmails }));

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
      const rows = await db.all('SELECT username, role FROM server_members WHERE server_id = ?', serverId);
      roster = rows.map((r) => ({ username: r.username, name: r.username, role: r.role, online: onlineUsers.has(r.username) }));
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

  // The rail shows only the servers the user owns or has been invited to. New users start with an
  // empty rail (no server is auto-joined at registration) and land on the home view.
  app.get('/servers', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const mine = await db.all(
      'SELECT s.id, s.name, s.owner, m.role FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.username = ? ORDER BY s.rowid ASC',
      me
    );
    const out = mine.map((s) => ({ id: s.id, name: s.name, owner: s.owner || null, role: s.role }));
    return res.json({ servers: out });
  });

  // Unread message counts per channel, for every server the user belongs to. Only channels the
  // user can see are included (private channels never leak counts to plain members).
  app.get('/unreads', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const counts = await db.all(
      `SELECT m.server_id, m.channel_id, COUNT(*) AS n
       FROM messages m
       LEFT JOIN channel_reads r ON r.username = ? AND r.server_id = m.server_id AND r.channel_id = m.channel_id
       WHERE m.ts > COALESCE(r.last_read_ts, 0) AND m.author != ?
       GROUP BY m.server_id, m.channel_id`,
      me, me
    );
    if (!counts.length) return res.json({ unreads: {} });
    // Roles for my servers, from membership rows (no implicit public server anymore).
    const memberships = await db.all('SELECT server_id, role FROM server_members WHERE username = ?', me);
    const myRole = new Map(memberships.map((m) => [m.server_id, m.role]));
    const serverIds = [...new Set(counts.map((c) => c.server_id))].filter((id) => myRole.has(id));
    const unreads = {};
    for (const sid of serverIds) {
      const chans = await db.all("SELECT id, COALESCE(privacy,'public') AS privacy FROM channels WHERE server_id = ?", sid);
      const visible = new Set((await visibleChannelsFor(sid, chans, me, myRole.get(sid))).map((c) => c.id));
      for (const c of counts) {
        if (c.server_id !== sid || !visible.has(c.channel_id)) continue;
        (unreads[sid] ||= {})[c.channel_id] = c.n;
      }
    }
    return res.json({ unreads });
  });

  // Create a server: the creator becomes its owner + first member.
  app.post('/servers', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Server name required' });
    const id = newId('srv');
    await db.run('INSERT INTO servers (id, name, owner) VALUES (?, ?, ?)', id, name, me);
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', newId('ch'), id, 'general', 'text');
    await db.run('INSERT INTO channels (id, server_id, name, type) VALUES (?, ?, ?, ?)', newId('ch'), id, 'Voice 1', 'voice');
    await db.run('INSERT INTO server_members (server_id, username, role) VALUES (?, ?, ?)', id, me, 'owner');
    io.to(`user:${me}`).emit('servers:updated'); // only the owner has it so far
    return res.json({ server: { id, name, owner: me, role: 'owner' } });
  });

  // Add a channel (owner/admin only for private servers; anyone for the demo commons).
  app.post('/servers/:serverId/channels', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can create channels' });
    const name = String((req.body || {}).name || '').trim().slice(0, 30);
    const type = (req.body || {}).type === 'voice' ? 'voice' : 'text';
    // The public commons can't have private channels (nobody would ever see them — no admins).
    const privacy = (serverId !== DEMO_ID && (req.body || {}).privacy === 'private') ? 'private' : 'public';
    if (!name) return res.status(400).json({ error: 'Channel name required' });
    const chId = newId('ch');
    await db.run('INSERT INTO channels (id, server_id, name, type, privacy) VALUES (?, ?, ?, ?, ?)', chId, serverId, name, type, privacy);
    // For a private channel, grant the requested members access (must be members of this server).
    // Staff (owner/admins) always have access, so they don't need a row.
    if (privacy === 'private') {
      const requested = Array.isArray((req.body || {}).members) ? (req.body || {}).members : [];
      const seen = new Set();
      for (const uRaw of requested.slice(0, 100)) {
        const u = String(uRaw || '').trim();
        if (!u || seen.has(u)) continue;
        seen.add(u);
        if (await isMember(serverId, u)) await db.run('INSERT OR IGNORE INTO channel_members (server_id, channel_id, username) VALUES (?, ?, ?)', serverId, chId, u);
      }
    }
    await broadcastServerState(serverId);
    return res.json({ channel: { id: chId, name, type, privacy } });
  });

  // Read / manage a private channel's access list (owner/admins only). Public channels have none.
  app.get('/servers/:serverId/channels/:channelId/members', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can view channel access' });
    const rows = await db.all('SELECT username FROM channel_members WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    return res.json({ members: rows.map((r) => r.username) });
  });
  app.post('/servers/:serverId/channels/:channelId/members', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can manage channel access' });
    const u = String((req.body || {}).username || '').trim();
    if (!u) return res.status(400).json({ error: 'Username required' });
    if (!(await isMember(serverId, u))) return res.status(400).json({ error: `${u} isn't a member of this server` });
    await db.run('INSERT OR IGNORE INTO channel_members (server_id, channel_id, username) VALUES (?, ?, ?)', serverId, channelId, u);
    await broadcastServerState(serverId);
    io.to(`user:${u}`).emit('servers:updated'); // nudge the newly-granted user to refresh
    return res.json({ success: true });
  });
  app.delete('/servers/:serverId/channels/:channelId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, channelId, username } = req.params;
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can manage channel access' });
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND channel_id = ? AND username = ?', serverId, channelId, username);
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });

  // Rebroadcast a server's state (role-filtered per socket).
  async function pushServerState(serverId) { await broadcastServerState(serverId); }

  // Rename a server (owner/admin; the public commons can't be renamed).
  app.patch('/servers/:serverId', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "The public server can't be renamed" });
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can rename it' });
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    if (!name) return res.status(400).json({ error: 'Server name required' });
    await db.run('UPDATE servers SET name = ? WHERE id = ?', name, serverId);
    io.emit('servers:updated');
    await pushServerState(serverId);
    return res.json({ server: { id: serverId, name } });
  });

  // Delete a server (owner only; the default commons is protected).
  app.delete('/servers/:serverId', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'The default server cannot be deleted' });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Only the owner can delete this server' });
    const members = await db.all('SELECT username FROM server_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM messages WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channels WHERE server_id = ?', serverId);
    await db.run('DELETE FROM channel_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_emojis WHERE server_id = ?', serverId);
    await db.run('DELETE FROM server_members WHERE server_id = ?', serverId);
    await db.run('DELETE FROM servers WHERE id = ?', serverId);
    for (const m of members) io.to(`user:${m.username}`).emit('servers:updated'); // drop it from every member's rail
    return res.json({ success: true });
  });

  // Rename a channel (owner/admin).
  app.patch('/servers/:serverId/channels/:channelId', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can rename channels' });
    const name = String((req.body || {}).name || '').trim().slice(0, 30);
    if (!name) return res.status(400).json({ error: 'Channel name required' });
    await db.run('UPDATE channels SET name = ? WHERE id = ?', name, channelId);
    await pushServerState(serverId);
    return res.json({ channel: { id: channelId, name } });
  });

  // Delete a channel (owner/admin). A server always keeps at least one text channel.
  app.delete('/servers/:serverId/channels/:channelId', authMiddleware, async (req, res) => {
    const { serverId, channelId } = req.params;
    const ch = await db.get('SELECT id, type FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    if (!(await canManageChannels(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can delete channels' });
    if (ch.type === 'text') {
      const textCount = await db.get("SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND type = 'text'", serverId);
      if ((textCount?.n || 0) <= 1) return res.status(400).json({ error: 'A server needs at least one text channel' });
    }
    await db.run('DELETE FROM messages WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND channel_id = ?', serverId, channelId);
    await db.run('DELETE FROM channels WHERE id = ?', channelId);
    await pushServerState(serverId);
    return res.json({ success: true });
  });

  // --- Membership management: invite, kick, roles, leave ---
  // Invite a user by username (owner/admin) → they become a member; their rail refreshes.
  app.post('/servers/:serverId/invite', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'Everyone is already in the public server' });
    const srv = await db.get('SELECT id, name FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (!isStaffRole(await roleOf(serverId, req.user.username))) return res.status(403).json({ error: 'Only server admins can invite' });
    const target = String((req.body || {}).username || '').trim();
    if (!target) return res.status(400).json({ error: 'Username required' });
    const user = await db.get('SELECT username FROM users WHERE username = ?', target);
    if (!user) return res.status(404).json({ error: `No user named "${target}"` });
    if (await isMember(serverId, target)) return res.status(400).json({ error: `${target} is already a member` });
    await db.run('INSERT INTO server_members (server_id, username, role) VALUES (?, ?, ?)', serverId, target, 'member');
    io.to(`user:${target}`).emit('servers:updated');
    io.to(`user:${target}`).emit('server:invited', { serverId, name: srv.name, by: req.user.username });
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });

  // Kick a member (owner/admin). Can't kick the owner; admins can't kick other admins.
  app.delete('/servers/:serverId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, username: target } = req.params;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "You can't kick from the public server" });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    const myRole = await roleOf(serverId, req.user.username);
    if (!isStaffRole(myRole)) return res.status(403).json({ error: 'Only server admins can remove members' });
    if (target === srv.owner) return res.status(400).json({ error: "The owner can't be removed" });
    const targetRole = await roleOf(serverId, target);
    if (!targetRole) return res.status(404).json({ error: 'Not a member' });
    if (myRole === 'admin' && targetRole === 'admin') return res.status(403).json({ error: "Admins can't remove other admins" });
    await db.run('DELETE FROM server_members WHERE server_id = ? AND username = ?', serverId, target);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND username = ?', serverId, target);
    io.to(`user:${target}`).emit('servers:updated');
    io.to(`user:${target}`).emit('server:removed', { serverId });
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });

  // Change a member's role: owner promotes/demotes between admin and member.
  app.patch('/servers/:serverId/members/:username', authMiddleware, async (req, res) => {
    const { serverId, username: target } = req.params;
    if (serverId === DEMO_ID) return res.status(400).json({ error: 'No roles in the public server' });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner !== req.user.username) return res.status(403).json({ error: 'Only the owner can change roles' });
    if (target === srv.owner) return res.status(400).json({ error: "The owner's role can't change" });
    const role = (req.body || {}).role === 'admin' ? 'admin' : 'member';
    if (!(await isMember(serverId, target))) return res.status(404).json({ error: 'Not a member' });
    await db.run('UPDATE server_members SET role = ? WHERE server_id = ? AND username = ?', role, serverId, target);
    io.to(`user:${target}`).emit('servers:updated');
    await broadcastServerState(serverId);
    return res.json({ success: true, role });
  });

  // Leave a server (any non-owner member). The owner must delete the server instead.
  app.post('/servers/:serverId/leave', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const me = req.user.username;
    if (serverId === DEMO_ID) return res.status(400).json({ error: "You can't leave the public server" });
    const srv = await db.get('SELECT id, owner FROM servers WHERE id = ?', serverId);
    if (!srv) return res.status(404).json({ error: 'Server not found' });
    if (srv.owner === me) return res.status(400).json({ error: 'Owners must delete the server instead of leaving' });
    if (!(await isMember(serverId, me))) return res.status(400).json({ error: 'Not a member' });
    await db.run('DELETE FROM server_members WHERE server_id = ? AND username = ?', serverId, me);
    await db.run('DELETE FROM channel_members WHERE server_id = ? AND username = ?', serverId, me);
    io.to(`user:${me}`).emit('servers:updated');
    io.to(`user:${me}`).emit('server:removed', { serverId });
    await broadcastServerState(serverId);
    return res.json({ success: true });
  });

  // --- Server custom emojis ---
  function slugifyEmojiName(raw) {
    const base = String(raw || 'emoji').replace(/\.[^.]+$/, '').toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return base || 'emoji';
  }

  // List custom emojis for a server.
  app.get('/servers/:serverId/emojis', authMiddleware, async (req, res) => {
    const rows = await db.all(
      'SELECT name, url, created_by FROM server_emojis WHERE server_id = ? ORDER BY created_at ASC',
      req.params.serverId
    );
    return res.json({ emojis: rows });
  });

  // Add a custom emoji to a server (url comes from a prior /files/upload).
  app.post('/servers/:serverId/emojis', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const { url } = req.body || {};
    if (typeof url !== 'string' || !url.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'Invalid emoji url' });
    }
    const server = await db.get('SELECT id FROM servers WHERE id = ?', serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    // Ensure a unique name within the server.
    let base = slugifyEmojiName(req.body?.name);
    let name = base;
    let n = 1;
    while (await db.get('SELECT id FROM server_emojis WHERE server_id = ? AND name = ?', serverId, name)) {
      name = `${base}_${n++}`;
    }
    await db.run(
      'INSERT INTO server_emojis (server_id, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      serverId, name, url, req.user.username, Date.now()
    );
    const emojis = await db.all('SELECT name, url, created_by FROM server_emojis WHERE server_id = ? ORDER BY created_at ASC', serverId);
    return res.json({ success: true, name, emojis });
  });

  // Remove a custom emoji from a server.
  app.delete('/servers/:serverId/emojis/:name', authMiddleware, async (req, res) => {
    const { serverId, name } = req.params;
    await db.run('DELETE FROM server_emojis WHERE server_id = ? AND name = ?', serverId, name);
    const emojis = await db.all('SELECT name, url, created_by FROM server_emojis WHERE server_id = ? ORDER BY created_at ASC', serverId);
    return res.json({ success: true, emojis });
  });

  // --- Public app directory ---
  // List all public apps (newest first).
  app.get('/apps', authMiddleware, async (req, res) => {
    const rows = await db.all('SELECT id, name, description, url, icon_url AS iconUrl, created_by AS createdBy, created_at AS createdAt FROM apps ORDER BY created_at DESC');
    return res.json({ apps: rows });
  });

  // Publish a new app to the public directory.
  app.post('/apps', authMiddleware, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'App name is required' });
    const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 500) : '';
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const iconUrl = typeof req.body?.iconUrl === 'string' && req.body.iconUrl.startsWith('/uploads/') ? req.body.iconUrl : '';
    await db.run(
      'INSERT INTO apps (name, description, url, icon_url, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      name.slice(0, 80), description, url, iconUrl, req.user.username, Date.now()
    );
    const apps = await db.all('SELECT id, name, description, url, icon_url AS iconUrl, created_by AS createdBy, created_at AS createdAt FROM apps ORDER BY created_at DESC');
    return res.json({ success: true, apps });
  });

  // --- Shared GIF library ---
  // List all GIFs (newest first).
  app.get('/gifs', authMiddleware, async (req, res) => {
    const gifs = await db.all('SELECT id, name, url, type, created_by AS createdBy, created_at AS createdAt FROM gifs ORDER BY created_at DESC');
    return res.json({ gifs });
  });

  // Add a GIF to the shared library (multipart upload -> persistent /gifs storage).
  app.post('/gifs', authMiddleware, (req, res) => {
    gifUpload.single('file')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 100 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing file' });
      const type = req.file.mimetype || 'image/gif';
      if (!type.startsWith('image/')) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'Only image files can be added to the GIF library' });
      }
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const name = (rawName || req.file.originalname || 'GIF').slice(0, 80);
      const url = `/gifs/${req.file.filename}`;
      await db.run(
        'INSERT INTO gifs (name, url, type, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
        name, url, type, req.user.username, Date.now()
      );
      const gifs = await db.all('SELECT id, name, url, type, created_by AS createdBy, created_at AS createdAt FROM gifs ORDER BY created_at DESC');
      return res.json({ success: true, gifs });
    });
  });

  // Remove a GIF from the library (and delete its file).
  app.delete('/gifs/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid gif id' });
    const gif = await db.get('SELECT url FROM gifs WHERE id = ?', id);
    if (gif && typeof gif.url === 'string' && gif.url.startsWith('/gifs/')) {
      fs.promises.unlink(path.join(gifsDir, path.basename(gif.url))).catch(() => {});
    }
    await db.run('DELETE FROM gifs WHERE id = ?', id);
    const gifs = await db.all('SELECT id, name, url, type, created_by AS createdBy, created_at AS createdAt FROM gifs ORDER BY created_at DESC');
    return res.json({ success: true, gifs });
  });

  // --- Shared soundboard ---
  const SOUND_COLORS = ['#ff6b6b', '#f7b731', '#20bf6b', '#2bcbba', '#45aaf2', '#4b7bec', '#a55eea', '#fd79a8', '#e17055', '#00b894'];
  function soundColorForName(raw) {
    const s = String(raw || 'sound');
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash + s.charCodeAt(i)) % SOUND_COLORS.length;
    return SOUND_COLORS[hash];
  }

  // List all soundboard clips (newest first).
  app.get('/sounds', authMiddleware, async (req, res) => {
    const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
    return res.json({ sounds });
  });

  // Add a soundboard clip (multipart upload -> persistent /sounds storage).
  app.post('/sounds', authMiddleware, (req, res) => {
    soundUpload.single('file')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 100 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing file' });
      const type = req.file.mimetype || 'audio/mpeg';
      // Accept by mimetype, or by extension (some clients send application/octet-stream for audio).
      const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'weba', 'opus'];
      const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
      if (!type.startsWith('audio/') && !AUDIO_EXTS.includes(ext)) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'Only audio files can be added to the soundboard' });
      }
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const name = (rawName || req.file.originalname.replace(/\.[^.]+$/, '') || 'Sound').slice(0, SOUND_NAME_MAX);
      const emoji = typeof req.body?.emoji === 'string' && req.body.emoji.trim() ? req.body.emoji.trim().slice(0, 8) : '🔊';
      const color = typeof req.body?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : soundColorForName(name);
      const url = `/sounds/${req.file.filename}`;
      await db.run(
        'INSERT INTO sounds (name, emoji, color, url, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        name, emoji, color, url, type, req.user.username, Date.now()
      );
      const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
      return res.json({ success: true, sounds });
    });
  });

  // Rename a soundboard clip.
  app.patch('/sounds/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid sound id' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, SOUND_NAME_MAX) : '';
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const existing = await db.get('SELECT id FROM sounds WHERE id = ?', id);
    if (!existing) return res.status(404).json({ error: 'Sound not found' });
    await db.run('UPDATE sounds SET name = ? WHERE id = ?', name, id);
    const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
    return res.json({ success: true, sounds });
  });

  // Remove a soundboard clip (and delete its file).
  app.delete('/sounds/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid sound id' });
    const sound = await db.get('SELECT url FROM sounds WHERE id = ?', id);
    if (sound && typeof sound.url === 'string' && sound.url.startsWith('/sounds/')) {
      fs.promises.unlink(path.join(soundsDir, path.basename(sound.url))).catch(() => {});
    }
    await db.run('DELETE FROM sounds WHERE id = ?', id);
    const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
    return res.json({ success: true, sounds });
  });

  // --- Giphy proxy ---
  // The Giphy API key comes from the GIPHY_API_KEY env var, or a `server/giphy.key` file.
  // The key stays server-side; clients only see the proxied results.
  function getGiphyKey() {
    if (process.env.GIPHY_API_KEY && process.env.GIPHY_API_KEY.trim()) return process.env.GIPHY_API_KEY.trim();
    try { return fs.readFileSync(path.join(__dirname, 'giphy.key'), 'utf8').trim(); } catch { return ''; }
  }

  app.get('/giphy/status', authMiddleware, (req, res) => res.json({ configured: !!getGiphyKey() }));

  // Trending + search return Giphy's raw { data, pagination, meta } so the client SDK <Grid>
  // (fed via this proxy) can render + paginate. offset/limit drive infinite scroll.
  async function proxyGiphy(res, endpoint, params) {
    const key = getGiphyKey();
    if (!key) return res.status(503).json({ error: 'Giphy is not configured', configured: false });
    const qs = new URLSearchParams({ api_key: key, rating: 'pg-13', ...params }).toString();
    try {
      const r = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${qs}`);
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data?.meta?.msg || 'Giphy error' });
      return res.json({ data: data.data || [], pagination: data.pagination || {}, meta: data.meta || {} });
    } catch (err) {
      return res.status(502).json({ error: 'Giphy request failed' });
    }
  }

  app.get('/giphy/trending', authMiddleware, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    return proxyGiphy(res, 'trending', { limit, offset });
  });

  app.get('/giphy/search', authMiddleware, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ data: [], pagination: { total_count: 0, count: 0, offset: 0 } });
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    return proxyGiphy(res, 'search', { q, limit, offset, lang: 'en' });
  });

  // --- Music (YouTube) — ported from DiscordMusicActivity ---
  // Search uses the YouTube Data API (key from YOUTUBE_API_KEY env or `server/youtube.key`).
  // Playback: yt-dlp resolves a signed audio-only URL (cached ~55 min) which we proxy as a
  // Range-capable stream, so every participant plays the same audio via a plain <audio> tag.
  const { spawn } = require('child_process');
  function getYoutubeKey() {
    if (process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_API_KEY.trim()) return process.env.YOUTUBE_API_KEY.trim();
    try { return fs.readFileSync(path.join(__dirname, 'youtube.key'), 'utf8').trim(); } catch { return ''; }
  }
  const decodeHtml = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const AUDIO_URL_TTL_MS = 55 * 60 * 1000; // YouTube signed URLs last ~6h; 55 min is a safe reuse window
  const audioUrlCache = new Map();          // videoId -> { audioUrl, expiresAt }
  const inflightAudioResolves = new Map();  // videoId -> Promise (dedupe concurrent yt-dlp runs)
  const MAX_CONCURRENT_YTDLP = 4;
  let activeYtdlp = 0;
  const ytdlpQueue = [];
  const acquireYtdlp = () => new Promise((resolve) => {
    if (activeYtdlp < MAX_CONCURRENT_YTDLP) { activeYtdlp++; resolve(); } else ytdlpQueue.push(resolve);
  });
  const releaseYtdlp = () => { const next = ytdlpQueue.shift(); if (next) next(); else activeYtdlp--; };

  function resolveAudioUrl(videoId) {
    const cached = audioUrlCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve({ audioUrl: cached.audioUrl, fromCache: true });
    if (cached) audioUrlCache.delete(videoId);
    const inflight = inflightAudioResolves.get(videoId);
    if (inflight) return inflight;
    const p = (async () => {
      await acquireYtdlp();
      try {
        const ytdlp = spawn('yt-dlp', [
          // Highest-bitrate audio-only stream; opus/m4a both play in browsers.
          '-f', 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio',
          '-S', 'acodec:opus,abr,asr',
          '--no-playlist', '--no-warnings', '-g',
          `https://www.youtube.com/watch?v=${videoId}`,
        ]);
        let out = '', errOut = '';
        ytdlp.stdout.on('data', (c) => { out += c.toString(); });
        ytdlp.stderr.on('data', (c) => { errOut += c.toString(); });
        const code = await new Promise((resolve, reject) => { ytdlp.once('error', reject); ytdlp.once('close', resolve); });
        const audioUrl = out.trim();
        if (code !== 0 || !audioUrl) { const e = new Error('Failed to get audio URL'); e.details = errOut; throw e; }
        audioUrlCache.set(videoId, { audioUrl, expiresAt: Date.now() + AUDIO_URL_TTL_MS });
        if (audioUrlCache.size > 500) {
          for (const [k, v] of audioUrlCache) if (v.expiresAt <= Date.now()) audioUrlCache.delete(k);
        }
        return { audioUrl, fromCache: false };
      } finally { releaseYtdlp(); }
    })().finally(() => inflightAudioResolves.delete(videoId));
    inflightAudioResolves.set(videoId, p);
    return p;
  }

  // Best-effort pre-resolve of the next few queued tracks so skips start instantly.
  function warmMusicQueue(queue, currentIndex, count = 3) {
    if (!Array.isArray(queue) || !queue.length) return;
    const idx = Number.isFinite(Number(currentIndex)) ? Number(currentIndex) : -1;
    const start = Math.max(0, idx + 1);
    for (const t of queue.slice(start, start + count)) {
      if (t && t.id && t.service !== 'spotify') resolveAudioUrl(t.id).catch(() => {}); // yt-dlp is YouTube-only
    }
  }

  // Pull a video id out of any common YouTube URL form (watch/shorts/embed/youtu.be/music.).
  function extractYouTubeId(input) {
    const text = String(input || '').trim();
    if (!/youtu\.?be/i.test(text)) return null;
    let url;
    try { url = new URL(text.startsWith('http') ? text : `https://${text}`); } catch { return null; }
    const host = url.hostname.replace(/^www\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      id = url.searchParams.get('v');
      if (!id) { const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname); if (m) id = m[1]; }
    }
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }

  app.get('/music/status', authMiddleware, (req, res) => res.json({ configured: !!getYoutubeKey() }));

  app.get('/music/search', authMiddleware, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Query required' });
    const key = getYoutubeKey();
    if (!key) return res.status(503).json({ error: 'Music search is not configured', configured: false });
    try {
      // A pasted YouTube URL resolves that exact video instead of searching.
      const pastedId = extractYouTubeId(q);
      if (pastedId) {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'snippet', id: pastedId, key })}`);
        const data = await r.json();
        const item = data.items && data.items[0];
        if (!item) return res.json([]);
        return res.json([{
          id: pastedId,
          title: decodeHtml(item.snippet.title),
          artist: decodeHtml(item.snippet.channelTitle),
          thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
        }]);
      }
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
        part: 'snippet', q, type: 'video', videoCategoryId: '10', maxResults: '10', key,
      })}`);
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data?.error?.message || 'YouTube search failed' });
      return res.json((data.items || []).map((item) => ({
        id: item.id.videoId,
        title: decodeHtml(item.snippet.title),
        artist: decodeHtml(item.snippet.channelTitle),
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      })));
    } catch (err) {
      console.error('Music search error:', err.message);
      return res.status(500).json({ error: 'YouTube search failed' });
    }
  });

  // --- Music playlists: save the queue, load it back later (per user) ---
  app.get('/music/playlists', authMiddleware, async (req, res) => {
    const rows = await db.all('SELECT id, name, tracks_json, updated_at FROM music_playlists WHERE username = ? ORDER BY updated_at DESC', req.user.username);
    return res.json({ playlists: rows.map((r) => { let n = 0; try { n = JSON.parse(r.tracks_json).length; } catch {} return { id: r.id, name: r.name, count: n, updatedAt: r.updated_at }; }) });
  });

  app.post('/music/playlists', authMiddleware, async (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    const tracks = (Array.isArray((req.body || {}).tracks) ? req.body.tracks : []).filter(musicTrackValid).slice(0, 200).map(musicTrackClean);
    if (!name) return res.status(400).json({ error: 'Playlist name required' });
    if (!tracks.length) return res.status(400).json({ error: 'Nothing to save — the queue is empty' });
    const me = req.user.username;
    const existing = await db.get('SELECT id FROM music_playlists WHERE username = ? AND name = ?', me, name);
    if (existing) {
      await db.run('UPDATE music_playlists SET tracks_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(tracks), Date.now(), existing.id);
      return res.json({ playlist: { id: existing.id, name, count: tracks.length, updated: true } });
    }
    const r = await db.run('INSERT INTO music_playlists (username, name, tracks_json, updated_at) VALUES (?, ?, ?, ?)', me, name, JSON.stringify(tracks), Date.now());
    return res.json({ playlist: { id: r.lastID, name, count: tracks.length } });
  });

  app.get('/music/playlists/:id', authMiddleware, async (req, res) => {
    const row = await db.get('SELECT id, name, tracks_json FROM music_playlists WHERE id = ? AND username = ?', req.params.id, req.user.username);
    if (!row) return res.status(404).json({ error: 'Playlist not found' });
    let tracks = [];
    try { tracks = JSON.parse(row.tracks_json); } catch {}
    return res.json({ playlist: { id: row.id, name: row.name, tracks } });
  });

  app.delete('/music/playlists/:id', authMiddleware, async (req, res) => {
    const r = await db.run('DELETE FROM music_playlists WHERE id = ? AND username = ?', req.params.id, req.user.username);
    if (!r.changes) return res.status(404).json({ error: 'Playlist not found' });
    return res.json({ success: true });
  });

  // --- Spotify (ported from DiscordMusicActivity) ---
  // Per-user OAuth for the Web Playback SDK: the client opens /music/spotify/login-url in a popup,
  // Spotify redirects to /callback here, and the tokens go back via postMessage + the user's socket
  // room. Tokens live only in that user's browser — the server never stores them.
  function getSpotifyCreds() {
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      return { client_id: process.env.SPOTIFY_CLIENT_ID.trim(), client_secret: process.env.SPOTIFY_CLIENT_SECRET.trim() };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'spotify.key'), 'utf8'));
      if (parsed.client_id && parsed.client_secret) return parsed;
    } catch { /* not configured */ }
    return null;
  }
  const SPOTIFY_SCOPES = ['streaming', 'user-read-email', 'user-read-private', 'user-read-playback-state', 'user-modify-playback-state'].join(' ');
  // The redirect URI must EXACTLY match one registered in the Spotify dashboard. Env override wins;
  // otherwise it's this server's own origin + /callback (single-origin prod = the site domain).
  function spotifyRedirectUri(req) {
    if (process.env.SPOTIFY_REDIRECT_URI && process.env.SPOTIFY_REDIRECT_URI.trim()) return process.env.SPOTIFY_REDIRECT_URI.trim();
    return `${req.protocol}://${req.get('host')}/callback`;
  }

  app.get('/music/spotify/status', authMiddleware, (req, res) => res.json({ configured: !!getSpotifyCreds() }));

  app.get('/music/spotify/login-url', authMiddleware, (req, res) => {
    const creds = getSpotifyCreds();
    if (!creds) return res.status(503).json({ error: 'Spotify is not configured' });
    // state carries who asked + which origin the popup should postMessage back to.
    const clientOrigin = String(req.query.client_origin || '').slice(0, 200);
    const state = Buffer.from(JSON.stringify({ u: req.user.username, o: clientOrigin })).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: creds.client_id,
      scope: SPOTIFY_SCOPES,
      redirect_uri: spotifyRedirectUri(req),
      state,
    });
    return res.json({ url: `https://accounts.spotify.com/authorize?${params}`, redirectUri: spotifyRedirectUri(req) });
  });

  // OAuth callback — hit by Spotify's redirect (no app auth possible here; identity comes from state).
  app.get('/callback', async (req, res) => {
    const creds = getSpotifyCreds();
    const { code, state, error } = req.query;
    let username = '', clientOrigin = '';
    try {
      const parsed = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
      username = String(parsed.u || ''); clientOrigin = String(parsed.o || '');
    } catch { /* bad state — fall through to error page */ }
    // This page is built from OAuth-flow inputs, so nothing untrusted is interpolated raw: the
    // status line is a fixed string, and the token payload is embedded through a script-safe
    // JSON encoder. The postMessage target is only used if `clientOrigin` is a valid http(s) origin.
    const page = (body) => res.send(`<!DOCTYPE html><html><head><title>Spotify</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#121212;color:#fff}</style></head><body>${body}</body></html>`);
    // JSON safe to embed inside a <script>: neutralize </script>, HTML-comment, and line-sep sequences.
    const jsonForScript = (v) => JSON.stringify(v)
      .replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    let safeOrigin = '*';
    try { safeOrigin = new URL(clientOrigin).origin === clientOrigin && /^https?:$/.test(new URL(clientOrigin).protocol) ? clientOrigin : '*'; } catch { safeOrigin = '*'; }
    if (error || !code || !creds) return page('<p>Spotify connection failed. You can close this window and try again.</p>');
    try {
      const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: spotifyRedirectUri(req) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error_description || 'token exchange failed');
      const payload = { type: 'spotify-auth', access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
      // Primary delivery is the user's socket room (below); postMessage is a best-effort popup nicety.
      if (username) io.to(`user:${username}`).emit('spotify:auth', payload);
      return page(`<p>Connected to Spotify — closing…</p><script>
try{window.opener&&window.opener.postMessage(${jsonForScript(payload)},${jsonForScript(safeOrigin)});}finally{window.close();}
</script>`);
    } catch (err) {
      console.error('Spotify callback error:', err.message);
      return page('<p>Spotify authentication failed. You can close this window.</p>');
    }
  });

  app.post('/music/spotify/refresh', authMiddleware, async (req, res) => {
    const creds = getSpotifyCreds();
    const refreshToken = (req.body || {}).refresh_token;
    if (!creds) return res.status(503).json({ error: 'Spotify is not configured' });
    if (!refreshToken) return res.status(400).json({ error: 'refresh_token required' });
    try {
      const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(refreshToken) }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'Token refresh failed' });
      const body = { access_token: data.access_token, expires_in: data.expires_in };
      if (data.refresh_token) body.refresh_token = data.refresh_token;
      return res.json(body);
    } catch {
      return res.status(502).json({ error: 'Token refresh failed' });
    }
  });

  // Search proxy — uses the requesting user's own Spotify token (never stored server-side).
  // The token comes in the X-Spotify-Token header, not the query string, so it never lands in
  // access logs. (Query fallback kept for older clients but discouraged.)
  app.get('/music/spotify/search', authMiddleware, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const accessToken = (req.get('X-Spotify-Token') || req.query.access_token || '').toString();
    if (!q || !accessToken) return res.status(400).json({ error: 'q and Spotify token required' });
    try {
      const r = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await r.json();
      if (r.status === 401) return res.status(401).json({ error: 'Spotify token expired' });
      if (!r.ok) return res.status(502).json({ error: 'Spotify search failed' });
      return res.json((data.tracks?.items || []).map((t) => ({
        id: t.uri, // spotify:track:… — what the Web Playback SDK plays
        title: t.name,
        artist: (t.artists || []).map((a) => a.name).join(', '),
        thumbnail: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
        durationMs: t.duration_ms,
        service: 'spotify',
      })));
    } catch (err) {
      console.error('Spotify search error:', err.message);
      return res.status(502).json({ error: 'Spotify search failed' });
    }
  });

  // Streaming audio proxy. Auth via ?token= because <audio src> can't send headers.
  app.get('/music/audio/:videoId', async (req, res) => {
    try { jwt.verify(String(req.query.token || ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(String(videoId || ''))) return res.status(400).json({ error: 'Invalid video id' });
    if (req.query.fresh === '1') audioUrlCache.delete(videoId); // client retry after a playback error
    try {
      const { audioUrl } = await resolveAudioUrl(videoId);
      const upstream = await fetch(audioUrl, { headers: req.headers.range ? { Range: req.headers.range } : {} });
      if (!upstream.ok && upstream.status !== 206) {
        if (upstream.status === 403 || upstream.status === 410) audioUrlCache.delete(videoId); // stale signed URL
        return res.status(502).json({ error: 'Audio stream failed' });
      }
      res.status(upstream.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const { Readable } = require('stream');
      const body = Readable.fromWeb(upstream.body);
      body.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
      req.on('close', () => body.destroy());
      body.pipe(res);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        console.error('yt-dlp not found — install it for music playback');
        return res.status(502).json({ error: 'Audio extraction tool not available' });
      }
      if (err && err.details) console.error('yt-dlp error:', String(err.details).slice(0, 300));
      else console.error('Music audio error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Failed to get audio' });
    }
  });

  app.post('/user/presence', authMiddleware, async (req, res) => {
    const status = normalizePresence(req.body?.status);
    const username = req.user.username;
    const user = await getUserByUsername(username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await setUserPresenceByUsername(username, status);
    await broadcastPresenceToFriends(username, status);
    return res.json({ success: true, status });
  });

  app.get('/friends/check-user', authMiddleware, async (req, res) => {
    const target = (req.query.username || '').trim();
    if (!target) return res.status(400).json({ error: 'Missing username' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    if (target.toLowerCase() === me.username.toLowerCase()) {
      return res.json({ exists: false, self: true });
    }
    const user = await getUserByUsername(target);
    return res.json({ exists: !!user, self: false });
  });

  app.get('/friends', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const rows = await db.all(
      `SELECT u.id, u.username, COALESCE(u.presence_status, 'offline') AS presence_status
       FROM friendships f
       JOIN users u ON u.id = f.friend_user_id
       WHERE f.user_id = ?
       ORDER BY u.username ASC`,
      me.id
    );
    const friends = rows.map((r) => ({
      id: String(r.id),
      name: r.username,
      status: normalizePresence(r.presence_status),
      avatar: avatarColorForUsername(r.username),
    }));
    return res.json({ friends });
  });

  app.get('/friends/requests/incoming', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const rows = await db.all(
      `SELECT fr.id, u.username AS fromUsername, fr.created_at AS createdAt
       FROM friend_requests fr
       JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      me.id
    );
    return res.json({
      requests: rows.map((r) => ({
        id: r.id,
        fromUsername: r.fromUsername,
        createdAt: r.createdAt,
        avatar: avatarColorForUsername(r.fromUsername),
      })),
    });
  });

  app.get('/friends/requests/outgoing', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const rows = await db.all(
      `SELECT fr.id, u.username AS toUsername, fr.created_at AS createdAt
       FROM friend_requests fr
       JOIN users u ON u.id = fr.to_user_id
       WHERE fr.from_user_id = ? AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      me.id
    );
    return res.json({
      requests: rows.map((r) => ({
        id: r.id,
        toUsername: r.toUsername,
        createdAt: r.createdAt,
        avatar: avatarColorForUsername(r.toUsername),
      })),
    });
  });

  app.post('/friends/requests/:id/cancel', authMiddleware, async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const fr = await db.get('SELECT * FROM friend_requests WHERE id = ?', requestId);
    if (!fr || fr.from_user_id !== me.id) return res.status(404).json({ error: 'Request not found' });
    if (fr.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    await db.run('UPDATE friend_requests SET status = ? WHERE id = ?', 'cancelled', requestId);
    const target = await db.get('SELECT username FROM users WHERE id = ?', fr.to_user_id);
    if (target) await emitPendingUpdate(target.username);
    return res.json({ success: true });
  });

  app.get('/friends/requests/pending-count', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const count = await getPendingCountForUserId(me.id);
    return res.json({ count });
  });

  app.post('/friends/request', authMiddleware, async (req, res) => {
    const targetUsername = (req.body?.username || '').trim();
    if (!targetUsername) return res.status(400).json({ error: 'Missing username' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const target = await getUserByUsername(targetUsername);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.id === me.id) return res.status(400).json({ error: 'You cannot add yourself' });
    if (await areFriends(me.id, target.id)) {
      return res.status(409).json({ error: 'Already friends' });
    }
    if (await hasPendingRequestBetween(me.id, target.id)) {
      return res.status(409).json({ error: 'Friend request already pending' });
    }
    const createdAt = Date.now();
    await db.run(
      'INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at) VALUES (?, ?, ?, ?)',
      me.id,
      target.id,
      'pending',
      createdAt
    );
    await emitPendingUpdate(target.username);
    return res.json({ success: true });
  });

  app.post('/friends/requests/:id/accept', authMiddleware, async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const fr = await db.get(
      `SELECT fr.*, u_from.username AS fromUsername, u_to.username AS toUsername
       FROM friend_requests fr
       JOIN users u_from ON u_from.id = fr.from_user_id
       JOIN users u_to ON u_to.id = fr.to_user_id
       WHERE fr.id = ?`,
      requestId
    );
    if (!fr || fr.to_user_id !== me.id) return res.status(404).json({ error: 'Request not found' });
    if (fr.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    const now = Date.now();
    await db.run('UPDATE friend_requests SET status = ? WHERE id = ?', 'accepted', requestId);
    await db.run(
      'INSERT OR IGNORE INTO friendships (user_id, friend_user_id, created_at) VALUES (?, ?, ?)',
      me.id,
      fr.from_user_id,
      now
    );
    await db.run(
      'INSERT OR IGNORE INTO friendships (user_id, friend_user_id, created_at) VALUES (?, ?, ?)',
      fr.from_user_id,
      me.id,
      now
    );
    await emitPendingUpdate(me.username);
    await emitFriendsListUpdate(me.username);
    await emitFriendsListUpdate(fr.fromUsername);
    return res.json({ success: true });
  });

  app.post('/friends/requests/:id/decline', authMiddleware, async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    if (!requestId) return res.status(400).json({ error: 'Invalid request id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const fr = await db.get('SELECT * FROM friend_requests WHERE id = ?', requestId);
    if (!fr || fr.to_user_id !== me.id) return res.status(404).json({ error: 'Request not found' });
    if (fr.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
    await db.run('UPDATE friend_requests SET status = ? WHERE id = ?', 'declined', requestId);
    await emitPendingUpdate(me.username);
    return res.json({ success: true });
  });

  app.get('/messages/conversations', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const friends = await db.all(
      `SELECT u.id, u.username, COALESCE(u.presence_status, 'offline') AS presence_status
       FROM friendships f
       JOIN users u ON u.id = f.friend_user_id
       WHERE f.user_id = ?
       ORDER BY u.username ASC`,
      me.id
    );
    const summary = await getDmUnreadSummary(me.id);
    const unreadMap = new Map(summary.byPeer.map((r) => [String(r.peerId), r.unreadCount]));
    const conversations = [];
    for (const f of friends) {
      const last = await db.get(
        `SELECT dm.body, dm.attachment_json AS attachmentJson, dm.created_at AS createdAt, s.username AS senderUsername
         FROM direct_messages dm
         JOIN users s ON s.id = dm.sender_id
         WHERE (dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?)
         ORDER BY dm.created_at DESC LIMIT 1`,
        me.id,
        f.id,
        f.id,
        me.id
      );
      conversations.push({
        id: String(f.id),
        name: f.username,
        peerUsername: f.username,
        unreadCount: unreadMap.get(String(f.id)) || 0,
        avatar: avatarColorForUsername(f.username),
        status: normalizePresence(f.presence_status),
        lastMessage: last
          ? { text: last.body || (last.attachmentJson ? 'Sent an attachment' : ''), author: last.senderUsername, createdAt: last.createdAt }
          : null,
      });
    }
    return res.json({ conversations, totalUnread: summary.totalUnread });
  });

  app.get('/messages/with/:username', authMiddleware, async (req, res) => {
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const peer = await getUserByUsername(req.params.username);
    if (!peer) return res.status(404).json({ error: 'User not found' });
    if (!(await areFriends(me.id, peer.id))) {
      return res.status(403).json({ error: 'You can only message friends' });
    }
    const markRead = req.query.markRead === '1' || req.query.markRead === 'true';
    if (markRead) {
      const now = Date.now();
      await db.run(
        'UPDATE direct_messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL',
        now,
        me.id,
        peer.id
      );
      await emitDmUnreadUpdate(me.username);
    }
    const rows = await db.all(
      `SELECT dm.id, dm.body AS text, dm.created_at AS ts, dm.attachment_json, dm.reactions_json, s.username AS author
       FROM direct_messages dm
       JOIN users s ON s.id = dm.sender_id
       WHERE (dm.sender_id = ? AND dm.recipient_id = ?) OR (dm.sender_id = ? AND dm.recipient_id = ?)
       ORDER BY dm.created_at ASC`,
      me.id,
      peer.id,
      peer.id,
      me.id
    );
    const summary = await getDmUnreadSummary(me.id);
    return res.json({
      messages: rows.map((r) => mapMessageRow(r, me.username)),
      totalUnread: summary.totalUnread,
    });
  });

  app.post('/messages/read', authMiddleware, async (req, res) => {
    const withUsername = (req.body?.withUsername || req.body?.username || '').trim();
    if (!withUsername) return res.status(400).json({ error: 'Missing username' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const peer = await getUserByUsername(withUsername);
    if (!peer) return res.status(404).json({ error: 'User not found' });
    const now = Date.now();
    await db.run(
      'UPDATE direct_messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL',
      now,
      me.id,
      peer.id
    );
    await emitDmUnreadUpdate(me.username);
    const summary = await getDmUnreadSummary(me.id);
    return res.json({ success: true, totalUnread: summary.totalUnread });
  });

  app.post('/messages/send', authMiddleware, async (req, res) => {
    const toUsername = (req.body?.toUsername || req.body?.username || '').trim();
    const body = (req.body?.text || req.body?.body || '').trim();
    const attachment = normalizeAttachment(req.body?.attachment);
    if (!toUsername || (!body && !attachment)) return res.status(400).json({ error: 'Missing username or message' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const peer = await getUserByUsername(toUsername);
    if (!peer) return res.status(404).json({ error: 'User not found' });
    if (!(await areFriends(me.id, peer.id))) {
      return res.status(403).json({ error: 'You can only message friends' });
    }
    const createdAt = Date.now();
    const insertResult = await db.run(
      'INSERT INTO direct_messages (sender_id, recipient_id, body, created_at, read_at, attachment_json) VALUES (?, ?, ?, ?, NULL, ?)',
      me.id,
      peer.id,
      body,
      createdAt,
      attachment ? JSON.stringify(attachment) : null
    );
    const row = await db.get(
      `SELECT dm.id, dm.body AS text, dm.created_at AS ts, dm.attachment_json, dm.reactions_json, s.username AS author
       FROM direct_messages dm
       JOIN users s ON s.id = dm.sender_id
       WHERE dm.id = ?`,
      insertResult.lastID
    );
    const msg = mapMessageRow(row);
    io.to(`user:${peer.username}`).emit('dm:message', {
      fromUsername: me.username,
      fromUserId: String(me.id),
      message: msg,
    });
    await emitDmUnreadUpdate(peer.username);
    await emitDmUnreadUpdate(me.username);
    return res.json({ success: true, message: msg });
  });

  // Delete a direct message — only the sender may delete it. Notify both participants.
  app.delete('/messages/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid message id' });
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });
    const dm = await db.get('SELECT sender_id, recipient_id FROM direct_messages WHERE id = ?', id);
    if (!dm) return res.status(404).json({ error: 'Message not found' });
    if (dm.sender_id !== me.id) return res.status(403).json({ error: 'You can only delete your own messages' });
    await db.run('DELETE FROM direct_messages WHERE id = ?', id);
    const recipient = await db.get('SELECT username FROM users WHERE id = ?', dm.recipient_id);
    io.to(`user:${me.username}`).emit('dm:message-deleted', { id });
    if (recipient) io.to(`user:${recipient.username}`).emit('dm:message-deleted', { id });
    await emitDmUnreadUpdate(me.username);
    if (recipient) await emitDmUnreadUpdate(recipient.username);
    return res.json({ success: true });
  });

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

  // Sync endpoint: return servers, channels, and messages
  app.get('/user/sync', authMiddleware, async (req, res) => {
    // for demo return full demo server
    const rows = await db.all('SELECT * FROM servers');
    const result = {};
    for (const s of rows) {
      const channels = await db.all("SELECT id, name, type, COALESCE(privacy, 'public') AS privacy FROM channels WHERE server_id = ?", s.id);
      const messagesByChannel = {};
      for (const ch of channels) {
        const msgs = await db.all('SELECT id, author, text, ts, attachment_json, reactions_json FROM messages WHERE server_id = ? AND channel_id = ? ORDER BY ts ASC', s.id, ch.id);
        messagesByChannel[ch.id] = msgs.map((m) => mapMessageRow(m, req.user.username));
      }
      result[s.id] = { id: s.id, name: s.name, channels, messages: messagesByChannel };
    }
    return res.json({ servers: result });
  });

  // Socket.IO handlers
  io.on('connection', (socket) => {
    console.log('socket connected', socket.id);
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
        const messages = await db.all('SELECT id, author, text, ts, attachment_json, reactions_json FROM messages WHERE server_id = ? AND channel_id = ? ORDER BY ts ASC', serverId, firstText.id);
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
        const messages = await db.all('SELECT id, author, text, ts, attachment_json, reactions_json, pinned_at, pinned_by FROM messages WHERE server_id = ? AND channel_id = ? ORDER BY ts ASC', serverId, channelId);
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

    socket.on('message', async ({ serverId = 'demo', channelId = 'general', text, attachment } = {}) => {
      // Refuse writes to channels the user can't see (belongs to server + private-access check).
      const ch = await db.get("SELECT id, COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
      if (!ch) return;
      const myRole = await roleOf(serverId, socketUser);
      if (!(await canAccessChannel(serverId, channelId, socketUser, ch.privacy, myRole))) return;
      const author = clients[socket.id]?.name || 'Anon';
      const body = (text || '').trim();
      const fileAttachment = normalizeAttachment(attachment);
      if (!body && !fileAttachment) return;
      const ts = Date.now();
      await db.run('INSERT INTO messages (server_id, channel_id, author, text, ts, attachment_json) VALUES (?, ?, ?, ?, ?, ?)', serverId, channelId, author, body, ts, fileAttachment ? JSON.stringify(fileAttachment) : null);
      const msgRow = await db.get('SELECT id, author, text, ts, attachment_json, reactions_json FROM messages WHERE rowid = last_insert_rowid()');
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
