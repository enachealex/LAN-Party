// @ts-check
// Credentials for the TURN relay (coturn), in the shared-secret scheme coturn calls use-auth-secret
// ("TURN REST API"): the username is "<expiry unix seconds>:<who>" and the password is
// base64(HMAC-SHA1(secret, username)). coturn holds the same secret and checks both, so nothing has to
// be stored per user and every credential stops working on its own when it expires.
//
// Why not a fixed username and password: those were handed to anyone who asked /webrtc/ice, signed in
// or not, and a relay is bandwidth on the home connection. Now only a signed-in person gets one, it is
// theirs (their name is in it, so the relay's logs say who), and it lasts a day.
//
// Config (env):
//   TURN_URLS          comma-separated, e.g. "turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp"
//   TURN_SECRET        the static-auth-secret coturn is configured with (never sent to anyone)
//   TURN_TTL_SECONDS   how long a credential lasts (default 86400, at least 600)
//   TURN_USERNAME / TURN_CREDENTIAL   the older fixed-credential setup, used only when TURN_SECRET is not set
const crypto = require('crypto');

const DEFAULT_TTL = 24 * 60 * 60;

/** @param {NodeJS.ProcessEnv} env */
function turnUrls(env) {
  return String(env.TURN_URLS || '').split(',').map((s) => s.trim()).filter((s) => /^turns?:/i.test(s));
}

/** @param {NodeJS.ProcessEnv} env */
function ttlSeconds(env) {
  const n = Number(env.TURN_TTL_SECONDS);
  return Number.isFinite(n) && n >= 600 ? Math.floor(n) : DEFAULT_TTL;
}

/**
 * The TURN entry for one signed-in person, or null when no relay is set up.
 * @param {string} username who it is for (from their session, never from the request)
 * @param {{ env?: NodeJS.ProcessEnv, now?: () => number }} [opts]
 * @returns {{ urls: string[], username: string, credential: string, expiresAt?: number } | null}
 */
function turnServerFor(username, { env = process.env, now = Date.now } = {}) {
  const urls = turnUrls(env);
  if (!urls.length) return null;
  const secret = env.TURN_SECRET;
  if (secret) {
    const expiresAt = Math.floor(now() / 1000) + ttlSeconds(env);
    // A colon would split the username in two for coturn; nothing else in a LAN Party name matters.
    const user = `${expiresAt}:${String(username).replace(/:/g, '_')}`;
    const credential = crypto.createHmac('sha1', secret).update(user).digest('base64');
    return { urls, username: user, credential, expiresAt };
  }
  if (env.TURN_USERNAME && env.TURN_CREDENTIAL) return { urls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL };
  return null;
}

/** @param {NodeJS.ProcessEnv} [env] */
function turnConfigured(env = process.env) {
  return turnUrls(env).length > 0 && !!(env.TURN_SECRET || (env.TURN_USERNAME && env.TURN_CREDENTIAL));
}

module.exports = { turnServerFor, turnConfigured, turnUrls, DEFAULT_TTL };
