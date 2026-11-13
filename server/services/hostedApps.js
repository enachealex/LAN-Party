// @ts-check
// Hosted apps: a link app with "Run inside LAN Party" on. Unlike an uploaded bundle, a hosted app is
// a site on its own server, and it runs in a frame on its REAL origin: it needs its own cookies and
// storage, so its frame is given allow-same-origin next to allow-scripts.
//
// That pair is safe for exactly one reason: the frame's origin is not LAN Party's. A frame that is
// same-origin with the page around it and has both flags can reach up, remove its own sandbox and
// read the session. So the one rule that carries the weight here is that a hosted app's address is
// never one of the addresses LAN Party itself is served from. The client refuses to frame its own
// origin as well; this is the server's half, asked when the address is saved, when the app is
// published and when it is started in a room.
//
// Also here: the room key, the opaque id an app is given for "this voice channel".

const crypto = require('crypto');

const HOSTED_URL_MAX = 2000;
// Plain http is for developing an app on the same machine and nothing else, and only while LAN Party
// itself is being run on that machine (servedFromLoopback). On a real instance an http://localhost
// address would frame whatever each VIEWER happens to run on their own computer.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);
// The names LAN Party itself may be reached by for that to apply. [::1] counts here: it is where the
// page is, not an address being typed in for an app.
const LOOPBACK_SERVER_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A link app that runs inside LAN Party. `kind` is as the queries select it: COALESCE(kind, 'link'). */
const isHostedApp = (/** @type {any} */ row) => !!row && row.kind === 'link' && !!row.embed;

// "example.com." is the same machine as "example.com", so a trailing dot must not be a way around
// the comparison. (URL has already lower-cased the name and decoded any other spelling of it.)
const bareHost = (/** @type {string} */ hostname) => hostname.replace(/\.+$/, '');
// 80 and 443 count as one "default" port, whatever the scheme. Behind a proxy the server cannot be
// sure which scheme the browser used, and guessing wrong must make the check stricter, not blind.
const barePort = (/** @type {string} */ port) => (port === '80' || port === '443' ? '' : port);

/**
 * "host:port" as the own-address comparison sees it, or null for something that names no host.
 * @param {string} address an absolute url
 */
function hostKey(address) {
  try {
    const u = new URL(address);
    const host = bareHost(u.hostname);
    return host ? `${host}:${barePort(u.port)}` : null;
  } catch (_) {
    return null;
  }
}

/**
 * Every address this LAN Party is known to answer at, from where one request (or socket handshake)
 * stands: the host it was sent to, the host a proxy says it was sent to, the page that sent it, and
 * the CLIENT_ORIGIN list. More entries only ever refuse more, so a header the sender controls can
 * narrow what they may register and never widen it.
 * @param {Record<string, any> | undefined} headers lower-cased, as Node hands them over
 * @param {string[]} [configuredOrigins] the CLIENT_ORIGIN values ('*' already left out)
 * @returns {Set<string>}
 */
function ownHostKeys(headers, configuredOrigins = []) {
  /** @type {Set<string>} */
  const keys = new Set();
  const add = (/** @type {string | null} */ key) => { if (key) keys.add(key); };
  const h = headers || {};
  for (const name of ['host', 'x-forwarded-host']) {
    for (const value of String(h[name] || '').split(',')) if (value.trim()) add(hostKey(`http://${value.trim()}`));
  }
  if (h.origin) add(hostKey(String(h.origin)));
  // A configured entry is an origin, but a bare "host:port" is an easy thing to write there.
  for (const origin of configuredOrigins) add(hostKey(String(origin).trim()) || hostKey(`http://${String(origin).trim()}`));
  return keys;
}

/**
 * Whether LAN Party is, as far as this request can tell, being run on the machine of the person
 * using it: every name the request says it was sent to (Host, X-Forwarded-Host, and the Origin of the
 * page that sent it) is a loopback one. That is the one situation an http://localhost app address
 * makes sense in. All of them, not any: a proxy in front of a real instance commonly talks to it as
 * 127.0.0.1, and the public name it was really reached by is then in one of the others.
 * @param {Record<string, any> | undefined} headers lower-cased, as Node hands them over
 */
function servedFromLoopback(headers) {
  const h = headers || {};
  /** @type {string[]} */
  const names = [];
  for (const name of ['host', 'x-forwarded-host']) {
    for (const value of String(h[name] || '').split(',')) if (value.trim()) names.push(`http://${value.trim()}`);
  }
  if (h.origin) names.push(String(h.origin));
  if (!names.length) return false;
  return names.every((address) => {
    try { return LOOPBACK_SERVER_HOSTS.has(new URL(address).hostname); } catch (_) { return false; }
  });
}

/**
 * Whether `raw` may be the address of a hosted app. The answer carries the address as it is to be
 * STORED: the parser's own spelling of it, so that what the reviewer reads, what the client frames
 * and what was checked here are one string with one meaning.
 * @param {unknown} raw
 * @param {Set<string>} ownKeys from ownHostKeys()
 * @param {{ loopback?: boolean }} [where] `loopback`: LAN Party is being served from this machine
 *   (servedFromLoopback), the only time a plain http://localhost or http://127.0.0.1 app is allowed
 * @returns {{ ok: true, url: string, origin: string } | { ok: false, problem: string }}
 */
function checkHostedUrl(raw, ownKeys, where = {}) {
  const no = (/** @type {string} */ problem) => ({ ok: /** @type {const} */ (false), problem });
  const needsHttps = 'An app that runs inside LAN Party needs a full https:// address';
  if (typeof raw !== 'string') return no(needsHttps);
  const text = raw.trim();
  if (!text || text.length > HOSTED_URL_MAX) return no(needsHttps);
  // The URL parser is forgiving in ways a reviewer's eye is not: it drops tabs and newlines, reads
  // "\" as "/" and accepts "https:host" and "https:///host". None of that is something a real
  // address needs, so the scheme, the two slashes and the start of a host have to be there as typed.
  if (/[\s\\\u0000-\u001f\u007f]/.test(text) || !/^https?:\/\/[^/?#]/i.test(text)) return no(needsHttps);
  let u;
  try { u = new URL(text); } catch (_) { return no(needsHttps); }
  const host = bareHost(u.hostname);
  if (!host) return no(needsHttps);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && where.loopback === true && LOOPBACK_HOSTS.has(host))) return no(needsHttps);
  // Credentials in an address end up in history, logs and the Referer of whatever the page loads.
  if (u.username || u.password) return no('The address of an app cannot contain a username or password');
  if (ownKeys.has(`${host}:${barePort(u.port)}`)) {
    return no('An app cannot run inside LAN Party from LAN Party\'s own address. Host it on a different origin, or upload it as a bundle.');
  }
  return { ok: true, url: u.href, origin: u.origin };
}

/**
 * The room key: what an app is told instead of "which voice channel is this". Stable for one app in
 * one channel, so the app can keep something per channel (a queue, a scoreboard) on its own server;
 * different for every app, so two apps cannot compare notes about who shares a channel; and an HMAC,
 * so it says nothing about the server or channel ids and cannot be worked out for a channel one is
 * not in.
 *
 * The key is derived from a secret the server already has, under a label of its own, rather than
 * kept in a file of its own: there is nothing new to back up or to lose. It follows that changing
 * that secret changes every room key, and whatever an app stored under the old ones is orphaned.
 *
 * The key is also bound to the SITE it is handed to (appFrameOrigin): a hosted app's origin, or
 * 'bundle'. A room key is a bearer value an app's backend may trust ("everyone with this key is in
 * the same voice channel"), so an app whose address is moved to another origin must not carry its
 * old keys there; the new site gets keys of its own. It follows that moving a hosted app to a new
 * origin rotates all of its room keys. A change of path or query on the same origin does not.
 * @param {string} baseSecret
 * @returns {(appId: number, frameOrigin: string, serverId: string, channelId: string) => string}
 *   32 lower-case hex characters
 */
function createAppRoomKeys(baseSecret) {
  const key = deriveKey(baseSecret, 'lanparty:app-room-key:v1');
  // JSON, so that no app id, origin and channel can run together into another set's bytes.
  return (appId, frameOrigin, serverId, channelId) => crypto.createHmac('sha256', key)
    .update(JSON.stringify([appId, String(frameOrigin), String(serverId), String(channelId)]))
    .digest('hex').slice(0, 32);
}

/**
 * The site an app's frame is on, as the room key is bound to it: a hosted app's origin, or 'bundle'
 * for an uploaded one (which runs in an opaque origin that has no name to bind to). null for a row
 * that is neither, which runs in no room.
 * @param {any} row with kind, bundle_dir, url and embed
 */
function appFrameOrigin(row) {
  if (!row) return null;
  if (row.kind === 'bundle' && row.bundle_dir) return 'bundle';
  if (!isHostedApp(row)) return null;
  try { return new URL(String(row.url)).origin; } catch (_) { return null; }
}

/**
 * A key of its own for one purpose, derived from a secret the server already has. HMAC under a fixed
 * label: nothing learned from one derived key (or from what it signs) helps with the base secret, a
 * session token, or a key derived under any other label.
 * @param {string} baseSecret
 * @param {string} label
 * @returns {Buffer}
 */
function deriveKey(baseSecret, label) {
  return crypto.createHmac('sha256', String(baseSecret)).update(label).digest();
}

module.exports = { HOSTED_URL_MAX, isHostedApp, ownHostKeys, servedFromLoopback, checkHostedUrl, createAppRoomKeys, appFrameOrigin, deriveKey };
