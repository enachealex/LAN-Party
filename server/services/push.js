// @ts-check
// Web Push: notifications that still arrive when the app is closed. Until this existed a message
// could only raise a notification from a tab that was open (new Notification(...) in the client), so
// closing the app meant hearing nothing until you came back.
//
// How it fits together:
// - A browser subscribes with its push service (FCM, Mozilla autopush, Apple, WNS) using our VAPID
//   public key and hands us the resulting endpoint + keys. We store one row per browser.
// - When something worth an interruption happens we encrypt a small JSON payload to each of the
//   recipient's browsers and POST it to their endpoint. The service worker turns it into a
//   notification.
//
// Rules:
// - Zero config. The VAPID keypair is generated on first boot and kept in DATA_DIR/vapid.json; it IS
//   the server's identity to the push services, so losing it orphans every subscription.
// - Nobody is pushed while they are looking at the app. The client reports focus per socket
//   ('presence:focus'); one focused window anywhere is enough to stay quiet, because the open app is
//   already showing the message.
// - Pushing is never allowed to fail the thing that caused it. notify() resolves whatever happens;
//   callers do not await it.
// - The whole module is defensive, like the SFU: the production host does not reinstall dependencies
//   on deploy, so `web-push` may simply not be there. Then available() is false, the endpoints say
//   so, and nothing else changes.
//
// Config (env, all optional):
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   use this keypair instead of DATA_DIR/vapid.json
//   VAPID_SUBJECT                          contact the push services may use (mailto: or https:);
//                                          defaults to mailto:admin@<CLIENT_ORIGIN's hostname>
//   WEB_PUSH_MODULE                        test seam: module to load in place of 'web-push'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * @typedef {import('../db/migrate').Db} Db
 * @typedef {{ endpoint: string, keys: { p256dh: string, auth: string } }} PushTarget
 * @typedef {{ title: string, body: string, tag: string, url: string }} PushPayload
 * @typedef {{ TTL: number, urgency: string, topic: string }} SendOptions
 * @typedef {(target: PushTarget, payload: string, options: SendOptions) => Promise<unknown>} PushSender
 * @typedef {{ publicKey: string, privateKey: string }} VapidKeys
 * @typedef {{ type?: string, name?: string, url?: string } | null | undefined} Attachment
 * @typedef {{ text: string, media: 'gif' | 'image' | 'video' | 'file' | null }} Preview
 */

// One person rarely has more than a phone, a laptop and a desktop browser. The ceiling is there so a
// looping client (or a stolen token) cannot grow the table, and so one message never fans out into
// an unbounded number of outbound requests.
const MAX_SUBSCRIPTIONS_PER_USER = 10;
// A notification shows a line or two; anything longer is cut off by the OS anyway, and the payload
// has to stay well inside the push services' ~4 KB limit.
const BODY_MAX = 140;
// How long a push service holds a message for a device that is offline. A chat message that turns up
// a day late is still worth seeing; one that turns up a week late is noise.
const PUSH_TTL_SECONDS = 24 * 60 * 60;
// A push service that does not answer must not pin a request open forever.
const SEND_TIMEOUT_MS = 10_000;
// How many people one channel message can push by @mentioning them. Without a ceiling a single
// message listing every name would be a way to make everyone's phone buzz at once.
const MAX_MENTION_TARGETS = 20;
// How many mention-bearing messages from one sender may push per window (see allowMentionPush).
const MENTION_PUSHES_PER_WINDOW = 6;
const MENTION_WINDOW_MS = 60_000;

const VAPID_FILE = 'vapid.json';

// Same lists the client uses to decide what renders inline (isImageAttachment / isVideoAttachment in
// client/src/App.jsx), so "sent a GIF" here matches what the recipient sees when they open the app.
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v', 'mkv'];
const MEDIA_LABELS = { gif: 'a GIF', image: 'an image', video: 'a video', file: 'a file' };

/**
 * Load the web-push library, or null when it is not installed. Never throws: a missing module has
 * to switch the feature off, not stop the server booting.
 * @param {string} [moduleId]
 * @returns {any}
 */
function loadWebPush(moduleId = 'web-push') {
  try {
    const lib = require(moduleId);
    return lib && typeof lib.sendNotification === 'function' ? lib : null;
  } catch (_) {
    return null;
  }
}

/** @param {unknown} value @param {number} bytes */
function decodesTo(value, bytes) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const buf = Buffer.from(value, 'base64url');
  return buf.length === bytes ? buf : null;
}

/**
 * Is this a usable VAPID keypair? Checks that the two halves belong together, not just their shape:
 * a public key pasted from one deployment and a private key from another looks fine and then gets a
 * 403 from every push service on every send.
 * @param {unknown} publicKey @param {unknown} privateKey
 * @returns {boolean}
 */
function isVapidPair(publicKey, privateKey) {
  const pub = decodesTo(publicKey, 65);
  const priv = decodesTo(privateKey, 32);
  if (!pub || !priv || pub[0] !== 0x04) return false;
  try {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(priv);
    return ecdh.getPublicKey().equals(pub);
  } catch (_) {
    return false;
  }
}

/** @returns {VapidKeys} */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  // The private scalar comes back shorter than 32 bytes when it happens to start with zeros; VAPID
  // wants exactly 32.
  const priv = ecdh.getPrivateKey();
  const padded = Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: padded.toString('base64url') };
}

/**
 * The server's VAPID keypair: from the environment if given, else DATA_DIR/vapid.json, created on
 * first use. Returns null (push off) rather than guessing whenever the answer would be unreliable.
 * The private key is never logged.
 * @param {{ dataDir: string, env: Record<string, string | undefined>, log: Pick<Console, 'log' | 'warn'> }} deps
 * @returns {(VapidKeys & { source: string }) | null}
 */
function loadOrCreateVapidKeys({ dataDir, env, log }) {
  const envPublic = (env.VAPID_PUBLIC_KEY || '').trim();
  const envPrivate = (env.VAPID_PRIVATE_KEY || '').trim();
  if (envPublic || envPrivate) {
    if (isVapidPair(envPublic, envPrivate)) return { publicKey: envPublic, privateKey: envPrivate, source: 'the environment' };
    // Do NOT fall back to the file: the operator asked for specific keys, and quietly using
    // different ones would subscribe every browser against an identity they did not choose.
    log.warn('[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a matching keypair: push notifications are off');
    return null;
  }

  const file = path.join(dataDir, VAPID_FILE);
  try {
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (stored && isVapidPair(stored.publicKey, stored.privateKey)) {
      // Tighten a file that was copied or restored with looser permissions. Best effort.
      try { fs.chmodSync(file, 0o600); } catch (_) { /* not ours to chmod, or no such concept (Windows) */ }
      return { publicKey: stored.publicKey, privateKey: stored.privateKey, source: VAPID_FILE };
    }
    log.warn(`[push] ${VAPID_FILE} does not hold a valid keypair: generating a new one (browsers re-subscribe the next time the app is opened)`);
  } catch (err) {
    const code = /** @type {any} */ (err)?.code;
    if (err instanceof SyntaxError) {
      log.warn(`[push] ${VAPID_FILE} is not valid JSON: generating a new keypair (browsers re-subscribe the next time the app is opened)`);
    } else if (code !== 'ENOENT') {
      // Unreadable is not the same as absent. Replacing a key we merely could not read would orphan
      // every existing subscription over what may be a passing permissions problem.
      log.warn(`[push] could not read ${VAPID_FILE} (${code || 'error'}): push notifications are off`);
      return null;
    }
  }

  const keys = generateVapidKeys();
  try {
    // Written beside the target and renamed into place, so a crash mid-write can never leave half a
    // key behind for the next boot to trip over. 0600: the private key is a credential.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) { /* see above */ }
  } catch (err) {
    // A key that only lives in memory changes on every restart, and each change silently breaks
    // every subscription made before it. Off is the honest answer.
    log.warn(`[push] could not save ${VAPID_FILE} (${/** @type {any} */ (err)?.code || 'error'}): push notifications are off`);
    return null;
  }
  return { ...keys, source: `${VAPID_FILE}, newly generated` };
}

/**
 * The contact the push services are given for this server. They only require that it is a mailto:
 * or https: URL, so with nothing configured it is derived from where the app is hosted.
 * @param {Record<string, string | undefined>} env @param {string} [clientOrigin]
 * @returns {string}
 */
function vapidSubjectFor(env, clientOrigin) {
  const explicit = (env.VAPID_SUBJECT || '').trim();
  if (/^(mailto:\S+@\S+|https:\/\/\S+)$/i.test(explicit)) return explicit;
  for (const origin of String(clientOrigin || '').split(',')) {
    try {
      const host = new URL(origin.trim()).hostname;
      if (host) return `mailto:admin@${host}`;
    } catch (_) { /* '*' or not a URL: try the next one */ }
  }
  // CLIENT_ORIGIN is '*' (the local default). Still has to be well-formed, or every send is refused.
  return 'mailto:admin@localhost';
}

/** @param {string} text */
function clip(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  // By code point, so the cut never lands in the middle of an emoji.
  const chars = Array.from(flat);
  return chars.length > BODY_MAX ? `${chars.slice(0, BODY_MAX - 1).join('').trimEnd()}…` : flat;
}

/** @param {unknown} type @param {unknown} name @returns {'gif' | 'image' | 'video' | null} */
function mediaKind(type, name) {
  const mime = String(type || '').toLowerCase();
  const match = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(String(name || ''));
  const ext = match ? match[1].toLowerCase() : '';
  if (mime.startsWith('video/') || VIDEO_EXTS.includes(ext)) return 'video';
  if (mime === 'image/gif' || ext === 'gif') return 'gif';
  if (mime.startsWith('image/') || IMAGE_EXTS.includes(ext)) return 'image';
  return null;
}

/** @param {string} url */
function mediaKindOfUrl(url) {
  let pathname = url.split(/[?#]/)[0];
  if (/^https?:\/\//i.test(url)) {
    try { pathname = new URL(url).pathname; } catch (_) { return null; }
  }
  return mediaKind('', pathname.split('/').pop());
}

/**
 * What a notification should say a message contains. Follows the client's rule for media in message
 * text (mediaUrlFromText in client/src/App.jsx): a message whose LAST token is a media url renders
 * that media inline. So a bare GIF link is "a GIF", not forty characters of Tenor url, and
 * "look at this <url>" is just its caption.
 * @param {unknown} text @param {Attachment} [attachment]
 * @returns {Preview}
 */
function previewOf(text, attachment) {
  const trimmed = String(text || '').trim();
  if (trimmed) {
    const tokens = trimmed.split(/\s+/);
    const last = tokens[tokens.length - 1];
    const kind = /^(https?:\/\/|\/)\S+$/i.test(last) ? mediaKindOfUrl(last) : null;
    if (kind && tokens.length === 1) return { text: '', media: kind };
    if (kind) return { text: clip(trimmed.slice(0, trimmed.length - last.length)), media: null };
    return { text: clip(trimmed), media: null };
  }
  if (attachment) return { text: '', media: mediaKind(attachment.type, attachment.name || attachment.url) || 'file' };
  return { text: '', media: null };
}

/** Body for a notification whose title already names the sender. @param {Preview} preview */
function bodyAlone(preview) {
  if (preview.media) return `Sent ${MEDIA_LABELS[preview.media]}`;
  return preview.text || 'New message';
}

/**
 * Body for a notification titled after a place (a group, a channel), so it has to say who spoke.
 * @param {string} author @param {Preview} preview
 */
function bodyFrom(author, preview) {
  if (preview.media) return `${author} sent ${MEDIA_LABELS[preview.media]}`;
  return clip(`${author}: ${preview.text || 'New message'}`);
}

/**
 * Usernames a message @mentions, in the order written. Same token shape the unread badge uses
 * (emitUnreadBump), with two refinements that matter once a mention can make a phone buzz: an "@" in
 * the middle of a word is an email address, not a mention, and "@sam." at the end of a sentence
 * still means sam.
 * @param {unknown} text
 * @returns {string[]}
 */
function mentionedUsernames(text) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const match of String(text || '').matchAll(/(?<!\w)@(\w[\w.-]*)/g)) {
    names.add(match[1]);
    const bare = match[1].replace(/[.-]+$/, '');
    if (bare) names.add(bare);
  }
  return [...names];
}

/**
 * Where a push went, for logs. The path of an endpoint is the secret part, so only the host is ever
 * printed.
 * @param {string} endpoint
 */
function hostOf(endpoint) {
  try { return new URL(endpoint).host; } catch (_) { return 'unknown host'; }
}

/**
 * @param {{
 *   db: Db,
 *   dataDir: string,
 *   clientOrigin?: string,
 *   env?: Record<string, string | undefined>,
 *   webpush?: any,
 *   sender?: PushSender | null,
 *   log?: Pick<Console, 'log' | 'warn'>,
 * }} deps `sender` replaces the function that talks to the push services (tests pass one, so nothing
 *   ever leaves the machine). `webpush` replaces the library; pass null to behave as if it were not
 *   installed.
 */
function createPush({ db, dataDir, clientOrigin = '', env = process.env, webpush, sender = null, log = console }) {
  const lib = webpush === undefined ? loadWebPush(env.WEB_PUSH_MODULE || 'web-push') : webpush;

  /** @type {VapidKeys | null} */
  let vapid = null;
  /** @type {PushSender | null} */
  let send = null;
  if (sender || lib) {
    const keys = loadOrCreateVapidKeys({ dataDir, env, log });
    if (keys) {
      vapid = { publicKey: keys.publicKey, privateKey: keys.privateKey };
      const vapidDetails = { subject: vapidSubjectFor(env, clientOrigin), publicKey: keys.publicKey, privateKey: keys.privateKey };
      send = sender || ((target, payload, options) => lib.sendNotification(target, payload, { ...options, vapidDetails, timeout: SEND_TIMEOUT_MS }));
      log.log(`[push] notifications on (VAPID keys from ${keys.source})`);
    }
  } else {
    log.log('[push] web-push is not installed: push notifications are off (npm install in server/ turns them on)');
  }

  const available = () => !!send;
  const publicKey = () => (send && vapid ? vapid.publicKey : null);

  // --- Focus: who is looking at the app right now ---
  // socket id -> username, present only while that window is visible AND focused. A socket that has
  // never reported is absent, i.e. "not looking": the right default for a tab that connected in the
  // background, and for anything that dies before saying otherwise.
  /** @type {Map<string, string>} */
  const focusedSockets = new Map();

  /** @param {string} socketId @param {string | null | undefined} username @param {boolean} focused */
  function setFocus(socketId, username, focused) {
    if (focused && username) focusedSockets.set(socketId, username);
    else focusedSockets.delete(socketId);
  }
  /** @param {string} socketId */
  function dropSocket(socketId) { focusedSockets.delete(socketId); }
  /** @param {string} username */
  function isFocused(username) {
    for (const who of focusedSockets.values()) if (who === username) return true;
    return false;
  }

  // --- Subscriptions ---

  /**
   * Remember a browser's subscription for `username`. The endpoint identifies the browser, so if it
   * is already on file for someone else it MOVES: two people sharing a device must never both be
   * attached to it, or the second would keep receiving the first one's notifications.
   * @param {string} username @param {PushTarget} subscription @param {string} [userAgent]
   */
  async function subscribe(username, subscription, userAgent = '') {
    const now = Date.now();
    await db.run(
      `INSERT INTO push_subscriptions (endpoint, username, p256dh, auth, user_agent, created_at, last_success_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(endpoint) DO UPDATE SET
         created_at = CASE WHEN push_subscriptions.username = excluded.username THEN push_subscriptions.created_at ELSE excluded.created_at END,
         last_success_at = CASE WHEN push_subscriptions.username = excluded.username THEN push_subscriptions.last_success_at ELSE NULL END,
         username = excluded.username,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent`,
      subscription.endpoint, username, subscription.keys.p256dh, subscription.keys.auth, String(userAgent || '').slice(0, 300), now
    );
    // Over the cap, the browsers heard from least recently go: those are the ones most likely to be
    // a phone that was wiped or a profile that no longer exists. Refusing the new one instead would
    // lock someone out of notifications on the device in their hand because of devices they no longer
    // have. The row just written always survives.
    await db.run(
      `DELETE FROM push_subscriptions
        WHERE username = ? AND endpoint NOT IN (
          SELECT endpoint FROM push_subscriptions WHERE username = ?
           ORDER BY (endpoint = ?) DESC, MAX(created_at, COALESCE(last_success_at, 0)) DESC
           LIMIT ?)`,
      username, username, subscription.endpoint, MAX_SUBSCRIPTIONS_PER_USER
    );
  }

  /**
   * Forget a browser. Scoped to the caller: knowing an endpoint is not a licence to remove a
   * subscription that has since moved to someone else on the same device.
   * @param {string} username @param {string} endpoint
   * @returns {Promise<number>} rows removed (0 when it was not theirs, or already gone)
   */
  async function unsubscribe(username, endpoint) {
    const result = await db.run('DELETE FROM push_subscriptions WHERE endpoint = ? AND username = ?', endpoint, username);
    return (result && result.changes) || 0;
  }

  // --- Sending ---

  /** @param {{ endpoint: string, p256dh: string, auth: string }} row @param {string} body @param {SendOptions} options */
  async function sendOne(row, body, options) {
    if (!send) return;
    try {
      await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, body, options);
      await db.run('UPDATE push_subscriptions SET last_success_at = ? WHERE endpoint = ?', Date.now(), row.endpoint);
    } catch (err) {
      const failure = /** @type {any} */ (err) || {};
      // 404 / 410 is the push service saying this subscription no longer exists: the browser
      // unsubscribed, was uninstalled, or let it expire. It will never work again, so drop it.
      if (failure.statusCode === 404 || failure.statusCode === 410) {
        await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', row.endpoint).catch(() => {});
        return;
      }
      // Anything else (a timeout, a 5xx, a 429) may be temporary, so the subscription stays. The
      // library puts the full endpoint on its errors; only the host and a status or code are printed.
      const reason = failure.statusCode ? `HTTP ${failure.statusCode}` : (failure.code || failure.name || 'error');
      log.warn(`[push] send to ${hostOf(row.endpoint)} failed: ${reason}`);
    }
  }

  /** @param {string[]} usernames @param {PushPayload} payload */
  async function deliver(usernames, payload) {
    if (!send) return;
    const targets = [...new Set(usernames)].filter((name) => name && !isFocused(name));
    if (targets.length === 0) return;
    const rows = await db.all(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE username IN (${targets.map(() => '?').join(', ')})`,
      ...targets
    );
    if (rows.length === 0) return;
    const options = {
      TTL: PUSH_TTL_SECONDS,
      // A chat message is the reason someone picks their phone up; 'high' is what gets it past a
      // dozing device now instead of at the next maintenance window.
      urgency: 'high',
      // While a device is offline the push service keeps only the newest message per topic, so it
      // wakes up to one notification per conversation instead of a burst. Topics are limited to 32
      // url-safe characters, hence the digest of the tag.
      topic: crypto.createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32),
    };
    const body = JSON.stringify(payload);
    await Promise.all(rows.map((row) => sendOne(row, body, options)));
  }

  /**
   * Push `payload` to every browser of each user who is not currently looking at the app. Always
   * resolves: by the time this runs the message is stored and emitted, and nothing that goes wrong
   * here may reach the request or socket handler that called it.
   * @param {string[]} usernames @param {PushPayload} payload
   * @returns {Promise<void>}
   */
  function notify(usernames, payload) {
    return Promise.resolve()
      .then(() => deliver(usernames, payload))
      .catch((err) => { log.warn('[push] delivery failed:', (err && (err.code || err.name)) || 'error'); });
  }

  // --- What each kind of event says ---
  // Titles and tags deliberately match the in-page notifications (maybeNotify in client/src/App.jsx).
  // A tab that is open but in the background raises its own; with the same tag the two collapse into
  // one instead of stacking. `url` is what the service worker opens on a click; the client reads
  // ?open= and goes to that conversation.

  /** @param {{ from: string, fromUserId: number | string, to: string, text?: string, attachment?: Attachment }} dm */
  function notifyDirectMessage({ from, fromUserId, to, text, attachment }) {
    if (!to || to === from) return Promise.resolve();
    return notify([to], {
      title: `💬 ${from}`,
      body: bodyAlone(previewOf(text, attachment)),
      tag: `lanparty-dm-dm-${from}`,
      // The id as well as the name: a DM from someone who is not a friend (a server co-member) is in
      // no list the client could look the name up in, and the id is what its chat is keyed by.
      url: `/app/?open=dm/${encodeURIComponent(String(fromUserId))}/${encodeURIComponent(from)}`,
    });
  }

  /** @param {{ groupId: string, groupName?: string, from: string, to: string[], text?: string, attachment?: Attachment }} message */
  function notifyGroupMessage({ groupId, groupName, from, to, text, attachment }) {
    return notify(to.filter((name) => name !== from), {
      title: `👥 ${clip(groupName || '') || 'Group chat'}`,
      body: bodyFrom(from, previewOf(text, attachment)),
      tag: `lanparty-group-${groupId}`,
      url: `/app/?open=group/${encodeURIComponent(groupId)}`,
    });
  }

  /** @param {{ serverId: string, channelId: string, serverName?: string, channelName?: string, from: string, to: string[], text?: string, attachment?: Attachment }} mention */
  function notifyMention({ serverId, channelId, serverName, channelName, from, to, text, attachment }) {
    return notify(to.filter((name) => name !== from), {
      title: `🔔 ${channelName || 'channel'} · ${serverName || 'LAN Party'}`,
      body: bodyFrom(from, previewOf(text, attachment)),
      tag: `lanparty-channel-${serverId}-${channelId}`,
      url: `/app/?open=channel/${encodeURIComponent(serverId)}/${encodeURIComponent(channelId)}`,
    });
  }

  /** @param {{ from: string, to: string }} request */
  function notifyFriendRequest({ from, to }) {
    if (!to || to === from) return Promise.resolve();
    return notify([to], {
      title: '👋 Friend request',
      body: `${from} wants to be friends`,
      tag: `lanparty-friend-${from}`,
      url: '/app/?open=requests',
    });
  }

  /** Is this username still an account? @param {string} username */
  async function accountExists(username) {
    return !!(await db.get('SELECT 1 FROM users WHERE username = ?', username));
  }

  // Mention pushes per sender. A push is the one thing here that reaches a closed app and a lock
  // screen, and the socket 'message' handler has no flood control of its own, so without a ceiling a
  // single account could buzz twenty people per message as fast as it could send. Over the limit the
  // messages still deliver and still raise unread badges; they just stop ringing phones.
  /** @type {Map<string, number[]>} */
  const mentionTimes = new Map();
  /** @param {string} sender @param {number} [now] @returns {boolean} true if this mention may push */
  function allowMentionPush(sender, now = Date.now()) {
    const recent = (mentionTimes.get(sender) || []).filter((t) => now - t < MENTION_WINDOW_MS);
    if (recent.length >= MENTION_PUSHES_PER_WINDOW) { mentionTimes.set(sender, recent); return false; }
    recent.push(now);
    mentionTimes.set(sender, recent);
    if (mentionTimes.size > 5000) mentionTimes.clear(); // a bound, not a cache worth tuning
    return true;
  }

  return {
    available, publicKey, subscribe, unsubscribe, accountExists, allowMentionPush,
    setFocus, dropSocket, isFocused,
    notify, notifyDirectMessage, notifyGroupMessage, notifyMention, notifyFriendRequest,
  };
}

module.exports = {
  createPush, loadWebPush, previewOf, mentionedUsernames, vapidSubjectFor, isVapidPair, generateVapidKeys,
  MAX_SUBSCRIPTIONS_PER_USER, MAX_MENTION_TARGETS, BODY_MAX, MENTION_PUSHES_PER_WINDOW,
};
