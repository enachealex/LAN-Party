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
const { feedbackInput, inviteInput, inviteLinkInput, pushSubscribeInput, pushUnsubscribeInput, validate } = require('./validation');
const { migrate } = require('./db/schema');
const gifLibrary = require('./services/gifLibrary');
const { createActivities } = require('./services/activities');
const { isHostedApp, ownHostKeys, servedFromLoopback, checkHostedUrl, createAppRoomKeys, appFrameOrigin } = require('./services/hostedApps');
const { createAppRooms } = require('./services/appRooms');
const { userFileStatic, FRAME_ANCESTORS_SELF, frameAncestorsDirective, GIF_TYPES, SOUND_TYPES, SOUND_EXTENSIONS, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS, FEEDBACK_IMAGE_TYPES, storedExtension } = require('./services/userFiles');
const { createMessages } = require('./services/messages');
const { createSfu } = require('./services/sfu');
const { createAddressMonitor, fetchPublicAddress } = require('./services/sfuAddress');
const { createPush, mentionedUsernames, MAX_MENTION_TARGETS, MAX_LEVEL_TARGETS } = require('./services/push');
const { createNotificationSettings } = require('./services/notificationSettings');
const { createLinkPreviews, ownHostnames, IMAGE_DIR: LINK_PREVIEW_DIR } = require('./services/linkPreview');
const { createInstanceOwners } = require('./services/instanceOwners');
const { turnServerFor, turnConfigured } = require('./services/turnCredentials');
const { createTwoFactor } = require('./services/twoFactor');
const { createEmailVerification } = require('./services/emailVerification');
const { registerSecurityRoutes } = require('./routes/security');
const { createBlocks } = require('./services/blocks');
const { createModeration } = require('./services/moderation');
const { createPermissions } = require('./services/permissions');
const { createChannels } = require('./services/channels');
const { createAccessChanges } = require('./services/accessChanges');
const { registerRoleRoutes } = require('./routes/roles');
const { registerCategoryRoutes } = require('./routes/categories');
const { registerBlockRoutes } = require('./routes/blocks');
const { registerModerationRoutes } = require('./routes/moderation');
const { registerMediaRoutes } = require('./routes/media');
const { registerAuthRoutes } = require('./routes/auth');
const { registerSocialRoutes } = require('./routes/social');
const { registerGroupRoutes } = require('./routes/groups');
const { registerVaultRoutes } = require('./routes/vault');
const { registerServerRoutes } = require('./routes/servers');
const { registerInviteRoutes } = require('./routes/invites');
const { registerLibraryRoutes } = require('./routes/library');
const { registerPushRoutes } = require('./routes/push');
const { registerSearchRoutes } = require('./routes/search');
const { registerNotificationRoutes } = require('./routes/notifications');
const { PAGE_DEFAULT, fetchPage, channelHistory } = require('./services/history');
const { rateLimit } = require('./rateLimit');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
const PORT = process.env.PORT || 3000;
// Deployment config (all optional — defaults keep the local dev setup working):
//  DATA_DIR       persistent dir for the SQLite db + uploads/gifs/sounds (mount a volume here)
//  CLIENT_DIST    path to the built client (client/dist) to serve; enables single-origin hosting
//  CLIENT_ORIGIN  comma-separated allowed origins for CORS/Socket.IO ('*' = any, the default)
//  STUN_URLS / TURN_URLS / TURN_SECRET / TURN_TTL_SECONDS  WebRTC ICE servers sent to clients; a TURN
//                 credential is minted per signed-in person from TURN_SECRET (services/turnCredentials.js).
//                 TURN_USERNAME / TURN_CREDENTIAL: the older fixed credential, used only without TURN_SECRET
//  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT  Web Push identity; see services/push.js
//                 (unset = a keypair is generated once and kept in DATA_DIR/vapid.json)
//  INSTANCE_OWNERS  comma-separated usernames who run this instance: they approve uploaded apps for
//                 the public directory (unset or empty = the oldest account). The accounts must
//                 already exist, spelled exactly: a listed name can no longer be registered or
//                 renamed into, and one that matches no account is logged at boot.
//                 services/instanceOwners.js
//  LINK_PREVIEWS  set to 0 to stop the server fetching the pages people link to (the preview cards
//                 under messages). On by default; what is fetched, and the rules it is held to, are
//                 in services/linkPreview.js. Previews already stored stay on their messages.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '..', 'client', 'dist');
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const corsOrigin = CLIENT_ORIGIN === '*' ? '*' : CLIENT_ORIGIN.split(',').map((s) => s.trim());
// The origins this instance is configured to be served from. A hosted app may never be on one of
// them (services/hostedApps.js); '*' names none, and then only the request itself says where we are.
const ownOrigins = corsOrigin === '*' ? [] : corsOrigin.filter(Boolean);
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024;
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // uploads are deleted 7 days after upload
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // sweep hourly
const SOUND_NAME_MAX = 12; // keep soundboard names short enough to fit a tile

// Raster image types accepted for rail tile icons, mapped to the extension we store them under.
// Deliberately no SVG (scriptable) and no GIF (the client never produces one, and refusing it keeps
// hand-crafted animated tiles out).
const TILE_ICON_TYPES = { 'image/webp': '.webp', 'image/png': '.png', 'image/jpeg': '.jpg' };
// Avatars additionally allow GIF — animated profile pictures are a thing people want, and the old
// /files/upload path accepted them, so refusing one here would be a regression. Still no SVG.
const AVATAR_TYPES = { ...TILE_ICON_TYPES, 'image/gif': '.gif' };

// Raster image signatures, longest-prefix first so 'RIFF….WEBP' can't be mistaken for anything else.
// Every candidate must still supply the full HEADER_BYTES below: the smallest decodable file of any of
// these formats is far larger than that (a 1x1 GIF is ~35 bytes), so a file that is nothing but a
// signature — a truncated download — is malformed, and accepting it would store an avatar that renders
// broken everywhere while reporting success.
const HEADER_BYTES = 12;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const IMAGE_SIGNATURES = [
  { format: 'webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  { format: 'png', test: (b) => b.subarray(0, 8).equals(PNG_SIGNATURE) },
  { format: 'gif', test: (b) => ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  { format: 'jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
];
const FORMAT_EXTENSIONS = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' };

/**
 * Identify a file by its leading bytes. A declared mime type is only a client claim, and these files
 * are served back as <img> sources, so the bytes decide both whether we keep the file and what
 * extension (and therefore Content-Type) it is stored under.
 * @param {string} filePath
 * @returns {Promise<'png'|'jpeg'|'webp'|'gif'|null>} null when it isn't a recognised raster image
 */
async function detectImageFormat(filePath) {
  let fh;
  try {
    fh = await fs.promises.open(filePath, 'r');
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(HEADER_BYTES), 0, HEADER_BYTES, 0);
    if (bytesRead < HEADER_BYTES) return null; // too short to be any real image
    for (const sig of IMAGE_SIGNATURES) {
      if (sig.test(buffer)) return sig.format;
    }
    return null;
  } catch (_) {
    return null;
  } finally {
    try { await fh?.close(); } catch (_) { /* already closed */ }
  }
}

function isStrongPassword(pw) {
  if (typeof pw !== 'string') return false;
  // at least 8 chars, 1 lower, 1 upper, 1 digit, 1 special char
  return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/.test(pw);
}

async function main() {
  const app = express();
  app.set('trust proxy', 1); // we sit behind an HTTPS reverse proxy in production
  // Nothing but LAN Party itself (and the client origins it is configured with) may frame a LAN
  // Party page: a page that framed it could dress it up and get clicks it never meant to give.
  // Every response carries it; the routes that send a CSP of their own (/app-bundles, the uploaded
  // file mounts) repeat the directive in it, because a second CSP header there would be a second
  // policy, not a merged one. X-Frame-Options is for browsers that predate frame-ancestors; any
  // browser that knows frame-ancestors ignores it.
  // Nothing frames LAN Party from another origin today: the desktop app and the Android app load
  // it as a top-level page, and Vault Player only talks to LAN Party's API server-to-server and is
  // itself what LAN Party embeds, never the other way round (docs/VAULT-PLAYER-INTEGRATION.md).
  const FRAME_ANCESTORS = frameAncestorsDirective(ownOrigins);
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', FRAME_ANCESTORS);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
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
  // Uploaded, LAN-Party-hosted mini-apps (one subfolder per app). Persistent (outside /uploads),
  // served sandboxed below so their JS can't touch the LAN Party session.
  const appBundlesDir = path.join(DATA_DIR, 'app-bundles');
  fs.mkdirSync(appBundlesDir, { recursive: true });
  // Per-user voice-chat entrance clips ("walk-on" sounds). Persistent (outside /uploads) — these are
  // part of a profile, so they must outlive the 7-day upload sweep.
  const entrancesDir = path.join(DATA_DIR, 'entrances');
  fs.mkdirSync(entrancesDir, { recursive: true });
  // Custom rail-tile images (a user's Home tile, a server's icon). Persistent for the same reason as
  // the entrance clips: they're part of an identity, so the 7-day upload sweep must not reach them.
  // Profile pictures. These used to go through /files/upload into uploads/, where the 7-day sweep
  // deleted them — so an avatar silently vanished about a week after it was set. Persistent now, for
  // the same reason as the entrance clips and tile icons.
  const avatarsDir = path.join(DATA_DIR, 'avatars');
  fs.mkdirSync(avatarsDir, { recursive: true });
  const tileIconsDir = path.join(DATA_DIR, 'tile-icons');
  fs.mkdirSync(tileIconsDir, { recursive: true });
  // The images of link preview cards (services/linkPreview.js): fetched by the server, stored by
  // content hash, and served from here so that a reader's browser never asks the linked site for
  // anything. Outside /uploads: they have a sweep of their own, which keeps what messages still show.
  const linkPreviewsDir = path.join(DATA_DIR, LINK_PREVIEW_DIR);
  fs.mkdirSync(linkPreviewsDir, { recursive: true });

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

  // The libraries below keep their files for good and serve them from this origin, so the name a
  // file is stored under is never the client's: a generated stem, and an extension from the type
  // that was accepted (services/userFiles.js). A type outside the list is refused before anything
  // is written. The client's filename is only ever consulted as a fallback key into that same list.
  /**
   * @param {string} dir
   * @param {Readonly<Record<string, string>>} types
   * @param {Readonly<Record<string, string>>} extensions
   * @param {string | null} refusal the error for a type outside the list; null drops the file quietly
   * @param {number} maxBytes
   */
  const libraryUpload = (dir, types, extensions, refusal, maxBytes) => multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, dir),
      filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${storedExtension(file, types, extensions)}`),
    }),
    limits: { fileSize: maxBytes },
    fileFilter: (_req, file, cb) => {
      if (storedExtension(file, types, extensions)) return cb(null, true);
      return refusal ? cb(new Error(refusal)) : cb(null, false);
    },
  });

  // Separate storage for the persistent GIF library (not subject to upload expiry).
  const gifUpload = libraryUpload(gifsDir, GIF_TYPES, {}, 'Only GIF, PNG, JPEG, WebP or AVIF images can be added to the GIF library', MAX_UPLOAD_SIZE);

  // Persistent storage for soundboard clips.
  const soundUpload = libraryUpload(soundsDir, SOUND_TYPES, SOUND_EXTENSIONS, 'Only audio files (MP3, WAV, Ogg, Opus, WebM, AAC, M4A or FLAC) can be added to the soundboard', MAX_UPLOAD_SIZE);

  // Voice-chat entrance clips: a few seconds of recorded audio, so the cap is small.
  const ENTRANCE_MAX_BYTES = 2 * 1024 * 1024;
  const entranceUpload = libraryUpload(entrancesDir, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS, 'Entrance clip must be an audio recording', ENTRANCE_MAX_BYTES);

  // Rail tile images. The client crops to a square and re-encodes before uploading, so what arrives
  // is a ~20KB thumbnail; the cap is generous only to leave room for a PNG fallback from an old
  // browser. SVG is refused outright further down — it can carry script, and these are <img> sources.
  const TILE_ICON_MAX_BYTES = 2 * 1024 * 1024;
  const tileIconUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, tileIconsDir),
      filename: (_req, file, cb) => {
        // Generated name, never the client's: the extension comes from the mime type we accepted.
        const ext = TILE_ICON_TYPES[file.mimetype] || '.png';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      },
    }),
    limits: { fileSize: TILE_ICON_MAX_BYTES },
    fileFilter: (_req, file, cb) => cb(null, Object.hasOwn(TILE_ICON_TYPES, file.mimetype || '')),
  });

  // Profile pictures. Larger cap than a tile: the client crops stills to 256px, but GIFs (kept animated) aren't cropped, and still
  // far below the general upload limit — an avatar renders at ~40px.
  const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
  const avatarUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, avatarsDir),
      filename: (_req, file, cb) => {
        // Provisional extension from the accepted mime type; the receiver re-names it to match the
        // bytes it actually finds, so a lying Content-Type can't decide how this is served later.
        const ext = AVATAR_TYPES[file.mimetype] || '.png';
        cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      },
    }),
    limits: { fileSize: AVATAR_MAX_BYTES },
    fileFilter: (_req, file, cb) => cb(null, Object.hasOwn(AVATAR_TYPES, file.mimetype || '')),
  });

  // Screenshots on feedback/bug reports — raster images only, capped at 15 MB, stored persistently.
  // Anything else is dropped without failing the report, as a non-image always was.
  const feedbackUpload = libraryUpload(feedbackDir, FEEDBACK_IMAGE_TYPES, {}, null, 15 * 1024 * 1024);

  // Mini-app bundle uploads (a single .html or a .zip). In memory so the extractor can validate the
  // archive before anything touches disk; capped at 15 MB compressed.
  const bundleUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

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
  const stunUrls = () => (process.env.STUN_URLS || 'stun:stun.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean);
  // STUN for anyone; a TURN relay credential only for a signed-in person (services/turnCredentials.js).
  // The session is checked by hand rather than with authMiddleware so that a client without one (an
  // old build, the sign-in screen) still gets STUN and a 200, as before. `ttl` tells the client when to
  // ask again.
  app.get('/webrtc/ice', (req, res) => {
    const iceServers = [{ urls: stunUrls() }];
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    let ttl = null;
    if (token) {
      try {
        const { username } = sessionClaims(token);
        const turn = turnServerFor(username);
        if (turn) {
          iceServers.push({ urls: turn.urls, username: turn.username, credential: turn.credential });
          if (turn.expiresAt) ttl = turn.expiresAt - Math.floor(Date.now() / 1000);
        }
      } catch (_) { /* no valid session: STUN only */ }
    }
    res.setHeader('Cache-Control', 'no-store'); // per person, and the credential expires
    res.json(ttl ? { iceServers, ttl } : { iceServers });
  });
  // Everything people upload is served through userFileStatic (services/userFiles.js): nosniff, a
  // scriptless sandbox CSP, and anything that is not media or plain text sent as a download, so no
  // uploaded file is ever a live page on this origin.
  app.use('/uploads', userFileStatic(uploadDir, FRAME_ANCESTORS));
  // redirect:false so a bare `GET /gifs` isn't turned into a directory redirect,
  // letting it fall through to the GIF-list API route below.
  app.use('/gifs', userFileStatic(gifsDir, FRAME_ANCESTORS, { redirect: false }));
  app.use('/sounds', userFileStatic(soundsDir, FRAME_ANCESTORS, { redirect: false }));
  app.use('/entrances', userFileStatic(entrancesDir, FRAME_ANCESTORS, { redirect: false }));
  // Terminal for this mount: a deleted/missing clip must 404 rather than fall through to the SPA
  // catch-all, which would hand an <audio> element the client's HTML with a 200.
  app.use('/entrances', (req, res) => res.status(404).type('txt').send('Not found'));
  app.use('/tile-icons', express.static(tileIconsDir, { redirect: false }));
  // Terminal for the same reason: a reset tile must 404, not receive the SPA shell with a 200.
  app.use('/tile-icons', (req, res) => res.status(404).type('txt').send('Not found'));
  app.use('/avatars', express.static(avatarsDir, { redirect: false }));
  // Terminal for the same reason: a removed avatar must 404 rather than fall through to the SPA
  // catch-all, which would hand an <img> the client's HTML with a 200 and look merely broken.
  app.use('/avatars', (req, res) => res.status(404).type('txt').send('Not found'));
  // Desktop installer + electron-updater feed. The updater fetches /downloads/latest.yml at startup.
  // Leave these cacheable. Cloudflare caches .exe/.apk by extension and revalidates with the ETag, so
  // a download costs the origin a 304. Marked private, every request (even a partial or abandoned one)
  // pulled the whole 111 MB installer through the home uplink. The updater's range requests were
  // the worst case.
  app.use('/downloads', express.static(downloadsDir, { redirect: false }));
  // Feedback/bug-report screenshots — linked from Vaultline tickets, so served publicly (read-only).
  app.use('/feedback-media', userFileStatic(feedbackDir, FRAME_ANCESTORS, { redirect: false }));
  // Link preview images. These bytes came from a site somebody linked to, so they get the same
  // treatment as anything a person uploads (nosniff, the scriptless sandbox CSP, a versioned ETag),
  // on top of only ever being stored as PNG, JPEG, GIF or WebP in the first place.
  app.use('/link-previews', userFileStatic(linkPreviewsDir, FRAME_ANCESTORS, { redirect: false }));
  // Terminal: an image that has been swept must 404, not hand an <img> the SPA shell with a 200.
  app.use('/link-previews', (req, res) => res.status(404).type('txt').send('Not found'));
  // Uploaded mini-apps. The CSP `sandbox` directive (WITHOUT allow-same-origin) forces every bundle
  // document into an OPAQUE origin — so its JS can't read LAN Party cookies/localStorage or call the
  // API with the user's session, whether it's loaded in the embed iframe OR opened directly. This
  // header is the core isolation for running user-uploaded code on our own origin.
  // frame-ancestors is repeated in the same header (one policy, both directives): 'self' is the
  // origin of the bundle's url, not the opaque origin the sandbox gives the document, so LAN Party
  // can still frame its own bundles and nobody else can.
  app.use('/app-bundles', (req, res, next) => {
    res.setHeader('Content-Security-Policy', `sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock; ${FRAME_ANCESTORS}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  }, express.static(appBundlesDir, { redirect: false, index: 'index.html', dotfiles: 'ignore' }));
  // Terminal for this mount: a missing/deleted bundle must 404 here rather than fall through to the
  // SPA catch-all (which would serve the client shell for a bundle path — misleading, and it would
  // mask a bundle's broken asset references).
  app.use('/app-bundles', (req, res) => res.status(404).type('txt').send('Not found'));
  // The app bridge SDK that uploaded mini-apps load with <script src="/sdk/lanparty.js">. A bundle
  // document runs in an opaque origin (see the sandbox CSP above), so to it this is a cross-origin
  // fetch: the CORS header keeps it loadable however the app pulls it in (plain script, module,
  // fetch). The file is public and identical for everyone — there is nothing here to protect.
  // no-cache: a copy may be kept, but is checked with the server before every use, so a fixed shim
  // reaches running apps at their next load. The check is cheap (sendFile's ETag answers it with a
  // 304 and no body). It was `max-age=300`, which never held in production: Cloudflare rewrites a
  // max-age shorter than its configured browser TTL up to that TTL (4 hours), so browsers could go
  // on running a stale SDK for hours. no-cache carries no lifetime for it to raise.
  const SDK_FILE = path.join(__dirname, 'sdk', 'lanparty.js');
  const SDK_HEADERS_VERSION = 'sdk3';
  let sdkEtagCache = null; // { mtimeMs, etag }: rehashed only when the file changes (it does not, between deploys)
  const sdkEtag = () => {
    const { mtimeMs } = fs.statSync(SDK_FILE);
    if (!sdkEtagCache || sdkEtagCache.mtimeMs !== mtimeMs) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(SDK_FILE)).digest('hex').slice(0, 20);
      sdkEtagCache = { mtimeMs, etag: `W/"${SDK_HEADERS_VERSION}-${digest}"` };
    }
    return sdkEtagCache.etag;
  };
  app.get('/sdk/lanparty.js', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // 'private' as well: the CDN replaces a response's browser lifetime with its own (4 hours)
    // unless the response is private or no-store, and no-cache alone was rewritten too. Private also
    // keeps it out of the CDN's cache, which is no loss for a file this small.
    res.setHeader('Cache-Control', 'private, no-cache');
    // Our own validator, and the only one. The CDN keeps a stored copy's old headers for as long as
    // its revalidation is answered 'not modified', so a header change (like the line above) never
    // reached a copy cached before it. An ETag made from the content plus a version for these headers
    // makes every earlier validator stale; bump SDK_HEADERS_VERSION when the headers here change.
    res.setHeader('ETag', sdkEtag());
    res.type('application/javascript').sendFile(SDK_FILE, { lastModified: false });
  });
  // Terminal for the same reason as the mounts above: a mistyped SDK path must 404, not hand a
  // <script> tag the SPA shell with a 200.
  app.use('/sdk', (req, res) => res.status(404).type('txt').send('Not found'));
  // Static images used by the landing page (app screenshots). Committed with the repo.
  app.use('/landing-assets', express.static(path.join(__dirname, 'landing-assets'), { redirect: false }));
  // Digital Asset Links for the Android app (a Trusted Web Activity). Chrome fetches this to verify
  // that com.thejumpvault.lanparty is signed by our key; once verified, the app runs full-screen with
  // no URL bar. Generated by `android/` (npm run generate) from the signing key — must be at the
  // domain root. A dedicated route because express.static ignores dot-directories.
  const ASSETLINKS_FILE = path.join(__dirname, '..', 'android', 'assetlinks.json');
  app.get('/.well-known/assetlinks.json', (req, res) => {
    if (!fs.existsSync(ASSETLINKS_FILE)) return res.status(404).type('txt').send('Not found');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/json').sendFile(ASSETLINKS_FILE);
  });
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
  // GIFs added before the library kept hashes get one now, so re-adding one is caught as a
  // duplicate (services/gifLibrary.js). In the background: boot does not wait on hashing files.
  gifLibrary.backfillHashes(db, gifsDir)
    .then((n) => { if (n) console.log(`[gifs] hashed ${n} existing GIF${n === 1 ? '' : 's'}`); })
    .catch((err) => console.warn('[gifs] could not hash existing GIFs:', err.message));
  // Who runs this instance (services/instanceOwners.js). Always asked with a username the server
  // established itself (a verified token), never one a client sent.
  const { instanceOwners, isInstanceOwner, isReservedName: isReservedOwnerName, isListedName: isListedOwnerName, configProblems: instanceOwnerProblems } = createInstanceOwners({ db });
  // Said at every boot rather than refused: a typo here must not keep the whole server down, but it
  // does mean nobody can review apps, and nothing else would ever say so.
  for (const problem of await instanceOwnerProblems()) console.warn(problem);

  // Rescue profile pictures that were uploaded before avatars had their own folder. They sit in
  // uploads/, which the 7-day sweep empties, so without this every existing avatar still disappears —
  // fixing only NEW uploads would leave the reported bug in place for everyone who already has one.
  //
  // Copies rather than moves (the same file may also be referenced by the chat message it was posted
  // through) and only rewrites a profile after its copy succeeded, so a failure part-way leaves the
  // old, working url in place. Idempotent: once rewritten, the url no longer matches.
  async function rescueLegacyAvatars() {
    let rows;
    try {
      rows = await db.all("SELECT username, settings FROM users WHERE settings LIKE '%/uploads/%'");
    } catch (_) {
      return; // never block boot on this
    }
    let moved = 0;
    for (const row of rows) {
      let s;
      try { s = JSON.parse(row.settings || '{}') || {}; } catch (_) { continue; }
      const url = s.profile?.avatarUrl;
      if (typeof url !== 'string' || !url.startsWith('/uploads/')) continue;
      const source = path.resolve(uploadDir, path.basename(url));
      if (!source.startsWith(uploadDir + path.sep)) continue;
      try {
        if (!fs.existsSync(source)) continue; // already swept — nothing left to rescue
        const format = await detectImageFormat(source);
        if (!format) continue; // not an image we can vouch for; leave the url alone
        const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${FORMAT_EXTENSIONS[format]}`;
        await fs.promises.copyFile(source, path.join(avatarsDir, filename));
        s.profile = { ...(s.profile || {}), avatarUrl: `/avatars/${filename}` };
        await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(s), row.username);
        moved += 1;
      } catch (err) {
        console.warn('[avatars] could not rescue', url, err && err.message);
      }
    }
    if (moved) console.log(`[avatars] moved ${moved} profile picture(s) out of uploads/ so they stop expiring`);
  }
  await rescueLegacyAvatars();

  const clients = {}; // socketId -> { name, username, serverId }
  // Shared image editing, keyed by the session's socket room (collabRoom in the connection handler):
  // room -> { sessionId, imageUrl, segments: [], serverId, channelId }. A session started in a
  // channel belongs to it (serverId/channelId set) and is held to that channel's rules; one opened
  // from a direct conversation has neither and is just the image url. No prototype: every socket
  // room name is looked up here, and none of them may find an inherited property.
  const collabSessions = Object.create(null);
  const liveStreams = {}; // socketId -> { name, serverId, channelId, camera, screen } for Watch/Discover
  const externalStreams = {}; // socketId -> { name, platform, channel, title, game } — "I'm live on Twitch/YouTube/Kik"
  const EXTERNAL_PLATFORMS = ['twitch', 'youtube', 'kik'];

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

  // --- Activities: any number per voice room, each person in at most one ---
  // Starting one puts only its starter in it; everyone else in the call sees it in the list of
  // what is running (activity:list) and can join it, or start another. Each activity's updates go
  // to the people in it (act.viewers). One ends when the last person in it leaves, or when someone
  // in it ends it for everyone in it.
  const activities = {}; // room -> Map(id -> { id, type, state, by, viewers: Set<socketId> })
  const viewingOf = {}; // socketId -> { room, id }: the activity this socket is in
  const MAX_ACTIVITIES_PER_ROOM = 12;
  // Activity state machine + per-socket views (services/activities.js).
  const {
    ACTIVITY_TYPES, activityInit, applyActivityEvent, activityViewFor, broadcastActivity,
    APP_ACTIVITY, appActivityInit, applyAppEvent, appLeave, appJoinedSockets, appEventAllowed, forgetAppSocket,
  } = createActivities({ io, clients });
  // What an app is told in place of "which voice channel is this" (services/hostedApps.js). Keyed
  // from JWT_SECRET under its own label: no new secret to keep, and nothing learned from a room key
  // helps with a session token or the other way round.
  const appRoomKey = createAppRoomKeys(JWT_SECRET);

  const roomActs = (room) => activities[room] || (activities[room] = new Map());
  // The activity this socket is in, in that room, or null.
  function actViewedBy(room, socketId) {
    const v = viewingOf[socketId];
    return v && v.room === room ? (activities[room]?.get(v.id) || null) : null;
  }
  const toViewers = (act, event, payload, exceptId = null) => {
    for (const id of act.viewers) if (id !== exceptId) io.to(id).emit(event, payload);
  };
  // What everyone in the call is told about what is running: enough for a row with a Join button,
  // never the activity's state (an app's room key, the sketch word, a whiteboard's strokes).
  function activityList(room) {
    const acts = activities[room];
    if (!acts) return [];
    return [...acts.values()].map((act) => ({
      id: act.id,
      type: act.type,
      by: act.by,
      name: act.type === APP_ACTIVITY ? act.state.name : null,
      icon: act.type === APP_ACTIVITY ? (act.state.iconUrl || null) : null,
      approved: act.type === APP_ACTIVITY ? act.state.approved !== false : true,
      people: [...new Set([...act.viewers].map((id) => clients[id]?.name).filter(Boolean))],
    }));
  }
  const sendActivityList = (room) => io.to(room).emit('activity:list', activityList(room));
  function dropActivity(room, act) {
    const acts = activities[room];
    if (!acts) return;
    acts.delete(act.id);
    if (!acts.size) delete activities[room];
  }
  // Take a socket out of the activity it is in. The activity ends when nobody is left in it.
  // Returns the room it was in, or null.
  function leaveActivity(socketId, { notify = true } = {}) {
    const v = viewingOf[socketId];
    if (!v) return null;
    delete viewingOf[socketId];
    const act = activities[v.room]?.get(v.id);
    if (act) {
      act.viewers.delete(socketId);
      if (!act.viewers.size) dropActivity(v.room, act);
      // Leaving the activity leaves the app too: the people still playing must see them go.
      else if (appLeave(act, socketId)) toViewers(act, 'activity:app-joined', { run: act.state.run, joined: act.state.joined });
    }
    if (notify) io.to(socketId).emit('activity:update', null);
    return v.room;
  }
  // Put a socket in an activity (leaving the one it was in) and send it its view.
  function enterActivity(sock, room, act) {
    if (viewingOf[sock.id]?.id !== act.id) {
      leaveActivity(sock.id, { notify: false });
      act.viewers.add(sock.id);
      viewingOf[sock.id] = { room, id: act.id };
    }
    sock.emit('activity:update', activityViewFor(act, sock.id));
  }
  // End an activity for everyone in it.
  function endActivity(room, act) {
    for (const id of act.viewers) { delete viewingOf[id]; io.to(id).emit('activity:update', null); }
    act.viewers.clear();
    dropActivity(room, act);
  }
  const newActivityId = () => crypto.randomBytes(6).toString('hex');
  // An app that is deleted while a room is running it: end it there. The bundle's files are about to
  // go, and a room left pointing at them would offer everyone a "Join" that opens a 404.
  // The same goes for one that is rejected or unpublished (the room would keep running an app that
  // is no longer everyone's to start), has its bundle replaced (the files it points at are going),
  // or is a hosted app whose address or "run inside" setting was edited (the room is on the old one).
  function endAppActivities(appId) {
    endAppActivitiesWhere((room, act) => act.state.appId === appId);
  }
  // Every app running in one server's voice rooms: its room keys were just replaced (a rotation,
  // services/appRooms.js), or the server itself is gone. Server ids never contain a colon, so the
  // prefix names that server's rooms and no other's.
  function endAppActivitiesInServer(serverId, reason = null) {
    const prefix = `voice:${serverId}:`;
    endAppActivitiesWhere((room) => room.startsWith(prefix), reason);
  }
  // The one place an app activity is ended from outside its room. With a `reason`, the people who
  // had JOINED it are told why first (their app is about to vanish mid-use); the rest of the room
  // only ever saw a card, and for them it just goes away, as it does on any other ending.
  function endAppActivitiesWhere(matches, reason = null) {
    for (const [room, acts] of Object.entries(activities)) {
      let changed = false;
      for (const act of [...acts.values()]) {
        if (act.type !== APP_ACTIVITY || !matches(room, act)) continue;
        if (reason) for (const id of appJoinedSockets(act)) io.to(id).emit('activity:app-ended', { run: act.state.run, reason });
        endActivity(room, act);
        changed = true;
      }
      if (changed) sendActivityList(room);
    }
  }
  // An app that is published while its uploader has it running as a draft: the rooms' join cards
  // stop saying it is unapproved. Each person gets their own view again, as on any other update.
  function approveAppActivities(appId) {
    for (const [room, acts] of Object.entries(activities)) {
      let changed = false;
      for (const act of acts.values()) {
        if (act.type !== APP_ACTIVITY || act.state.appId !== appId || act.state.approved) continue;
        act.state.approved = true;
        broadcastActivity(room, act);
        changed = true;
      }
      if (changed) sendActivityList(room);
    }
  }
  // The public commons: every account is a member of it, and nobody is ever removed from it.
  const DEMO_ID = 'demo';
  // Per-server app room epochs: how room keys are revoked when someone loses access, or by hand
  // (services/appRooms.js, which lists every caller). Never for the commons.
  const appRooms = createAppRooms({ db, commonsId: DEMO_ID, endAppActivitiesInServer });

  // Message parsing/serialisation + reaction & pin storage (services/messages.js).
  const {
    parseAttachment, normalizeAttachment, parseReactions, formatReactions,
    sanitizeQuotes, parseQuotes, mapMessageRow, channelPins, toggleReaction,
  } = createMessages({ db });

  // Web Push for people whose app is closed (services/push.js). Off, harmlessly, when the web-push
  // module is not installed on this host.
  const push = createPush({ db, dataDir: DATA_DIR, clientOrigin: CLIENT_ORIGIN });

  // Blocking between two accounts (services/blocks.js) and per-server bans, timeouts and the audit
  // log (services/moderation.js). Both are consulted from the socket handlers below as well as
  // from their routes: every rule they describe is enforced here, never left to the client.
  const blocks = createBlocks({ db });
  const moderation = createModeration({ db, commonsId: DEMO_ID });
  // Who may do what in a server: the built-in owner/admin/member, custom roles and their
  // permissions, rank, and who can open which channel (services/permissions.js). Every check in
  // the routes and in the socket handlers below asks it; none of them decides for itself.
  const permissions = createPermissions({ db, commonsId: DEMO_ID });
  // Channel order and categories (services/channels.js).
  const channelLists = createChannels({ db });
  // How loudly each server, channel and conversation may reach each person
  // (services/notificationSettings.js). Consulted wherever a push is decided.
  const notificationSettings = createNotificationSettings({ db });
  // Link preview cards (services/linkPreview.js): the one place the server fetches an address a
  // member chose. LINK_PREVIEWS=0 turns the fetching off.
  const linkPreviews = createLinkPreviews({ db, dataDir: DATA_DIR });
  // The names a link must never be fetched from because they are this server: wherever the request
  // (or socket handshake) says it was sent, the CLIENT_ORIGIN list, and PUBLIC_APP_URL when set.
  const ownOriginsForPreviews = [...ownOrigins, ...(process.env.PUBLIC_APP_URL ? [process.env.PUBLIC_APP_URL] : [])];
  const ownHostsFor = (headers) => ownHostnames(headers, ownOriginsForPreviews);

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
    // A muted conversation keeps its own count (the row still shows it, dimmed) but stays out of
    // the total, which is what the Messages badge shows (services/notificationSettings.js).
    const muted = await notificationSettings.mutedDmPeers(userId);
    const totalUnread = rows.reduce((sum, r) => sum + (muted.has(r.peerId) ? 0 : r.unreadCount), 0);
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

  /**
   * May these two people exchange direct messages? Friends always can. Beyond that, sharing a server
   * counts: the member list offers a private message, and demanding a friend request first would make
   * that a dead menu item. Server membership is itself deliberate — you are added by an owner or
   * admin — so it is a meaningful association rather than "any account can message any account".
   *
   * This is the rule without blocking, and it is what decides whether an existing conversation may
   * still be READ: a block closes a conversation to new messages, it does not take the old ones
   * away from either side (mayReadDirectMessages). Whether the two may CONTACT each other now is
   * canDirectMessage, below.
   * @param {number} meId @param {string} meUsername @param {number} peerId @param {string} peerUsername
   * @returns {Promise<boolean>}
   */
  async function sharesFriendshipOrServer(meId, meUsername, peerId, peerUsername) {
    if (await areFriends(meId, peerId)) return true;
    const shared = await db.get(
      `SELECT 1 FROM server_members mine
         JOIN server_members theirs ON theirs.server_id = mine.server_id
        WHERE mine.username = ? AND theirs.username = ?
        LIMIT 1`,
      meUsername,
      peerUsername
    );
    return !!shared;
  }

  /**
   * May these two contact each other right now: send a direct message, show "typing", ring, be
   * added to a group chat by the other? The rule above, and no block between them in EITHER
   * direction (the person who blocked has to unblock before reaching out again).
   *
   * A block makes this false in exactly the way a stranger makes it false, and every caller
   * answers a false the way it always has ("You can only message friends or people you share a
   * server with"). That is deliberate: the blocked person must not be able to tell a block from
   * simply not being reachable, so no caller may branch on WHY this said no.
   * @param {number} meId @param {string} meUsername @param {number} peerId @param {string} peerUsername
   * @returns {Promise<boolean>}
   */
  async function canDirectMessage(meId, meUsername, peerId, peerUsername) {
    // Both questions are always asked, blocked or not, so a refusal does the same work (and takes
    // the same time) whichever of them caused it.
    const blocked = await blocks.between(meId, peerId);
    const reachable = await sharesFriendshipOrServer(meId, meUsername, peerId, peerUsername);
    return reachable && !blocked;
  }

  /**
   * May `me` open the conversation with `peer` to read it? Whoever could before a block still can:
   * the rule without blocking, so that the blocked person sees no change at all. On top of that,
   * the person who placed a block keeps their side of the conversation even when the block was the
   * last thing connecting them (it ends the friendship): their own block is no secret to them.
   * @param {number} meId @param {string} meUsername @param {number} peerId @param {string} peerUsername
   * @returns {Promise<boolean>}
   */
  async function mayReadDirectMessages(meId, meUsername, peerId, peerUsername) {
    if (await sharesFriendshipOrServer(meId, meUsername, peerId, peerUsername)) return true;
    return blocks.hasBlocked(meId, peerId);
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
      overlayColor: p.overlayColor || '',
      nameStyle: p.nameStyle || null,
      nameFont: p.nameFont || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
    };
  }

  // What makes a token a SESSION: signed with JWT_SECRET, and it names an account. Both checks
  // that accept sessions (authMiddleware for HTTP, the socket handshake) go through here. A
  // two-factor sign-in ticket fails the first test already (it is signed with a different key,
  // services/twoFactor.js); the second is there so that nothing carrying a `purpose` or lacking a
  // username can ever be mistaken for one, whatever signs such a thing in future.
  /** @param {string} token @returns {any} the claims; throws when it is not a session */
  function sessionClaims(token) {
    const payload = /** @type {any} */ (jwt.verify(token, JWT_SECRET));
    if (!payload || typeof payload.username !== 'string' || !payload.username || payload.purpose) throw new Error('not a session token');
    return payload;
  }

  // Two-factor sign-in and email verification (services/twoFactor.js, services/emailVerification.js).
  const twoFactor = createTwoFactor({ db, secret: JWT_SECRET });
  const emailVerification = createEmailVerification({ db, mailer });
  // For a route an account may not use until its email is confirmed; goes after authMiddleware.
  const { requireVerified } = emailVerification;
  console.log(emailVerification.required()
    ? '[email] new accounts must verify their email address'
    : '[email] no mailer configured: email verification is not required');

  function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const payload = sessionClaims(token);
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
  registerAuthRoutes({ app, db, authMiddleware, twoFactor, emailVerification, JWT_SECRET, isStrongPassword, isInstanceOwner, isReservedOwnerName, appRooms, endAppActivitiesInServer });

  app.get('/user/settings', authMiddleware, async (req, res) => {
    const username = req.user.username;
    const user = await db.get('SELECT settings FROM users WHERE username = ?', username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json({ settings: JSON.parse(user.settings || '{}') });
  });

  app.post('/user/settings', authMiddleware, async (req, res) => {
    const username = req.user.username;
    const settings = req.body.settings || {};
    const user = await db.get('SELECT id, settings AS previous FROM users WHERE username = ?', username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let before = {};
    try { before = JSON.parse(user.previous || '{}') || {}; } catch { before = {}; }
    const storedAvatar = before.profile?.avatarUrl;
    const hasProfile = typeof settings.profile === 'object' && settings.profile !== null;

    // Saving a profile posts the WHOLE profile object from client state, so a client can send an
    // avatarUrl it captured before something else changed it — a second tab or device, or a session
    // that was open when rescueLegacyAvatars ran. Writing a stale pointer is doubly destructive: the
    // profile ends up aimed at a file that is already gone, AND the release below then deletes the
    // picture that was actually current, losing both. Two guards, in order:
    const incomingAvatar = hasProfile ? settings.profile.avatarUrl : undefined;
    const keepStored = () => {
      settings.profile = { ...settings.profile, avatarUrl: typeof storedAvatar === 'string' ? storedAvatar : '' };
    };
    if (typeof incomingAvatar === 'string' && incomingAvatar !== storedAvatar) {
      // 1. A legacy /uploads url never wins over a migrated /avatars one, even if the original file is
      //    still lying around un-swept — nothing legitimately points an avatar at /uploads any more.
      if (incomingAvatar.startsWith('/uploads/') && typeof storedAvatar === 'string' && storedAvatar.startsWith('/avatars/')) {
        keepStored();
      // 2. Any of our own urls whose file is missing is a stale pointer, not a choice.
      } else if (incomingAvatar.startsWith('/avatars/') && !managedAvatarExists(incomingAvatar)) {
        keepStored();
      }
    }

    await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(settings), username);

    // This is a wholesale settings write, so it's also where an avatar stops being referenced —
    // "Remove" then Save, or replacing the picture with a pasted URL. Clean up the file we were
    // hosting for them so it doesn't linger forever.
    //
    // Deliberately conservative: only when the incoming settings actually carry a profile object, so
    // an unexpected partial save orphans a file (recoverable) rather than deleting a picture the
    // profile still points at (not recoverable).
    if (hasProfile && typeof storedAvatar === 'string' && storedAvatar.startsWith('/avatars/')
      && storedAvatar !== settings.profile.avatarUrl) {
      await releaseAvatarFile(storedAvatar);
    }
    return res.json({ success: true, settings });
  });

  // Read the caller's stored entrance-clip url (used to clean up the file it replaces).
  async function currentEntranceUrl(username) {
    const row = await db.get('SELECT settings FROM users WHERE username = ?', username);
    let s = {};
    try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
    const url = s.profile?.entranceSound;
    return typeof url === 'string' && url.startsWith('/entrances/') ? url : '';
  }

  // Delete a file under entrancesDir, given its public /entrances/<name> url.
  function removeEntranceFile(url) {
    if (!url || !url.startsWith('/entrances/')) return;
    const target = path.resolve(entrancesDir, path.basename(url));
    if (!target.startsWith(entrancesDir + path.sep)) return; // never step outside the folder
    fs.promises.unlink(target).catch(() => { /* already gone */ });
  }

  // Upload the caller's voice-chat entrance clip (a short self-recording that plays for everyone
  // else when they join a voice channel). Returns the url to store on the profile; the previous
  // clip is deleted so these can't pile up.
  app.post('/profile/entrance-sound', authMiddleware, (req, res) => {
    entranceUpload.single('clip')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Clip is larger than 2 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing clip' });
      const type = (req.file.mimetype || '').toLowerCase();
      const ext = (path.extname(req.file.originalname || '').replace('.', '') || '').toLowerCase();
      const AUDIO_EXTS = ['webm', 'ogg', 'oga', 'mp3', 'm4a', 'aac', 'wav', 'opus', 'weba'];
      if (!type.startsWith('audio/') && !type.startsWith('video/webm') && !AUDIO_EXTS.includes(ext)) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'Entrance clip must be an audio recording' });
      }
      const previous = await currentEntranceUrl(req.user.username);
      const url = `/entrances/${req.file.filename}`;
      // Persist straight onto the profile so the clip survives even if the user never hits Save.
      const row = await db.get('SELECT settings FROM users WHERE username = ?', req.user.username);
      let s = {};
      try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
      s.profile = { ...(s.profile || {}), entranceSound: url };
      await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(s), req.user.username);
      if (previous && previous !== url) removeEntranceFile(previous);
      return res.json({ success: true, url });
    });
  });

  // Remove the caller's entrance clip (file + profile field).
  app.delete('/profile/entrance-sound', authMiddleware, async (req, res) => {
    const previous = await currentEntranceUrl(req.user.username);
    const row = await db.get('SELECT settings FROM users WHERE username = ?', req.user.username);
    let s = {};
    try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
    if (s.profile) { s.profile = { ...s.profile, entranceSound: '' }; }
    await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(s), req.user.username);
    if (previous) removeEntranceFile(previous);
    return res.json({ success: true });
  });

  // ---- Managed image uploads (rail tile icons, profile pictures) ----
  // Both live outside uploads/ so the 7-day sweep can't reach them, and both need the same handling:
  // multer error mapping, a magic-byte check, and a generated filename. That is all shared here.

  /**
   * Delete a file this server manages, given its public url. Refuses anything that doesn't sit
   * directly inside `dir` under `prefix`, so a crafted url can never reach another path.
   * @param {string} dir absolute directory the files live in
   * @param {string} prefix public url prefix, e.g. '/avatars/'
   * @param {string} url
   */
  const removeManagedFile = (dir, prefix, url) => {
    if (!url || typeof url !== 'string' || !url.startsWith(prefix)) return;
    const target = path.resolve(dir, path.basename(url));
    if (!target.startsWith(dir + path.sep)) return; // never step outside the folder
    fs.promises.unlink(target).catch(() => { /* already gone */ });
  };
  const removeTileIconFile = (url) => removeManagedFile(tileIconsDir, '/tile-icons/', url);

  /** Resolve a /avatars/<name> url to its path on disk, or '' if it doesn't address one of our files. */
  const avatarPathFor = (url) => {
    if (typeof url !== 'string' || !/^\/avatars\/[A-Za-z0-9._-]+$/.test(url)) return '';
    const target = path.resolve(avatarsDir, path.basename(url));
    return target.startsWith(avatarsDir + path.sep) ? target : '';
  };
  /** Does this /avatars/ url still have a file behind it? */
  const managedAvatarExists = (url) => {
    const p = avatarPathFor(url);
    return !!p && fs.existsSync(p);
  };

  /**
   * Delete an avatar file, but only once nobody references it any more. Avatar urls are visible to
   * other users (they're in every member list), so someone can paste another person's url into their
   * own profile; without this check, changing it again would delete a picture still in use elsewhere.
   * @param {string} url
   */
  const releaseAvatarFile = async (url) => {
    if (typeof url !== 'string' || !/^\/avatars\/[A-Za-z0-9._-]+$/.test(url)) return;
    // The url shape is checked above, so it carries no LIKE wildcards.
    const stillUsed = await db.get("SELECT 1 AS n FROM users WHERE settings LIKE '%' || ? || '%' LIMIT 1", url);
    if (stillUsed) return;
    removeManagedFile(avatarsDir, '/avatars/', url);
  };

  /**
   * Build a single-image upload handler. It runs multer, verifies the bytes really are one of
   * `formats`, and renames the file so its stored extension matches the format actually detected —
   * a claimed Content-Type must never decide how the file is served back later.
   * @param {{ uploader: any, dir: string, urlPrefix: string, formats: string[], maxLabel: string, typeLabel: string }} cfg
   * @returns {(req: any, res: any) => Promise<{ filename: string, url: string } | null>} resolves
   *   null once an error response has already been sent
   */
  const makeImageReceiver = ({ uploader, dir, urlPrefix, formats, maxLabel, typeLabel }) => (req, res) => new Promise((resolve) => {
    uploader.single('image')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: `Image is larger than ${maxLabel}` }); return resolve(null); }
        res.status(400).json({ error: err.message || 'Upload failed' });
        return resolve(null);
      }
      // fileFilter rejects a disallowed mime type by dropping the file, so a missing req.file covers
      // both "no part sent" and "type refused" (e.g. an SVG).
      if (!req.file) { res.status(400).json({ error: typeLabel }); return resolve(null); }
      const format = await detectImageFormat(req.file.path);
      if (!format || !formats.includes(format)) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        res.status(400).json({ error: 'That file is not a valid image' });
        return resolve(null);
      }
      // Align the extension with the detected format if the client's mime type disagreed.
      let filename = req.file.filename;
      const wanted = FORMAT_EXTENSIONS[format];
      if (path.extname(filename).toLowerCase() !== wanted) {
        const renamed = filename.replace(/\.[^.]*$/, '') + wanted;
        try {
          await fs.promises.rename(path.join(dir, filename), path.join(dir, renamed));
          filename = renamed;
        } catch (_) { /* keep the original name rather than losing the upload */ }
      }
      return resolve({ filename, url: `${urlPrefix}${filename}` });
    });
  });

  const receiveTileIcon = makeImageReceiver({
    uploader: tileIconUpload,
    dir: tileIconsDir,
    urlPrefix: '/tile-icons/',
    formats: ['png', 'jpeg', 'webp'], // no GIF: an animated rail tile is a distraction, not a feature
    maxLabel: '2 MB',
    typeLabel: 'Tile image must be a PNG, JPEG or WebP',
  });

  const receiveAvatar = makeImageReceiver({
    uploader: avatarUpload,
    dir: avatarsDir,
    urlPrefix: '/avatars/',
    formats: ['png', 'jpeg', 'webp', 'gif'],
    maxLabel: '5 MB',
    typeLabel: 'Profile picture must be a PNG, JPEG, WebP or GIF',
  });

  // Read the caller's stored avatar url, but only when it's one of OUR files — a pasted external
  // https:// avatar or a legacy /uploads/ one must never be handed to the unlink path.
  const currentAvatarFile = async (username) => {
    const row = await db.get('SELECT settings FROM users WHERE username = ?', username);
    let s = {};
    try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
    const url = s.profile?.avatarUrl;
    return typeof url === 'string' && url.startsWith('/avatars/') ? url : '';
  };

  // Upload the caller's profile picture. Written straight onto the profile (like the entrance clip)
  // so the file and the pointer to it are never out of step, and so closing the editor without
  // saving can't leave an uploaded file that nothing references.
  //
  // Rate limited because avatars/ is deliberately never swept on a timer: without a ceiling, one
  // account could sit in a loop stranding 5 MB files. That plus sweepOrphanAvatars() below bounds how
  // much disk a single user can tie up — and avatars/ shares a volume with data.sqlite, so filling it
  // would take the whole app down, not just pictures.
  app.post('/profile/avatar', rateLimit({ id: 'avatar-upload', windowMs: 10 * 60_000, max: 20 }), authMiddleware, async (req, res) => {
    const saved = await receiveAvatar(req, res);
    if (!saved) return undefined; // receiveAvatar already answered
    const previous = await currentAvatarFile(req.user.username);
    const row = await db.get('SELECT settings FROM users WHERE username = ?', req.user.username);
    let s = {};
    try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
    s.profile = { ...(s.profile || {}), avatarUrl: saved.url };
    await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(s), req.user.username);
    // New file, then the pointer, then drop the old one: a crash can orphan a file but can never
    // leave the profile pointing at something that isn't there. The release runs after the settings
    // write so the reference count it checks is already up to date.
    if (previous && previous !== saved.url) await releaseAvatarFile(previous);
    return res.json({ success: true, url: saved.url });
  });

  // Read the caller's stored Home tile url (used to clean up the file it replaces).
  const currentHomeTileUrl = async (username) => {
    const row = await db.get('SELECT settings FROM users WHERE username = ?', username);
    let s = {};
    try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
    const url = s.homeTileUrl;
    return typeof url === 'string' && url.startsWith('/tile-icons/') ? url : '';
  };

  // Set the caller's Home rail tile image. Personal — it isn't shown to anyone else — so it lives in
  // settings rather than on a shared row. Written immediately so it survives without a profile Save.
  app.post('/profile/home-tile', authMiddleware, async (req, res) => {
    const saved = await receiveTileIcon(req, res);
    if (!saved) return undefined; // receiveTileIcon already answered
    const previous = await currentHomeTileUrl(req.user.username);
    const row = await db.get('SELECT settings FROM users WHERE username = ?', req.user.username);
    let s = {};
    try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
    s.homeTileUrl = saved.url;
    await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(s), req.user.username);
    // New file first, then the pointer, then drop the old one: a crash can leave an orphaned file but
    // never a settings entry pointing at nothing.
    if (previous && previous !== saved.url) removeTileIconFile(previous);
    return res.json({ success: true, url: saved.url });
  });

  // Reset the caller's Home tile back to the default icon.
  app.delete('/profile/home-tile', authMiddleware, async (req, res) => {
    const previous = await currentHomeTileUrl(req.user.username);
    const row = await db.get('SELECT settings FROM users WHERE username = ?', req.user.username);
    let s = {};
    try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
    delete s.homeTileUrl;
    await db.run('UPDATE users SET settings = ? WHERE username = ?', JSON.stringify(s), req.user.username);
    if (previous) removeTileIconFile(previous);
    return res.json({ success: true });
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
    // A name in INSTANCE_OWNERS carries the instance-owner role with it (services/instanceOwners.js).
    // Nobody renames into one, in any spelling of its case — answered like any taken name — and the
    // account that holds the role under its name does not rename away from it: the list would not
    // follow, the role would be lost without a word, and the name would be left behind for no one.
    if (isReservedOwnerName(newUsername)) return res.status(409).json({ error: 'Username already taken' });
    if (isListedOwnerName(oldUsername)) return res.status(409).json({ error: 'This account is named in the server’s INSTANCE_OWNERS setting. Whoever runs the server has to change that setting before the name can change.' });
    if (await db.get('SELECT id FROM users WHERE username = ?', newUsername)) return res.status(409).json({ error: 'Username already taken' });
    try {
      await db.run('BEGIN');
      // Every table that stores the username as a natural key (IDs-based tables need no change).
      await db.run('UPDATE users SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE server_members SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE channel_members SET username = ? WHERE username = ?', newUsername, oldUsername);
      // The custom roles they hold go with them, like the membership rows the roles hang off.
      await db.run('UPDATE server_member_roles SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE channel_reads SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE music_playlists SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE messages SET author = ? WHERE author = ?', newUsername, oldUsername);
      await db.run('UPDATE messages SET pinned_by = ? WHERE pinned_by = ?', newUsername, oldUsername);
      await db.run('UPDATE servers SET owner = ? WHERE owner = ?', newUsername, oldUsername);
      await db.run('UPDATE server_emojis SET created_by = ? WHERE created_by = ?', newUsername, oldUsername);
      await db.run('UPDATE server_invites SET created_by = ? WHERE created_by = ?', newUsername, oldUsername);
      // A kick follows the person through a rename; otherwise changing your name would be a way back
      // in through an invite link. (The new name was just checked to be free, and deleting an account
      // clears its rows, so nothing can clash.)
      await db.run('UPDATE server_removed SET username = ? WHERE username = ?', newUsername, oldUsername);
      // A ban and a timeout follow the person for the same reason: a new name must not be a way
      // back into a server, or out of a timeout. So do the records of who placed them, and the
      // audit log's actor and target (which are only ever usernames), so the log goes on naming
      // the account it was about rather than a name someone else may hold later.
      // Blocks are keyed by user id and need nothing. Neither do notification levels
      // (notification_settings): they are keyed by user id too, and a muted DM names the other
      // person by id.
      await db.run('UPDATE server_bans SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE server_bans SET banned_by = ? WHERE banned_by = ?', newUsername, oldUsername);
      await db.run('UPDATE server_timeouts SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE server_timeouts SET timed_out_by = ? WHERE timed_out_by = ?', newUsername, oldUsername);
      await db.run('UPDATE server_audit SET actor = ? WHERE actor = ?', newUsername, oldUsername);
      await db.run('UPDATE server_audit SET target = ? WHERE target = ?', newUsername, oldUsername);
      await db.run('UPDATE push_subscriptions SET username = ? WHERE username = ?', newUsername, oldUsername);
      await db.run('UPDATE apps SET created_by = ? WHERE created_by = ?', newUsername, oldUsername);
      await db.run('UPDATE apps SET reviewed_by = ? WHERE reviewed_by = ?', newUsername, oldUsername);
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
        overlayColor: p.overlayColor || '',
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

  // --- Membership & roles ---
  // The rules are services/permissions.js. These are the names the handlers below have always
  // called them by: roleOf answers 'member' for everyone in the public commons and null for
  // someone who is not a member; canAccessChannel and visibleChannelsFor are the one answer to
  // "may this person open that channel" for reading, joining, posting, searching and pushing.
  const { roleOf, canAccessChannel, visibleChannelsFor } = permissions;
  const roleRank = (role) => (role === 'owner' ? 0 : role === 'admin' ? 1 : 2);
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
      // Who is timed out right now, and until when: everyone's member list marks them. Only the
      // moment it ends, not the reason, which is between staff and the person (and the audit log).
      const timedOut = await moderation.timeoutsIn(serverId);
      // The custom roles each member holds (ids, highest first): shown on their profile card, and
      // what colours their name. Everyone in the server may see who holds what.
      const heldRoles = await permissions.memberRolesIn(serverId);
      roster = rows.map((r) => ({
        username: r.username, name: r.username, role: r.role, roles: heldRoles.get(r.username) || [], online: onlineUsers.has(r.username), profile: displayProfileFromSettings(r.settings),
        ...(timedOut.has(r.username) ? { timeoutUntil: timedOut.get(r.username) } : {}),
      }));
    }
    roster.sort((a, b) => roleRank(a.role) - roleRank(b.role) || (b.online - a.online) || String(a.name).localeCompare(String(b.name)));
    return roster;
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
  async function emitUnreadBump(serverId, channelId, privacy, author, text, attachment) {
    const srv = await db.get('SELECT name FROM servers WHERE id = ?', serverId);
    const ch = await db.get('SELECT name FROM channels WHERE id = ?', channelId);
    // One definition of "mentioned" for the badge, the in-page notification and the push: if they
    // disagreed, a background tab and a push would each announce the same message.
    const mentions = mentionedUsernames(text);
    const payload = {
      serverId, channelId, author,
      serverName: srv?.name, channelName: ch?.name,
      preview: String(text || '').slice(0, 120), mentions,
      // The kind of file that came with it, so a notification for a message with no text can say
      // "sent an image" or "sent a file". Only the type: the file stays in the channel.
      attachmentType: attachment ? attachment.type : undefined,
    };
    // Nobody who has blocked the author is nudged: no badge, no mention count, no notification
    // (the client raises all three from this event). Their unread totals leave the author's
    // messages out as well (GET /unreads), so the two agree after a reload.
    const blockers = await blocks.blockersOf(author);
    if (serverId === DEMO_ID) { // public commons: everyone's a member
      io.except([...blockers].map((name) => `user:${name}`)).emit('unread:bump', payload);
      return;
    }
    // For a private channel, only the people who can open it are nudged. Asked through
    // canAccessChannel like every other path, so a role on the channel's list counts here too
    // (this loop used to read the list of names itself, and would have missed one).
    const members = await db.all('SELECT username, role FROM server_members WHERE server_id = ?', serverId);
    for (const m of members) {
      if (m.username === author || blockers.has(m.username)) continue;
      if (privacy === 'private' && !(await canAccessChannel(serverId, channelId, m.username, privacy, m.role))) continue;
      io.to(`user:${m.username}`).emit('unread:bump', payload);
    }
  }
  // Push a channel message to the people it should reach while their app is closed. By default
  // that is the people it @mentions and nobody else: ordinary channel chatter is what the unread
  // badge is for, and a phone that buzzed for every line in a busy channel would have its
  // notifications switched off within the hour. Each person can move that line for themselves
  // (services/notificationSettings.js): "All messages" adds them to every message of the channel,
  // "Nothing" takes them out of all of it, a mention included.
  //
  // A level only says how much someone WANTS to hear. Whether they MAY be pushed is decided by the
  // same checks for everyone, whatever their level: they can open the channel and read it (so
  // neither naming a person nor a setting left over from before they lost a channel can leak its
  // contents), they have not blocked the sender, and the sender is within the push allowances.
  async function pushChannelMessage({ serverId, channelId, privacy, sender, text, attachment }) {
    if (!push.available()) return;
    // Who has a level of their own that bears on this channel. Everyone else is at the default.
    const levels = await notificationSettings.channelLevels(serverId, channelId);
    // Bounded before any lookups, so a wall of @names costs a fixed number of queries.
    const mentionedNames = mentionedUsernames(text).filter((name) => name !== sender).slice(0, MAX_MENTION_TARGETS * 2);
    const listenerNames = [...levels].filter(([name, level]) => level === 'all' && name !== sender).map(([name]) => name);
    if (mentionedNames.length === 0 && listenerNames.length === 0) return;
    let senderRow = null;
    // Nothing from someone you have blocked reaches your phone, at any level.
    const blockers = await blocks.blockersOf(sender);
    // May this account be pushed about this message at all? The same answer for a mention and for
    // "All messages".
    const mayBePushed = async (user) => {
      if (blockers.has(user.username)) return false;
      const role = await roleOf(serverId, user.username);
      if (!(await canAccessChannel(serverId, channelId, user.username, privacy, role))) return false;
      // The public commons counts every account as a member, so "can open the channel" is no filter
      // at all there: any stranger could ring any phone. In the commons a message only pushes someone
      // the sender could already message directly (a friend, or someone they share a real server
      // with) — the same line DMs draw. The message still shows in the channel for everyone.
      if (serverId === DEMO_ID) {
        senderRow = senderRow || await getUserByUsername(sender);
        if (!senderRow || !(await canDirectMessage(senderRow.id, sender, user.id, user.username))) return false;
      }
      return true;
    };
    const mentioned = [];
    for (const name of mentionedNames) {
      if (mentioned.length >= MAX_MENTION_TARGETS) break;
      const user = await getUserByUsername(name);
      if (!user || mentioned.includes(user.username)) continue;
      // Muted here: not even a mention gets through.
      if (levels.get(user.username) === 'none') continue;
      if (await mayBePushed(user)) mentioned.push(user.username);
    }
    // The people listening to everything in this channel. Capped like the mentions are, and
    // looked up no more than twice the cap.
    const listening = [];
    for (const name of listenerNames.slice(0, MAX_LEVEL_TARGETS * 2)) {
      if (listening.length >= MAX_LEVEL_TARGETS) break;
      const user = await getUserByUsername(name);
      if (user && await mayBePushed(user)) listening.push(user.username);
    }
    // Two allowances, asked separately: a busy channel with listeners in it must not be able to
    // use up what lets a mention through (services/push.js). Someone who is both mentioned and
    // listening is pushed once, as a mention.
    const pushMentioned = mentioned.length > 0 && push.allowMentionPush(sender);
    const listeners = pushMentioned ? listening.filter((name) => !mentioned.includes(name)) : listening;
    const pushListeners = listeners.length > 0 && push.allowChannelPush(sender);
    if (!pushMentioned && !pushListeners) return;
    const srv = await db.get('SELECT name FROM servers WHERE id = ?', serverId);
    const ch = await db.get('SELECT name FROM channels WHERE id = ?', channelId);
    const about = { serverId, channelId, serverName: srv?.name, channelName: ch?.name, from: sender, text, attachment };
    if (pushMentioned) await push.notifyMention({ ...about, to: mentioned });
    if (pushListeners) await push.notifyChannelMessage({ ...about, to: listeners });
  }

  // Broadcast a server's state to everyone in its room, filtered per-socket (private channels are
  // only sent to owner/admins; each socket also learns its own role).
  async function broadcastServerState(serverId) {
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', serverId);
    if (!srv) return;
    const allChannels = await channelLists.listChannels(serverId);
    const allCategories = await channelLists.listCategories(serverId);
    const roster = await serverRoster(serverId);
    // The server's custom roles, highest first. What each one permits is only sent to people who
    // manage roles; everyone else gets the name, colour and order, which is what the UI shows them.
    const allRoles = await permissions.listRoles(serverId);
    const rolesForDisplay = allRoles.map(({ id, name, color, position }) => ({ id, name, color, position }));
    const room = io.sockets.adapter.rooms.get(`server:${serverId}`) || new Set();
    for (const sid of room) {
      const username = clients[sid]?.username;
      const standing = await permissions.standingOf(serverId, username);
      const role = standing.role;
      const channels = await visibleChannelsFor(serverId, allChannels, username, role);
      // A category is shown to someone only if it holds a channel they can see (or they manage
      // channels). It is a heading, never a rule: which channels they see was decided above.
      const categories = channelLists.categoriesFor(allCategories, channels, standing.permissions.has('manage_channels'));
      const roles = standing.permissions.has('manage_roles') ? allRoles : rolesForDisplay;
      // myPermissions: what this person may do here, so their client can show and hide controls.
      // It decides nothing: every route and handler asks services/permissions.js again.
      const myPermissions = [...standing.permissions];
      // myTimeout: this person's own timeout here, with its reason, or null. It is how a client
      // that was not connected when the timeout was placed (or that has just switched to this
      // server) learns of it. `now` is this server's clock, so that a client whose own clock is
      // off still counts down the right length of time for it and for the roster's markers.
      const myTimeout = await moderation.timeoutOf(serverId, username);
      io.to(sid).emit('server:state', { server: { id: srv.id, name: srv.name, owner: srv.owner || null, iconUrl: srv.icon_url || null, channels, categories, roles }, members: roster, myRole: role, myPermissions, myTimeout, now: Date.now() });
    }
  }

  // Servers / channels / membership (routes/servers.js).
  // What a change that takes access away from someone has to do afterwards (services/accessChanges.js).
  const accessChanges = createAccessChanges({ db, permissions, appRooms, enforceVoiceAccess, enforceTextAccess });
  const { removeMemberFromServer } = registerServerRoutes({ app, db, io, authMiddleware, DEMO_ID, newId, permissions, channelLists, accessChanges, mapMessageRow, broadcastServerState, validate, inviteInput, receiveTileIcon, removeTileIconFile, appRooms, endAppActivitiesInServer, enforceVoiceAccess, enforceTextAccess, moderation, blocks, notificationSettings, requireVerified });

  // Shareable invite links (routes/invites.js).
  registerInviteRoutes({ app, db, io, authMiddleware, DEMO_ID, permissions, broadcastServerState, validate, inviteLinkInput, moderation, requireVerified });

  // Bans, timeouts and the audit log (routes/moderation.js). A ban removes a member with the kick
  // route's own clean-up, which is why that is handed over from registerServerRoutes.
  registerModerationRoutes({ app, db, io, authMiddleware, DEMO_ID, permissions, moderation, removeMemberFromServer, broadcastServerState, enforceVoiceAccess });

  // Custom roles (routes/roles.js), and channel categories and channel order (routes/categories.js).
  registerRoleRoutes({ app, db, io, authMiddleware, DEMO_ID, newId, permissions, accessChanges, moderation, broadcastServerState });
  registerCategoryRoutes({ app, db, authMiddleware, DEMO_ID, newId, permissions, channelLists, moderation, broadcastServerState });

  // Web Push subscriptions (routes/push.js).
  registerPushRoutes({ app, authMiddleware, push, validate, pushSubscribeInput, pushUnsubscribeInput });

  // Emojis / app directory / GIF library / soundboard (routes/library.js).
  registerLibraryRoutes({ app, db, io, authMiddleware, upload, gifUpload, soundUpload, gifsDir, soundsDir, SOUND_NAME_MAX, bundleUpload, appBundlesDir, endAppActivities, approveAppActivities, isInstanceOwner, instanceOwners, ownOrigins, requireVerified, permissions, moderation, uploadDir });

  // YouTube+yt-dlp / playlists / Spotify (routes/media.js).
  registerMediaRoutes({ app, db, authMiddleware, io, JWT_SECRET, ownOrigins });

  // Presence / friends / direct messages (routes/social.js).
  registerSocialRoutes({ app, db, io, authMiddleware, getUserByUsername, areFriends, canDirectMessage, mayReadDirectMessages, hasPendingRequestBetween, emitPendingUpdate, emitFriendsListUpdate, getDmUnreadSummary, emitDmUnreadUpdate, setUserPresenceByUsername, broadcastPresenceToFriends, normalizePresence, displayProfileFromSettings, avatarColorForUsername, mapMessageRow, normalizeAttachment, sanitizeQuotes, push, blocks, notificationSettings, linkPreviews, ownHostsFor, requireVerified });
  const groups = registerGroupRoutes({ app, db, io, authMiddleware, getUserByUsername, canDirectMessage, normalizePresence, displayProfileFromSettings, avatarColorForUsername, mapMessageRow, normalizeAttachment, sanitizeQuotes, push, blocks, notificationSettings, linkPreviews, ownHostsFor, requireVerified });
  // Two-factor management, the owner's recovery route and the emailed verification link
  // (routes/security.js).
  registerSecurityRoutes({ app, db, io, authMiddleware, twoFactor, emailVerification, isInstanceOwner });
  // Blocking another account (routes/blocks.js).
  registerBlockRoutes({ app, db, io, authMiddleware, getUserByUsername, blocks, emitFriendsListUpdate, emitPendingUpdate, emitDmUnreadUpdate });
  // Notification levels: per server, channel, DM and group (routes/notifications.js).
  registerNotificationRoutes({ app, db, io, authMiddleware, permissions, notificationSettings, emitDmUnreadUpdate });
  // Vault Player SSO handoff (github.com/enachealex/Vault-Player). Disabled unless
  // VAULT_SSO_SECRET is set; see routes/vault.js for the security model.
  registerVaultRoutes({ app, db, authMiddleware, displayProfileFromSettings, avatarColorForUsername, normalizePresence });

  // Message search across channels, DMs and groups (routes/search.js).
  registerSearchRoutes({ app, db, authMiddleware, roleOf, canAccessChannel, visibleChannelsFor, getUserByUsername, mayReadDirectMessages, parseAttachment });

  // requireVerified: no uploads until the account's email is confirmed. Asked before the body
  // is read, so a refused upload is not written to disk first.
  app.post('/files/upload', authMiddleware, requireVerified, (req, res) => {
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
      // The screenshot is written before the rest of the form is read. A report that is then turned
      // down never links to it, so it would sit in a public folder for good: it goes again instead.
      let kept = false;
      const discardScreenshot = () => { if (req.file && !kept) fs.promises.unlink(req.file.path).catch(() => {}); };
      try {
        const username = req.user.username;
        const input = validate(feedbackInput, req.body);
        if (!input.ok) { discardScreenshot(); return res.status(400).json({ error: input.error }); }
        const { type, message: rawMessage } = input.data;
        const userTitle = input.data.title || '';

        const userRow = await db.get('SELECT email FROM users WHERE username = ?', username);
        const email = userRow && userRow.email;
        if (!email) { discardScreenshot(); return res.status(400).json({ error: 'Your account has no email on file' }); }

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
        kept = true; // the stored report links to it from here on, whatever happens upstream
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
        discardScreenshot();
        return res.status(500).json({ error: 'Server error' });
      }
    });
  });

  // Sync endpoint: the servers, channels and newest messages the caller may open.
  // It used to read every server, every channel and every message for anyone with a token, which
  // made the access rules on the paged routes and on search beside the point. It now goes through
  // the same checks they do (the commons plus real membership rows, then visibleChannelsFor) and
  // sends only the newest page of each channel, like 'messages:init'.
  app.get('/user/sync', authMiddleware, async (req, res) => {
    try {
      const me = req.user.username;
      const rows = await db.all(
        `SELECT s.id, s.name, 'member' AS role FROM servers s WHERE s.id = ?
         UNION ALL
         SELECT s.id, s.name, m.role FROM server_members m JOIN servers s ON s.id = m.server_id
          WHERE m.username = ? AND s.id != ?`,
        DEMO_ID, me, DEMO_ID
      );
      const result = {};
      const blocked = await blocks.blockedBy(me); // marked, like every other history the caller is sent
      for (const s of rows) {
        const allChannels = await channelLists.listChannels(s.id);
        const channels = await visibleChannelsFor(s.id, allChannels, me, s.role);
        const messagesByChannel = {};
        for (const ch of channels) {
          const page = await fetchPage(db, channelHistory(s.id, ch.id), { mode: 'latest', id: 0, limit: PAGE_DEFAULT });
          messagesByChannel[ch.id] = page.rows.map((m) => mapMessageRow(m, me, blocked));
        }
        result[s.id] = { id: s.id, name: s.name, channels, messages: messagesByChannel };
      }
      // instanceOwner: whether the caller runs this instance (may review uploaded apps). Sent here
      // as well as on login and /auth/me because this is what a client calls on every start.
      // emailVerified rides along for the same reason: it is how an open client learns it.
      return res.json({ servers: result, instanceOwner: await isInstanceOwner(me), emailVerified: await emailVerification.isVerified(me) });
    } catch (e) {
      console.error('[sync] error:', e);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  // SFU (mediasoup) for voice rooms — feature-detected by clients via sfu:caps; when disabled or
  // unsupported they fall back to the P2P mesh. Media flows on its own port, not the tunnel.
  const sfu = createSfu({ io });

  // Remote callers reach the SFU at the announced public address; when the home's address changes
  // they silently stop getting through. Checked at boot and every half hour (services/sfuAddress.js).
  // SFU_ADDRESS_CHECK=0 turns it off (the tests set it: they must not depend on the network), and
  // SFU_ADDRESS_CHECK_URL points it at another trace service.
  const sfuAddress = createAddressMonitor({
    announced: sfu.info().enabled && process.env.SFU_ADDRESS_CHECK !== '0' ? sfu.announcedAddresses() : [],
    fetchAddress: (family) => fetchPublicAddress({ family, ...(process.env.SFU_ADDRESS_CHECK_URL ? { url: process.env.SFU_ADDRESS_CHECK_URL } : {}) }),
  });
  sfuAddress.start();

  // What a client's "Check connection" and the in-call connection panel need to explain themselves,
  // and what an operator wants to see without a shell. Booleans and port numbers only: no address,
  // no TURN credential (those stay on /webrtc/ice, which a call needs anyway).
  app.get('/webrtc/diagnostics', authMiddleware, async (_req, res) => {
    const info = sfu.info();
    res.json({
      sfu: {
        enabled: info.enabled,
        usable: await sfu.ready(),
        publicAddressAnnounced: info.publicAddressAnnounced,
        ports: info.ports,
      },
      announcedAddressStale: sfuAddress.isStale(),
      turnConfigured: turnConfigured(),
      stunUrls: stunUrls(),
    });
  });

  // How each participant of a voice room gets its media: 'sfu' (through this server) or 'mesh'
  // (directly to each person). The client says which when it joins and again if that changes; the
  // room is told, because two participants need a direct connection between them exactly when at
  // least one of them is in mesh mode. A client from before this existed never says, and is null.
  const VOICE_MODES = ['sfu', 'mesh'];
  const voiceModes = new Map(); // room -> Map<socket id, 'sfu' | 'mesh'>
  const voiceModeOf = (room, socketId) => voiceModes.get(room)?.get(socketId) || null;
  function setVoiceMode(room, socketId, mode) {
    let modes = voiceModes.get(room);
    if (!mode) {
      if (modes && modes.delete(socketId) && modes.size === 0) voiceModes.delete(room);
      return;
    }
    if (!modes) { modes = new Map(); voiceModes.set(room, modes); }
    modes.set(socketId, mode);
  }
  // One line per fallback, for `pm2 logs`: a call quietly running on direct connections is the
  // first thing to look for when someone "cannot hear anyone". The reason is a short code the
  // client reports; anything that is not one is not written to the log. The socket id is what the
  // log already prints for every connection, so this names nobody new.
  function logVoiceFallback(socketId, reason) {
    if (!sfu.info().enabled) return; // the SFU is off here: direct is how this instance runs, not a fallback
    const code = typeof reason === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(reason) ? reason : 'unspecified';
    console.log(`[voice] ${socketId} fell back to direct connections (reason: ${code})`);
  }

  // A socket stops being in a voice room: by leaving, or by being taken out (enforceVoiceAccess).
  // One function, so that both tell the room the same things.
  function dropFromVoiceRoom(sock, room) {
    sock.leave(room);
    setVoiceMode(room, sock.id, null);
    sock.to(room).emit('voice:peer-left', { id: sock.id });
    sfu.removePeer(room, sock.id); // close their SFU transports + notify consumers
    if (liveStreams[sock.id]) { delete liveStreams[sock.id]; broadcastDiscover(); }
    // Leaving voice leaves its activity (and the app in it) too.
    if (leaveActivity(sock.id) === room) sendActivityList(room);
  }

  // Can this account be in that voice room? Membership of the server, and — outside the commons,
  // where a room is just a name — a channel that exists and that they may open. A private voice
  // channel used to be reachable by any member who knew its id: the join only asked about the server.
  // And not while they are timed out in that server (services/moderation.js): a timeout takes
  // every voice room of the server away for as long as it lasts, and gives them back by itself.
  async function mayBeInVoice(username, serverId, channelId) {
    if (typeof serverId !== 'string' || typeof channelId !== 'string') return false;
    const role = await roleOf(serverId, username);
    if (!role) return false;
    if (serverId === DEMO_ID) return true;
    if (await moderation.timeoutOf(serverId, username)) return false;
    const ch = await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
    return !!ch && canAccessChannel(serverId, channelId, username, ch.privacy, role);
  }
  // What a client is told when it is refused a voice room or taken out of one. `reason` is there
  // only for a timeout, so the client can say that rather than "you no longer have access".
  async function voiceRemovedPayload(username, serverId, channelId) {
    const timeout = await moderation.timeoutOf(serverId, username);
    return timeout ? { serverId, channelId, reason: 'timeout', until: timeout.until } : { serverId, channelId };
  }

  // May this account draw on a channel's shared image (collab:*)? The same rule as anything else
  // sent into a channel: a member, who may open the channel, and not timed out in its server.
  // Unlike a voice room the channel must exist even in the commons: the canvas is announced to
  // that channel's room, and a made-up name has nobody in it to announce to.
  async function mayCollabIn(username, serverId, channelId) {
    if (typeof serverId !== 'string' || typeof channelId !== 'string') return false;
    const role = await roleOf(serverId, username);
    if (!role) return false;
    if (await moderation.timeoutOf(serverId, username)) return false; // never one in the commons
    const ch = await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
    return !!ch && !!(await canAccessChannel(serverId, channelId, username, ch.privacy, role));
  }
  // Someone just lost access in this server (or was timed out): take their sockets out of every
  // shared canvas of its channels they may no longer use, and say why, so the client closes it.
  // Their strokes are only relayed while their socket is in the session's room, so this is what
  // stops them; nothing is asked of the database per stroke.
  async function enforceCollabAccess(username, serverId) {
    for (const sock of io.sockets.sockets.values()) {
      if (sock.data?.username !== username) continue;
      for (const room of [...sock.rooms]) {
        const sess = collabSessions[room];
        if (!sess || sess.serverId !== serverId) continue;
        if (await mayCollabIn(username, serverId, sess.channelId)) continue;
        sock.leave(room);
        const timeout = await moderation.timeoutOf(serverId, username);
        sock.emit('collab:removed', { sessionId: sess.sessionId, serverId, channelId: sess.channelId, ...(timeout ? { reason: 'timeout', until: timeout.until } : {}) });
      }
    }
  }

  // Someone just lost access here (kicked, left, taken off a private channel's list, demoted,
  // timed out). Their sockets are still sitting in the voice rooms they had joined, hearing the
  // call: the membership check happens at the door, not afterwards. So after access is taken away,
  // go through the rooms they are in and take them out of every one they may no longer be in.
  async function enforceVoiceAccess(username, serverId) {
    const prefix = `voice:${serverId}:`;
    for (const [room, members] of [...io.sockets.adapter.rooms]) {
      if (!room.startsWith(prefix)) continue;
      const mine = [...members].filter((id) => io.sockets.sockets.get(id)?.data?.username === username);
      if (mine.length === 0) continue;
      const channelId = room.slice(prefix.length);
      if (await mayBeInVoice(username, serverId, channelId)) continue;
      const told = await voiceRemovedPayload(username, serverId, channelId);
      for (const id of mine) {
        const sock = io.sockets.sockets.get(id);
        if (!sock) continue;
        dropFromVoiceRoom(sock, room);
        sock.emit('voice:removed', told); // the client hangs up its side
      }
    }
    // The shared image canvases of the server's channels go by the same rule. Done from here
    // because every path that takes access away (kick, ban, leave, a timeout, a private channel's
    // list or a role changing) already ends by calling this.
    await enforceCollabAccess(username, serverId);
  }

  // The same for the TEXT rooms. A socket joins `server:<id>` and one `channel:<id>:<channel>` when
  // its user opens them, and nothing took it out again when that user was kicked, banned, left, or
  // lost a private channel: it went on receiving every new message until it happened to reconnect.
  // For a ban in particular that is not "out". Asked of the database per room, like the voice
  // version, so it removes exactly the rooms this person may no longer be in and no others.
  async function enforceTextAccess(username, serverId) {
    const role = await roleOf(serverId, username);
    const serverRoom = `server:${serverId}`;
    const prefix = `channel:${serverId}:`;
    for (const sock of io.sockets.sockets.values()) {
      if (sock.data?.username !== username) continue;
      for (const room of [...sock.rooms]) {
        if (room === serverRoom) { if (!role) sock.leave(room); continue; }
        if (!room.startsWith(prefix)) continue;
        const channelId = room.slice(prefix.length);
        const ch = role ? await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId) : null;
        if (!ch || !(await canAccessChannel(serverId, channelId, username, ch.privacy, role))) sock.leave(room);
      }
    }
  }

  // Socket.IO handlers
  io.on('connection', (socket) => {
    console.log('socket connected', socket.id);
    // Handlers below take their payload as `({ a, b } = {})`. That default covers a missing payload
    // but not an explicit null, and destructuring null throws — inside an async handler that is an
    // unhandled rejection, which ends the process. Any socket could do it, logged in or not, so a
    // null payload is turned into a missing one here, once, before any handler sees it.
    socket.use((packet, next) => {
      if (packet[1] === null) packet[1] = undefined;
      next();
    });
    // The voice room this socket currently occupies (sockets join at most one voice room).
    const voiceRoomOf = (s) => { for (const r of s.rooms) if (r.startsWith('voice:')) return r; return null; };
    // try to read token from handshake. Read BEFORE anything is bound, so the membership guard below
    // can never observe an unset socketUser.
    const token = socket.handshake.auth && socket.handshake.auth.token;
    let socketUser = null;
    if (token) {
      // sessionClaims: only a session counts. A two-factor ticket presented here leaves the socket
      // anonymous, exactly like a forged token.
      try { socketUser = sessionClaims(token).username; } catch (e) { socketUser = null }
    }
    // Kept on the socket as well, for code that starts from a room and needs to know whose sockets
    // are in it (enforceVoiceAccess). `clients` cannot answer that: it is only filled in by 'join',
    // which a hand-written client can skip on its way into a voice room.
    socket.data.username = socketUser;

    // Membership gate for VOICE rooms and activities. Text channels were gated (the 'join' handler
    // checks roleOf and answers server:denied) but voice and activities were not: any socket — even
    // one that presented no token at all, since a bad token only leaves socketUser null rather than
    // refusing the connection — could join `voice:<serverId>:<channelId>` by guessing the ids and
    // then read the participant list, receive activity state, and start or drive activities.
    // roleOf() already returns null for a missing username and 'member' for the public commons, so it
    // is exactly the right check.
    const mayUseVoice = async (serverId) => !!(await roleOf(serverId, socketUser));

    // This person's timeout in that server, if one is in force (services/moderation.js). While it
    // is, they can read and nothing else: every handler below that writes to a server, or acts in
    // one of its voice rooms, asks this first. Asked of the database each time, so a timeout
    // starts and ends for a socket that is already connected without anything being told to it.
    const timedOutIn = (serverId) => moderation.timeoutOf(serverId, socketUser);
    // Why this account may not do something reserved for a confirmed email address, or null
    // (services/emailVerification.js). Asked of the database each time, like a timeout, so
    // confirming takes effect on a socket that is already connected.
    const unverifiedRefusal = () => emailVerification.refusalFor(socketUser);
    // Taking part in a voice room's activity: a member, and not timed out.
    const mayActInVoice = async (serverId) => (await mayUseVoice(serverId)) && !(await timedOutIn(serverId));

    // voice:join handlers of this socket that have not yet decided (joined, or refused). The SFU
    // handlers wait for these before they ask which room the socket is in; see bindSocket.
    const voiceJoins = new Set();
    const pendingVoiceJoin = () => (voiceJoins.size ? Promise.all([...voiceJoins]) : null);
    // A real client falls back once per call. Capped per connection so that one sending modes in a
    // loop cannot fill the log.
    let fallbacksLogged = 0;
    const noteVoiceFallback = (reason) => { if (fallbacksLogged++ < 5) logVoiceFallback(socket.id, reason); };

    sfu.bindSocket(socket, voiceRoomOf, mayUseVoice, { pendingJoin: pendingVoiceJoin, probeAs: socketUser });
    if (socketUser) {
      socket.join(`user:${socketUser}`);
      setUserPresenceByUsername(socketUser, 'available')
        .then((status) => broadcastPresenceToFriends(socketUser, status))
        .catch((err) => console.warn('presence on connect failed', err));
    }

    // Is this window in front of its user right now? The client says so whenever that changes
    // (focus, blur, tab hidden, reconnect). It is what decides whether a message is pushed: someone
    // looking at the app does not need their phone to buzz about what is already on screen. Kept per
    // socket, so a phone in a pocket never mutes the laptop and one focused window is enough.
    // The ack exists so a caller can know the state has landed before relying on it.
    socket.on('presence:focus', (state, ack) => {
      const focused = state && typeof state === 'object' ? state.focused === true : state === true;
      push.setFocus(socket.id, socketUser, focused);
      if (typeof ack === 'function') ack({ ok: true });
    });

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
      const allChannels = await channelLists.listChannels(serverId);
      await broadcastServerState(serverId); // role-filtered state to everyone (incl. this newcomer)

      // Enter the first text channel this user can actually see, and send its history.
      const firstText = (await visibleChannelsFor(serverId, allChannels, socketUser, myRole)).find((c) => c.type === 'text');
      if (firstText) {
        socket.join(`channel:${serverId}:${firstText.id}`);
        socket.emit('channel:joined', { serverId, channelId: firstText.id });
        // Only the newest page: the rest is fetched as the reader scrolls back (GET .../messages?before=).
        const page = await fetchPage(db, channelHistory(serverId, firstText.id), { mode: 'latest', id: 0, limit: PAGE_DEFAULT });
        const blocked = await blocks.blockedBy(socketUser); // their messages arrive marked, not missing
        socket.emit('messages:init', { serverId, channelId: firstText.id, messages: page.rows.map((m) => mapMessageRow(m, socketUser, blocked)), hasMore: page.hasMore });
        await markChannelRead(socketUser, serverId, firstText.id); // history was just shown
      } else {
        socket.emit('messages:init', { serverId, channelId: null, messages: [], hasMore: false });
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
        const page = await fetchPage(db, channelHistory(serverId, channelId), { mode: 'latest', id: 0, limit: PAGE_DEFAULT });
        const blocked = await blocks.blockedBy(socketUser);
        socket.emit('messages:init', { serverId, channelId, messages: page.rows.map((m) => mapMessageRow(m, socketUser, blocked)), hasMore: page.hasMore });
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

    // "X is typing…". Purely ephemeral: nothing is stored, and a lost event just means the hint does
    // not show. It is still held to the same access rules as sending a message, because announcing
    // that you are typing in a private channel or to a stranger is itself information. Throttled per
    // socket so a client cannot use it to flood a room; the client sends one every few seconds.
    let lastTypingAt = 0;
    socket.on('typing', async (payload = {}) => {
      if (!socketUser) return;
      const now = Date.now();
      if (now - lastTypingAt < 1000) return;
      lastTypingAt = now;
      try {
        if (payload.scope === 'channel') {
          const serverId = String(payload.serverId || '');
          const channelId = String(payload.channelId || '');
          const ch = await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
          if (!ch) return;
          const role = await roleOf(serverId, socketUser);
          if (!(await canAccessChannel(serverId, channelId, socketUser, ch.privacy, role))) return;
          // Timed out here: they cannot send, so they are not "typing" either.
          if (await timedOutIn(serverId)) return;
          // The channel room holds exactly the sockets with that channel open: the only people for
          // whom "someone is typing here" means anything. Less anyone who has blocked the typist.
          const blockers = await blocks.blockersOf(socketUser);
          socket.to(`channel:${serverId}:${channelId}`).except([...blockers].map((name) => `user:${name}`))
            .emit('typing', { scope: 'channel', serverId, channelId, from: socketUser });
        } else if (payload.scope === 'dm') {
          const me = await getUserByUsername(socketUser);
          const peer = await getUserByUsername(String(payload.to || ''));
          if (!me || !peer || peer.id === me.id) return;
          if (!(await canDirectMessage(me.id, me.username, peer.id, peer.username))) return;
          io.to(`user:${peer.username}`).emit('typing', { scope: 'dm', from: socketUser });
        } else if (payload.scope === 'group') {
          await groups.emitTyping(payload.groupId, socketUser);
        }
      } catch (err) {
        console.warn('typing relay failed:', err && err.message);
      }
    });

    socket.on('message', async ({ serverId = 'demo', channelId = 'general', text, attachment, quotes } = {}, ack) => {
      // Refuse writes to channels the user can't see (belongs to server + private-access check).
      // Rejections are answered with message:error (echoing the text) instead of a silent drop,
      // so a client with a stale server/channel pairing can recover the message and resync.
      // A sender that asks for an answer (the quick reply on a notification toast, which is not in
      // the channel's room and so never sees its own message come back) gets the refusal, or the
      // stored message, through that instead. The composer does not ask, and is answered as before.
      const answer = typeof ack === 'function' ? ack : null;
      const refuse = (refusal) => {
        if (answer) answer({ ok: false, ...refusal });
        else socket.emit('message:error', refusal);
      };
      const ch = await db.get("SELECT id, COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
      if (!ch) { refuse({ serverId, channelId, text: (text || '').trim(), reason: 'unknown-channel' }); return; }
      const myRole = await roleOf(serverId, socketUser);
      if (!(await canAccessChannel(serverId, channelId, socketUser, ch.privacy, myRole))) { refuse({ serverId, channelId, text: (text || '').trim(), reason: 'no-access' }); return; }
      // Timed out in this server: refused here, whatever the client let through. The text goes
      // back with the refusal like any other, so what they typed is not lost.
      const timeout = await timedOutIn(serverId);
      if (timeout) { refuse({ serverId, channelId, text: (text || '').trim(), reason: 'timed-out', until: timeout.until }); return; }
      // The public commons is open to every account the moment it registers, so posting there
      // waits for a confirmed email. Other servers are joined by invitation and are not affected.
      if (serverId === DEMO_ID) {
        const refusal = await unverifiedRefusal();
        if (refusal) { refuse({ serverId, channelId, text: (text || '').trim(), reason: refusal.code, error: refusal.error }); return; }
      }
      // The signed-in account, which is also what `join` records. Read from the socket itself
      // because a quick reply can be sent to a server this socket has not joined.
      const author = socketUser || clients[socket.id]?.name || 'Anon';
      const body = (text || '').trim();
      const fileAttachment = normalizeAttachment(attachment);
      if (!body && !fileAttachment) { if (answer) answer({ ok: false, reason: 'empty' }); return; }
      const cleanQuotes = sanitizeQuotes(quotes);
      const ts = Date.now();
      const inserted = await db.run('INSERT INTO messages (server_id, channel_id, author, text, ts, attachment_json, quotes_json) VALUES (?, ?, ?, ?, ?, ?, ?)', serverId, channelId, author, body, ts, fileAttachment ? JSON.stringify(fileAttachment) : null, cleanQuotes ? JSON.stringify(cleanQuotes) : null);
      // By the id this insert returned. It used to read "the last row inserted on the connection",
      // which is some other handler's row whenever one of them inserts between the two statements.
      const msgRow = await db.get('SELECT id, author, text, ts, attachment_json, reactions_json, quotes_json, edited_at FROM messages WHERE id = ?', inserted.lastID);
      // Tag the broadcast with its server/channel so clients can filter (belt & braces on top of rooms).
      // Anyone in the channel who has blocked the author gets their own copy, marked `blocked`, so
      // their client shows it collapsed and stays quiet about it; everyone else gets the plain one.
      // Two sends rather than one because the mark is per reader, and must not reach the rest.
      const live = { ...mapMessageRow(msgRow), serverId, channelId };
      if (answer) answer({ ok: true, message: live });
      const channelRoom = `channel:${serverId}:${channelId}`;
      const blockers = await blocks.blockersOf(author);
      if (blockers.size === 0) {
        io.to(channelRoom).emit('message', live);
      } else {
        for (const id of io.sockets.adapter.rooms.get(channelRoom) || []) {
          const reader = io.sockets.sockets.get(id)?.data?.username;
          io.to(id).emit('message', reader && blockers.has(reader) ? { ...live, blocked: true } : live);
        }
      }
      // Not awaited: the message is stored and on everyone's screen, and nothing about pushing it to
      // a closed app is allowed to hold up or fail the send.
      pushChannelMessage({ serverId, channelId, privacy: ch.privacy, sender: socketUser, text: body, attachment: fileAttachment })
        .catch((err) => console.warn('[push] channel push lookup failed:', err && err.message));
      // The same goes for the link preview: the message is out, and the card for its link follows
      // when (and if) the page has been fetched, to the same room the message went to. Only reached
      // for a message that was accepted and stored: a refused one above never gets this far.
      linkPreviews.attachTo({
        table: 'messages', id: msgRow.id, user: socketUser, ownHosts: ownHostsFor(socket.handshake.headers),
        emit: (preview) => io.to(channelRoom).emit('message:preview', { id: msgRow.id, serverId, channelId, preview }),
      });
      await emitUnreadBump(serverId, channelId, ch.privacy, author, body, fileAttachment);
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

    // Edit a channel message — the author only, and only a text message (the client offers Edit on
    // nothing else). Saved with edited_at so "(edited)" survives a reload, and broadcast so everyone
    // in the channel sees the new text. `ack` tells the editor whether it stuck: their client shows
    // the edit immediately and puts the old text back if the server refused it.
    socket.on('message:edit', async ({ id, text } = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const body = typeof text === 'string' ? text.trim() : '';
      const info = clients[socket.id];
      if (!id || !info) return reply({ ok: false, error: 'bad-request' });
      if (!body) return reply({ ok: false, error: 'empty' });
      const row = await db.get('SELECT author, text, server_id, channel_id, attachment_json, pinned_at FROM messages WHERE id = ?', id);
      if (!row) return reply({ ok: false, error: 'not-found' });
      if (row.author !== info.name) return reply({ ok: false, error: 'not-author' });
      if (row.attachment_json) return reply({ ok: false, error: 'has-attachment' });
      const ch = await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", row.channel_id, row.server_id);
      const myRole = await roleOf(row.server_id, socketUser);
      if (!ch || !(await canAccessChannel(row.server_id, row.channel_id, socketUser, ch.privacy, myRole))) return reply({ ok: false, error: 'no-access' });
      // An edit puts new words in the channel, which is what a timeout takes away.
      if (await timedOutIn(row.server_id)) return reply({ ok: false, error: 'timed-out' });
      const editedAt = Date.now();
      await db.run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', body, editedAt, id);
      const room = `channel:${row.server_id}:${row.channel_id}`;
      io.to(room).emit('message:edited', { id, text: body, editedAt, serverId: row.server_id, channelId: row.channel_id });
      // A pinned message shows its text in the pin bar and the View Pins list, so refresh those too.
      if (row.pinned_at) io.to(room).emit('pins:updated', { serverId: row.server_id, channelId: row.channel_id, pins: await channelPins(row.server_id, row.channel_id, socketUser) });
      reply({ ok: true, editedAt });
      // The preview follows the link, not the edit: nothing is fetched unless the link it is for
      // changed (services/linkPreview.js).
      const previewEvent = (preview) => io.to(room).emit('message:preview', { id, serverId: row.server_id, channelId: row.channel_id, preview });
      linkPreviews.afterEdit({
        table: 'messages', id, oldText: row.text || '', newText: body, user: socketUser, ownHosts: ownHostsFor(socket.handshake.headers),
        emit: previewEvent, clear: () => previewEvent(null),
      });
    });

    // Take the link preview off a channel message — its author only, like deleting it. It goes for
    // everyone in the channel, and stays gone: it is only looked at again if the link itself is
    // edited (afterEdit above).
    socket.on('message:preview-remove', async ({ id } = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const info = clients[socket.id];
      if (!id || !info) return reply({ ok: false, error: 'bad-request' });
      const row = await db.get('SELECT author, server_id, channel_id FROM messages WHERE id = ?', id);
      if (!row) return reply({ ok: false, error: 'not-found' });
      if (row.author !== info.name) return reply({ ok: false, error: 'not-author' });
      if (await linkPreviews.remove('messages', id)) {
        io.to(`channel:${row.server_id}:${row.channel_id}`).emit('message:preview', { id, serverId: row.server_id, channelId: row.channel_id, preview: null });
      }
      return reply({ ok: true });
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
      if (await timedOutIn(row.server_id)) return null; // timed out: no pinning or unpinning
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

    // Toggle a persisted reaction. scope 'channel' (broadcast to channel), 'dm' (both peers) or
    // 'group' (every member of the group chat).
    socket.on('reaction:toggle', async ({ scope = 'channel', messageId, emoji } = {}) => {
      if (!socketUser || !messageId || typeof emoji !== 'string' || !emoji) return;
      if (scope === 'group') {
        const me = await getUserByUsername(socketUser);
        const groupId = me && await groups.groupOfMessageForMember(messageId, me.id);
        if (!groupId) return; // only members
        const raw = await toggleReaction('group_messages', messageId, socketUser, emoji);
        if (raw == null) return;
        await groups.emitToMembers(groupId, 'reaction:updated', { scope: 'group', groupId, messageId, reactions: raw });
        return;
      }
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
        // With a block between the two, nothing new arrives on the other side of the
        // conversation, a reaction included. It is still stored and still shown to whoever
        // reacted, exactly as before: to them nothing looks different.
        if (other && !(await blocks.between(me.id, otherId))) io.to(`user:${other.username}`).emit('reaction:updated', { scope: 'dm', messageId, reactions: raw });
        return;
      }
      const row = await db.get('SELECT server_id, channel_id FROM messages WHERE id = ?', messageId);
      if (!row) return;
      // Reacting is taking part, so it is held to what sending is: a channel this person may open
      // (it used to ask nothing, so anyone who knew a message id could react to it), in a server
      // they are not timed out in.
      const ch = await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", row.channel_id, row.server_id);
      const myRole = await roleOf(row.server_id, socketUser);
      if (!ch || !(await canAccessChannel(row.server_id, row.channel_id, socketUser, ch.privacy, myRole))) return;
      if (await timedOutIn(row.server_id)) return;
      const raw = await toggleReaction('messages', messageId, socketUser, emoji);
      if (raw == null) return;
      io.to(`channel:${row.server_id}:${row.channel_id}`).emit('reaction:updated', { scope: 'channel', messageId, reactions: raw });
    });

    // Soundboard is voice-only: relay a play trigger to everyone else IN THE VOICE ROOM so all
    // call participants hear it too.
    // Only from inside that room: it used to relay for any socket that named one, which would let
    // someone who had been taken out of a call (kicked, timed out) go on playing sounds into it.
    socket.on('soundboard:play', ({ serverId = 'demo', channelId = 'voice1', soundId, url, name, emoji } = {}) => {
      if (typeof url !== 'string' || !url.startsWith('/sounds/')) return;
      if (!socket.rooms.has(`voice:${serverId}:${channelId}`)) return;
      const by = clients[socket.id]?.name || 'Anon';
      socket.to(`voice:${serverId}:${channelId}`).emit('soundboard:play', { soundId, url, name, emoji, by });
    });

    // Stop the currently-playing soundboard clip for others in the voice room.
    socket.on('soundboard:stop', ({ serverId = 'demo', channelId = 'voice1' } = {}) => {
      if (!socket.rooms.has(`voice:${serverId}:${channelId}`)) return;
      socket.to(`voice:${serverId}:${channelId}`).emit('soundboard:stop');
    });

    // Tell the voice room whether this peer is currently sharing their screen (so others can
    // offer a "view full screen" affordance only for screen shares).
    // Camera and screen state name a voice room, and only someone IN that room may speak for it.
    // Being in it already says they passed the door (a member, allowed in the channel, not timed
    // out: mayBeInVoice), and anything that takes them out again (enforceVoiceAccess, a timeout
    // included) drops their Discover entry with them (dropFromVoiceRoom). Without this, any socket
    // could tell a room it was sharing its screen, or put itself on everyone's Discover list as
    // live in a server it was timed out of, or not even in. The client announces its camera right
    // after asking to join, so a join still being decided is waited for first.
    const inVoiceRoom = async (serverId, channelId) => {
      const pending = pendingVoiceJoin();
      if (pending) await pending;
      return typeof serverId === 'string' && typeof channelId === 'string' && socket.rooms.has(`voice:${serverId}:${channelId}`);
    };
    socket.on('voice:screenshare-state', async ({ serverId = 'demo', channelId = 'voice1', sharing } = {}) => {
      if (!(await inVoiceRoom(serverId, channelId))) return;
      socket.to(`voice:${serverId}:${channelId}`).emit('voice:screenshare-state', { id: socket.id, sharing: !!sharing });
    });

    // Global stream state for Watch/Discover: is this user currently sending camera and/or screen?
    socket.on('voice:stream-state', async ({ serverId = 'demo', channelId = 'voice1', camera, screen, genres } = {}) => {
      if (camera || screen) {
        if (!(await inVoiceRoom(serverId, channelId))) return;
        liveStreams[socket.id] = { name: clients[socket.id]?.name || 'Anon', serverId, channelId, camera: !!camera, screen: !!screen, genres: Array.isArray(genres) ? genres.slice(0, 12) : [] };
      } else {
        // Turning it off is always allowed: it can only take an entry away.
        if (!liveStreams[socket.id]) return;
        delete liveStreams[socket.id];
      }
      broadcastDiscover();
    });

    // A client (re)opening the Discover panel asks for the current list.
    socket.on('discover:list', () => socket.emit('discover:update', discoverList()));

    // "I'm live on Twitch/YouTube/Kik" — announce an external stream so friends can watch in-app.
    // Not held to any server's timeout: the announcement names no server or channel, it goes on
    // the instance-wide Discover list, and nobody can watch it inside a server's rooms. A timeout
    // is "no taking part in THIS server", and there is no server here to apply it to.
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
    //
    // An uploaded app as the activity (type 'app') is held to a tighter rule than the built-ins:
    // the sender must be IN the voice room, not merely a member of the server. Its events come from
    // untrusted uploaded code and are fanned out to the room, so only someone the room can see (and
    // who can see the room) gets to start, drive or end one. While an app is the room's activity
    // that also covers replacing it with a built-in, which would otherwise be a way to end it from
    // outside. Built-in activities with no app involved keep the membership check they always had.
    const appName = () => socketUser || clients[socket.id]?.name || 'Anon';
    const inRoom = (room) => socket.rooms.has(room);
    // Whether this person may be given a channel's room key NOW, asked of the database each time an
    // app is started or joined. Being in the voice room is not enough for that: a socket stays in a
    // room it joined after its user is kicked from the server or taken off a private channel, and a
    // room key that such a socket could still collect would make revoking the old one pointless.
    // In a real server the channel has to exist as well: a channel that was deleted has nobody's
    // access rules left, and its id must not go on yielding the keys it had while it was private.
    // The commons has no private channels and no members to lose, so any room name will do there.
    const mayUseAppRoom = async (serverId, channelId) => {
      if (typeof serverId !== 'string' || typeof channelId !== 'string') return false;
      const role = await roleOf(serverId, socketUser);
      if (!role) return false;
      if (serverId === DEMO_ID) return true;
      // Timed out: no starting or joining an app here, for as long as it lasts.
      if (await timedOutIn(serverId)) return false;
      const ch = await db.get("SELECT COALESCE(privacy,'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
      return !!ch && canAccessChannel(serverId, channelId, socketUser, ch.privacy, role);
    };
    // The joined list changed. Nobody is re-sent the app's shared state for that (up to 64 KB each,
    // for a list of names): the room gets just the list. `self` — the socket whose own view changed,
    // because it joined and now needs the state, or left and must drop it — gets its full view.
    const sendAppJoined = (room, act, self) => {
      const list = { run: act.state.run, joined: act.state.joined };
      if (self) { toViewers(act, 'activity:app-joined', list, self.id); self.emit('activity:update', activityViewFor(act, self.id)); }
      else toViewers(act, 'activity:app-joined', list);
    };
    socket.on('activity:start', async ({ serverId = 'demo', channelId = 'voice1', type, appId } = {}) => {
      const room = `voice:${serverId}:${channelId}`;
      if (type === APP_ACTIVITY) {
        if (!Number.isSafeInteger(appId) || !socket.rooms.has(room)) return;
        if (!appEventAllowed(socket.id)) return; // a start costs a query and a room-wide broadcast
        // The room key is made for the server's current epoch (services/appRooms.js). Noted before
        // anything is awaited and compared at the very end: if the server's keys were replaced
        // while this start was reading, the rotation has already ended the server's apps, and an
        // activity created after that would be left running on a key that was just revoked.
        const generation = appRooms.generation(serverId);
        if (!(await mayUseAppRoom(serverId, channelId))) return;
        const epoch = await appRooms.epochOf(serverId);
        if (epoch == null) return;
        // Name, url and icon come from this row. Whatever else the client sent is ignored, so a
        // start can never point the room at a url of the sender's choosing.
        // Asked BEFORE the app's row is read, so that nothing is awaited between reading its status
        // and acting on it: a reject or unpublish landing in between would otherwise have ended the
        // app's rooms just before this one started it.
        const starterIsOwner = await isInstanceOwner(socketUser);
        const row = await db.get("SELECT id, name, url, icon_url, created_by, COALESCE(kind, 'link') AS kind, bundle_dir, embed, status FROM apps WHERE id = ?", appId);
        // Re-checked after the await: they may have left the room while the query ran.
        if (!row || !socket.rooms.has(room)) return;
        // Two kinds of app can run in a room: an uploaded bundle, and a hosted app (a link set to
        // run inside LAN Party). A plain link cannot; it only ever opens in a new tab.
        // A hosted app's address was checked when it was saved. It is checked once more against
        // where THIS socket reached the server, which may be a name that request never saw: a room
        // must not be pointed at a frame on LAN Party's own origin, however the row came to be.
        const isBundle = row.kind === 'bundle' && !!row.bundle_dir;
        const handshake = socket.handshake.headers;
        if (!isBundle && !(isHostedApp(row) && checkHostedUrl(row.url, ownHostKeys(handshake, ownOrigins), { loopback: servedFromLoopback(handshake) }).ok)) return;
        const frameOrigin = appFrameOrigin(row);
        if (!frameOrigin) return;
        // A published app is anyone's to start. One still on its way there (draft, or waiting for
        // review) can be started by its uploader, to try it with real people, or by an instance
        // owner, to review it; the room is told it is unapproved (state.approved) and each person
        // decides whether to join. An app that is 'rejected' runs in no room, whoever asks — which
        // lasts exactly as long as the status does. Its uploader may submit it again, withdraw it
        // or replace its bundle, and it is then pending or a draft like any other and theirs to
        // start. That is deliberate: the same file could be uploaded as a new draft anyway, so a
        // rule here would only look like a ban. Deleting the app is how an owner removes it.
        const ownDraft = (row.status === 'draft' || row.status === 'pending') && !!socketUser && (row.created_by === socketUser || starterIsOwner);
        if (row.status !== 'published' && !ownDraft) return;
        if (appRooms.generation(serverId) !== generation) return; // the keys were replaced meanwhile
        // Bound to the site the frame is on and to the server's epoch as well as to the channel
        // (services/hostedApps.js).
        if ((activities[room]?.size || 0) >= MAX_ACTIVITIES_PER_ROOM) return;
        const act = { id: newActivityId(), type: APP_ACTIVITY, state: appActivityInit(row, appRoomKey(row.id, frameOrigin, serverId, channelId, epoch)), by: appName(), viewers: new Set() };
        roomActs(room).set(act.id, act);
        // Whoever starts it has already chosen to run it, so they are joined from the first update.
        // Nobody else is put in it: they see it in the list and may join.
        leaveActivity(socket.id, { notify: false });
        applyAppEvent(act, { kind: 'join' }, appName(), socket.id);
        enterActivity(socket, room, act);
        sendActivityList(room);
        return;
      }
      if (!ACTIVITY_TYPES.includes(type)) return;
      if (!inRoom(room)) return; // an activity is for people in the call
      if (!(await mayActInVoice(serverId))) return;
      if (!inRoom(room)) return;
      if ((activities[room]?.size || 0) >= MAX_ACTIVITIES_PER_ROOM) return;
      const act = { id: newActivityId(), type, state: activityInit(type), by: clients[socket.id]?.name || 'Anon', viewers: new Set() };
      roomActs(room).set(act.id, act);
      enterActivity(socket, room, act);
      sendActivityList(room);
    });
    // Join a running activity (and leave the one you were in). Seeing it is all this gives: an app
    // still asks for its own Join (which hands over the room key, and is checked then).
    socket.on('activity:join', async ({ serverId = 'demo', channelId = 'voice1', id } = {}) => {
      const room = `voice:${serverId}:${channelId}`;
      if (typeof id !== 'string' || !inRoom(room)) return;
      if (!(await mayActInVoice(serverId))) return;
      const act = activities[room]?.get(id);
      if (!act || !inRoom(room)) { socket.emit('activity:list', activityList(room)); return; }
      enterActivity(socket, room, act);
      sendActivityList(room);
    });
    // Back to the call view; the activity goes on for the others in it.
    socket.on('activity:leave', () => {
      const room = leaveActivity(socket.id);
      if (room) sendActivityList(room);
    });
    socket.on('activity:event', async ({ serverId = 'demo', channelId = 'voice1', event, app: appRun } = {}, ack) => {
      const room = `voice:${serverId}:${channelId}`;
      // An app's events say which run of which app they are for (`app`, the run id from its state);
      // a built-in's carry no such tag. The two never cross: without this, an event still on the
      // wire when the room's activity was swapped landed on whatever replaced it — an app's "join"
      // seating someone in a game of Tic-Tac-Toe, a Tic-Tac-Toe "join" adding someone to an app
      // they never chose, one app's frame writing into the next app's state.
      if (appRun !== undefined || actViewedBy(room, socket.id)?.type === APP_ACTIVITY) {
        // Synchronous for everything an app itself sends, and the bucket comes first: only someone
        // who has joined can set or emit, so a flooding app costs no database query at all.
        // The ack tells the sender's SDK whether to keep or roll back its optimistic change; a
        // dropped event is otherwise silent — nobody else in the room hears about it.
        const reply = (r) => { if (typeof ack === 'function') ack(r); };
        const act = actViewedBy(room, socket.id);
        if (!act || act.type !== APP_ACTIVITY) return reply({ ok: false, reason: 'ended' });
        if (!socket.rooms.has(room)) return reply({ ok: false, reason: 'not-in-room' });
        if (!appEventAllowed(socket.id)) return reply({ ok: false, reason: 'rate-limited' });
        if (appRun !== act.state.run) return reply({ ok: false, reason: 'ended' });
        // Joining is what hands over the room key, so it is the one event that asks the database
        // whether this person may still have it (mayUseAppRoom). It comes from LAN Party's own
        // Join button, not from the app, and the bucket above has already been charged for it.
        // Everything is looked at again afterwards: the activity may have been ended (a rotation
        // does that), or they may have left the room, while the answer was on its way.
        if (event && typeof event === 'object' && event.kind === 'join') {
          if (!(await mayUseAppRoom(serverId, channelId))) return reply({ ok: false, reason: 'no-access' });
          if (actViewedBy(room, socket.id) !== act) return reply({ ok: false, reason: 'ended' });
          if (!socket.rooms.has(room)) return reply({ ok: false, reason: 'not-in-room' });
        }
        const result = applyAppEvent(act, event, appName(), socket.id);
        if (!result.ok) return reply({ ok: false, reason: result.reason });
        if (result.relay) {
          // Fixed event name, this room's joined sockets only: the app chooses the payload and
          // nothing else about where it goes.
          for (const id of appJoinedSockets(act)) if (id !== socket.id) io.to(id).emit('activity:app-message', result.relay);
        } else if (result.audience === 'joined') {
          // State goes out BEFORE the ack, so by the time the sender hears "ok" it already holds
          // the state that includes its change.
          broadcastActivity(room, act, { joinedOnly: true });
        } else if (result.audience === 'room') {
          sendAppJoined(room, act, socket);
        }
        return reply({ ok: true, rev: act.state.rev });
      }
      if (!(await mayActInVoice(serverId))) return;
      const act = actViewedBy(room, socket.id);
      if (!act || !event || typeof event !== 'object') return;
      // An app may have become the activity while the membership query ran; its events never go
      // through the built-in reducer.
      if (act.type === APP_ACTIVITY) return;
      applyActivityEvent(act, event, clients[socket.id]?.name || 'Anon', { room });
      broadcastActivity(room, act);
    });
    socket.on('activity:stop', async ({ serverId = 'demo', channelId = 'voice1' } = {}) => {
      if (!(await mayActInVoice(serverId))) return;
      const room = `voice:${serverId}:${channelId}`;
      // Ends the activity you are in, for everyone in it. Nobody else's is touched.
      const act = actViewedBy(room, socket.id);
      if (!act) return;
      endActivity(room, act);
      sendActivityList(room);
    });

    // --- Collaborative image editing (shared annotation canvas, session keyed by image url) ---
    //
    // A session started in a channel belongs to that channel: its room is named after the server,
    // the channel and the image, and only someone who may use the channel right now (mayCollabIn:
    // a member, allowed in the channel, not timed out in the server) gets into it. A session opened
    // from a direct conversation names no channel and keeps its old room, the image url alone; it
    // never shares a room, a stroke or an invitation with a channel's session of the same image.
    // Strokes and clears go only to the session the sending socket is IN, never to one it merely
    // names, so the door is the one place access is decided; enforceCollabAccess takes a socket
    // back out when its access ends (a timeout included).
    const COLLAB_ID_MAX = 2048; // the session id is an image url
    // Two prefixes, and the ids encoded, so that no session id can be chosen to spell another
    // session's room: a direct conversation's id is not a way into a channel's canvas.
    const collabRoom = (serverId, channelId, sessionId) => (serverId === undefined && channelId === undefined
      ? `collab-dm:${sessionId}`
      : `collab:${encodeURIComponent(serverId)}:${encodeURIComponent(channelId)}:${sessionId}`);
    const validSessionId = (sessionId) => typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= COLLAB_ID_MAX;
    // The session room this socket has joined for that id, or null.
    const joinedCollab = (sessionId) => {
      if (!validSessionId(sessionId)) return null;
      for (const room of socket.rooms) {
        const sess = collabSessions[room];
        if (sess && sess.sessionId === sessionId) return { room, sess };
      }
      return null;
    };
    const refuseCollab = async (sessionId, serverId, channelId) => {
      const timeout = typeof serverId === 'string' ? await timedOutIn(serverId) : null;
      socket.emit('collab:removed', { sessionId, serverId, channelId, ...(timeout ? { reason: 'timeout', until: timeout.until } : {}) });
    };
    // Announce a collaboration so others in the channel can join.
    socket.on('collab:start', async ({ serverId = 'demo', channelId = 'general', sessionId, imageUrl } = {}) => {
      if (!validSessionId(sessionId)) return;
      if (!(await mayCollabIn(socketUser, serverId, channelId))) { await refuseCollab(sessionId, serverId, channelId); return; }
      const room = collabRoom(serverId, channelId, sessionId);
      if (!collabSessions[room]) collabSessions[room] = { sessionId, imageUrl, segments: [], serverId, channelId };
      const by = clients[socket.id]?.name || 'Anon';
      socket.to(`channel:${serverId}:${channelId}`).emit('collab:invite', { sessionId, imageUrl, by, serverId, channelId });
    });
    // Join a session and receive the current canvas state. With a server and channel, the channel's
    // session (asked of the database); without, a direct conversation's.
    socket.on('collab:join', async ({ sessionId, imageUrl, serverId, channelId } = {}) => {
      if (!validSessionId(sessionId)) return;
      const scoped = serverId !== undefined || channelId !== undefined;
      if (scoped && !(await mayCollabIn(socketUser, serverId, channelId))) { await refuseCollab(sessionId, serverId, channelId); return; }
      const room = collabRoom(scoped ? serverId : undefined, scoped ? channelId : undefined, sessionId);
      // One canvas at a time: the client shows one, and a stroke must not land on an old one too.
      for (const r of [...socket.rooms]) if (r !== room && collabSessions[r]) socket.leave(r);
      socket.join(room);
      const sess = collabSessions[room] || (collabSessions[room] = { sessionId, imageUrl, segments: [], ...(scoped ? { serverId, channelId } : {}) });
      socket.emit('collab:state', { sessionId, segments: sess.segments });
    });
    // A drawn segment: store it and relay to everyone else in the session.
    socket.on('collab:draw', ({ sessionId, segment } = {}) => {
      const joined = joinedCollab(sessionId);
      if (!joined || !segment || typeof segment !== 'object') return;
      const { room, sess } = joined;
      sess.segments.push(segment);
      if (sess.segments.length > 20000) sess.segments.splice(0, sess.segments.length - 20000); // cap memory
      socket.to(room).emit('collab:draw', { segment });
    });
    socket.on('collab:clear', ({ sessionId } = {}) => {
      const joined = joinedCollab(sessionId);
      if (!joined) return;
      joined.sess.segments = [];
      socket.to(joined.room).emit('collab:clear');
    });
    socket.on('collab:leave', ({ sessionId } = {}) => {
      const joined = joinedCollab(sessionId);
      if (joined) socket.leave(joined.room);
    });

    // Voice signaling: simple mesh signaling via server
    // `mode` is how this client will carry its media ('sfu' or 'mesh', see VOICE_MODES) and
    // `reason` why it is not using the SFU, when it is not. Both are optional: an older client
    // sends neither.
    socket.on('voice:join', async ({ serverId = 'demo', channelId = 'voice1', mode, reason } = {}) => {
      // The two checks below read the database, and the client's next event is handled while they
      // do. Anything that needs to know whether this socket is in the room waits on `deciding`,
      // which ends the moment the answer exists — in `finally`, so a refusal (or a throw) can never
      // leave a later request waiting for a join that is not coming.
      let decided = () => {};
      const deciding = new Promise((resolve) => { decided = resolve; });
      voiceJoins.add(deciding);
      const room = `voice:${serverId}:${channelId}`;
      const declared = VOICE_MODES.includes(mode) ? mode : null;
      try {
        if (!(await mayUseVoice(serverId))) { socket.emit('server:denied', { serverId }); return; }
        // A member, but not of this channel (or it does not exist): refused at the door.
        // Or timed out in this server: refused the same way, with the reason so the client can say so.
        if (!(await mayBeInVoice(socketUser, serverId, channelId))) { socket.emit('voice:removed', await voiceRemovedPayload(socketUser, serverId, channelId)); return; }
        // The commons' voice rooms are "posting in the commons" with a microphone: the same wait
        // for a confirmed email as its text channels.
        if (serverId === DEMO_ID) {
          const refusal = await unverifiedRefusal();
          if (refusal) { socket.emit('voice:removed', { serverId, channelId, reason: refusal.code, error: refusal.error }); return; }
        }
        // An older client that gives up on the SFU says so by joining the room it is already in
        // (that made the server send it the roster again, which it then called directly). Its
        // producers are still registered here, sending nothing; closing them is what lets everyone
        // else stop waiting for audio from them.
        const fellBack = !declared && socket.rooms.has(room);
        socket.join(room);
        setVoiceMode(room, socket.id, declared);
        if (declared === 'mesh' || fellBack) sfu.removePeer(room, socket.id);
        if (fellBack) {
          noteVoiceFallback('old-client');
          // Told to the room here, before the roster goes back to that client, so it is heard
          // before the offers the client is about to send everyone: until this moment it ignored
          // all signalling, so any connection someone started towards it is still waiting for an
          // answer that will never come, and would collide with the offer that is on its way.
          socket.to(room).emit('voice:mode', { id: socket.id, mode: null });
        } else if (declared === 'mesh' && reason !== undefined) noteVoiceFallback(reason);
      } finally {
        voiceJoins.delete(deciding);
        decided();
      }
      const roomSet = io.sockets.adapter.rooms.get(room) || new Set();
      const peers = Array.from(roomSet).filter(id => id !== socket.id).map(id => ({ id, name: clients[id]?.name || 'Anon', mode: voiceModeOf(room, id) }));
      socket.emit('voice:peers', peers);
      // Nothing opens by itself on joining: the call view, and the list of what is running.
      socket.emit('activity:update', null);
      socket.emit('activity:list', activityList(room));
      // The joiner's entrance clip is read from the DB, never taken from the client — otherwise a
      // socket could make everyone else in the room fetch and play an arbitrary url.
      let entranceSound = '';
      if (socketUser) {
        try { entranceSound = await currentEntranceUrl(socketUser); }
        catch (err) { console.warn('entrance lookup failed', err && err.message); }
      }
      // Left again (or disconnected) while the clip was looked up: there is nobody to announce.
      if (!socket.rooms.has(room)) return;
      // The mode is read now, not taken from `declared`: it may have changed during the lookup.
      socket.to(room).emit('voice:peer-joined', { id: socket.id, name: clients[socket.id]?.name, entranceSound, mode: voiceModeOf(room, socket.id) });
    });

    // A participant's mode changed mid-call — in practice from 'sfu' to 'mesh', when its media never
    // reached the SFU. The room is told so that everyone who now needs a direct connection with it
    // sets one up, and its SFU state is dropped so nobody keeps a silent stream of it.
    // Synchronous unless a join is still being decided, so it reaches the room BEFORE the offers
    // (voice:signal) the same client sends right behind it.
    socket.on('voice:mode', ({ serverId = 'demo', channelId = 'voice1', mode, reason } = {}) => {
      const apply = () => {
        const room = `voice:${serverId}:${channelId}`;
        if (!VOICE_MODES.includes(mode) || !socket.rooms.has(room)) return;
        if (voiceModeOf(room, socket.id) === mode) return;
        setVoiceMode(room, socket.id, mode);
        if (mode === 'mesh') {
          sfu.removePeer(room, socket.id);
          noteVoiceFallback(reason);
        }
        socket.to(room).emit('voice:mode', { id: socket.id, mode });
      };
      const joining = pendingVoiceJoin();
      if (joining) joining.then(apply); else apply();
    });

    socket.on('voice:leave', ({ serverId = 'demo', channelId = 'voice1' } = {}) => {
      // A leave sent right behind a join used to be handled first, and the join then put the socket
      // into a room its client believed it had left.
      const leave = () => dropFromVoiceRoom(socket, `voice:${serverId}:${channelId}`);
      const joining = pendingVoiceJoin();
      if (joining) joining.then(leave); else leave();
    });

    socket.on('voice:signal', ({ to, signal } = {}) => {
      if (!to) return;
      io.to(to).emit('voice:signal', { from: socket.id, signal });
    });

    // ---- Direct 1:1 calls between friends (ring/accept/decline + WebRTC relay) ----
    // Invite/accept/decline/cancel/end route by user room or peer socket id; call:signal relays
    // WebRTC offers/answers/ICE by socket id (like voice:signal, but on a separate channel so it
    // never collides with server-voice-channel signaling).
    // Is there a block between this socket's user and that username, either way round? Unknown
    // names and lookup failures count as "no": they are dealt with by what follows the check.
    const blockBetweenMeAnd = async (username) => {
      try {
        const me = await getUserByUsername(socketUser);
        const peer = await getUserByUsername(String(username));
        return !!me && !!peer && await blocks.between(me.id, peer.id);
      } catch (err) {
        console.warn('block lookup failed:', err && err.message);
        return false;
      }
    };
    socket.on('call:invite', async ({ to, video } = {}) => {
      if (!socketUser || !to) return;
      // Calls wait for a confirmed email, in both directions. This is the caller's own state, so
      // they are told plainly (unlike a block, below).
      const refusal = await unverifiedRefusal();
      if (refusal) { socket.emit('call:refused', { to, reason: refusal.code, error: refusal.error }); return; }
      // A block between the two, in either direction, and the call never rings. The caller is told
      // what they are told when the other person is not online, and nothing else: it must not be
      // possible to tell a block from an absence. The lookup runs before the "are they online"
      // check for every call, blocked or not, so the two answers also take the same time.
      const blocked = await blockBetweenMeAnd(to);
      const room = io.sockets.adapter.rooms.get(`user:${to}`);
      if (blocked || !room || room.size === 0) { socket.emit('call:unavailable', { to }); return; }
      io.to(`user:${to}`).emit('call:incoming', { from: socketUser, fromSocket: socket.id, video: !!video });
    });
    socket.on('call:accept', async ({ to } = {}) => { // to = caller's socket id
      if (!to) return;
      const refusal = await unverifiedRefusal();
      if (refusal) { socket.emit('call:refused', { reason: refusal.code, error: refusal.error }); return; }
      io.to(to).emit('call:accepted', { from: socketUser, fromSocket: socket.id });
      // Tell this user's OTHER devices to stop ringing.
      socket.to(`user:${socketUser}`).emit('call:handled');
    });
    socket.on('call:decline', ({ to } = {}) => { // to = caller's socket id
      if (to) io.to(to).emit('call:declined', { from: socketUser });
      socket.to(`user:${socketUser}`).emit('call:handled');
    });
    socket.on('call:cancel', async ({ to } = {}) => { // to = callee username (caller hangs up before answer)
      if (!to) return;
      // Addressed by username like an invite, so it is held to the same rule: a call that was
      // never allowed to ring has nothing to cancel on the other side.
      if (socketUser && await blockBetweenMeAnd(to)) return;
      io.to(`user:${to}`).emit('call:canceled', { from: socketUser });
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
          setVoiceMode(room, socket.id, null);
          socket.to(room).emit('voice:peer-left', { id: socket.id });
          sfu.removePeer(room, socket.id);
          // Out of their activity (and its app's joined list, or a closed tab stays "playing").
          if (leaveActivity(socket.id, { notify: false }) === room) socket.to(room).emit('activity:list', activityList(room));
        }
      }
      if (liveStreams[socket.id] || externalStreams[socket.id]) {
        delete liveStreams[socket.id];
        delete externalStreams[socket.id];
        broadcastDiscover();
      }
    });

    socket.on('disconnect', () => {
      push.dropSocket(socket.id); // a closed window is not looking at anything
      forgetAppSocket(socket.id);
      const info = clients[socket.id];
      delete clients[socket.id];
      if (info) {
        const serverId = info.serverId;
        // The full, per-socket state — the same thing a join sends. This used to emit a bare
        // `{ server: { id } }`, and the client replaces its whole server state with whatever arrives,
        // so one person closing their tab blanked the server name and channel list for everyone else
        // looking at that server until they clicked it again.
        broadcastServerState(serverId).catch((err) => console.warn('state after disconnect failed:', err && err.message));
        if (info.username) {
          setUserPresenceByUsername(info.username, 'offline')
            .then((status) => broadcastPresenceToFriends(info.username, status))
            .catch((err) => console.warn('presence on disconnect failed', err));
        }
      }
    });
  });

  // Collect avatar files nothing points at any more. Avatars are exempt from the 7-day sweep by
  // design, so without this they accumulate forever: a crash between writing a file and storing its
  // url orphans one, and so does a settings write that drops the reference without going through the
  // release path. Unreferenced files older than the grace period below are removed.
  //
  // The grace period matters — a file is on disk before its url is stored, so sweeping a brand-new
  // upload would delete the picture out from under the request that just created it.
  const ORPHAN_AVATAR_GRACE_MS = 24 * 60 * 60 * 1000;
  async function sweepOrphanAvatars() {
    let files;
    try {
      files = await fs.promises.readdir(avatarsDir);
    } catch (_) {
      return;
    }
    if (!files.length) return;
    // One pass over the settings blobs: anything mentioning the filename counts as a reference, which
    // errs towards keeping files rather than deleting one that is still in use.
    const rows = await db.all("SELECT settings FROM users WHERE settings LIKE '%/avatars/%'");
    const referenced = new Set();
    for (const row of rows) {
      for (const match of String(row.settings || '').matchAll(/\/avatars\/([A-Za-z0-9._-]+)/g)) {
        referenced.add(match[1]);
      }
    }
    const now = Date.now();
    let removed = 0;
    for (const name of files) {
      if (referenced.has(name)) continue;
      const full = path.join(avatarsDir, name);
      try {
        const stat = await fs.promises.stat(full);
        if (!stat.isFile() || now - stat.mtimeMs < ORPHAN_AVATAR_GRACE_MS) continue;
        await fs.promises.unlink(full);
        removed += 1;
      } catch (_) { /* vanished under us, or not ours to remove */ }
    }
    if (removed) console.log(`[avatars] removed ${removed} unreferenced picture(s)`);
  }

  // Sweep expired uploads on startup, then hourly. Orphaned avatars and link preview images ride
  // the same schedule.
  const runSweeps = () => {
    cleanupExpiredUploads().catch((err) => console.warn('upload cleanup failed', err));
    sweepOrphanAvatars().catch((err) => console.warn('avatar cleanup failed', err));
    // Link preview images nothing shows any more, and cache rows past their time. Runs whether or
    // not previews are switched on: turning them off must not strand what was stored before.
    linkPreviews.sweep().catch((err) => console.warn('link preview cleanup failed', err && err.message));
  };
  runSweeps();
  setInterval(runSweeps, CLEANUP_INTERVAL_MS).unref();

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
  // Nothing matched. Answered here rather than by Express's built-in 404, which replaces the
  // Content-Security-Policy set at the top with one of its own and so drops frame-ancestors.
  app.use((req, res) => res.status(404).type('txt').send('Not found'));
  // The same for an error nothing else answered (a body too large for the JSON parser, a throw in a
  // route): the status Express would have sent, as plain text, with the headers set above intact.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const asked = Number(err && (err.status || err.statusCode));
    const status = asked >= 400 && asked < 600 ? asked : 500;
    if (status >= 500) console.error(err);
    res.status(status).type('txt').send(http.STATUS_CODES[status] || 'Error');
  });

  // Log the port actually bound, not the one requested: with PORT=0 the OS picks one, and the tests
  // read this line to find the server they just started. In production PORT is set, so this prints
  // exactly what it always did.
  server.listen(PORT, () => {
    const bound = server.address()?.port ?? PORT;
    console.log(`LAN Party server on ${bound}${serveClient ? ' (serving client)' : ''}`);
  });
}

main().catch(err => { console.error('Server failed to start', err); process.exit(1) });
