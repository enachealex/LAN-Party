// @ts-check
// Time-based one-time passwords (RFC 6238) on top of HOTP (RFC 4226), and the base32 (RFC 4648)
// that authenticator apps exchange secrets in. Nothing here knows about accounts or the database:
// it is arithmetic over a secret and a clock, tested against the RFCs' own published vectors
// (test/totp.test.js). node:crypto only — the box does not reinstall node_modules on deploy.

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Seconds one code is valid for. What every authenticator app assumes. */
const STEP_SECONDS = 30;
const DIGITS = 6;
/** 160 bits: the size RFC 4226 recommends, and the HMAC-SHA1 block the apps expect. */
const SECRET_BYTES = 20;

/**
 * @param {Buffer} buf
 * @returns {string} unpadded upper-case base32
 */
function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Lenient about what people paste (case, spaces, dashes, padding), strict about everything else.
 * @param {string} text
 * @returns {Buffer | null} null when a character is not base32
 */
function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/**
 * RFC 4226 §5.3: HMAC over the 8-byte big-endian counter, dynamic truncation, last `digits` digits.
 * @param {Buffer} secret
 * @param {number} counter a non-negative integer
 * @param {{ digits?: number, algorithm?: string }} [opts]
 * @returns {string} zero-padded
 */
function hotp(secret, counter, { digits = DIGITS, algorithm = 'sha1' } = {}) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac(algorithm, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** @param {number} [nowMs] @returns {number} the time-step this instant falls in */
const stepAt = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * @param {Buffer} secret
 * @param {number} [nowMs]
 * @returns {string} the code for that instant
 */
const totp = (secret, nowMs = Date.now()) => hotp(secret, stepAt(nowMs));

/** Compares two codes without the comparison's duration saying how many digits matched. */
function sameCode(/** @type {string} */ a, /** @type {string} */ b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Which time-step, if any, this code belongs to: the current one or `window` either side of it (a
 * phone's clock is rarely exact). The caller needs the step, not just yes/no — it is what stops a
 * code being used twice.
 * @param {Buffer} secret
 * @param {string} code
 * @param {{ nowMs?: number, window?: number }} [opts]
 * @returns {number | null}
 */
function matchingStep(secret, code, { nowMs = Date.now(), window = 1 } = {}) {
  const given = String(code || '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = stepAt(nowMs);
  let found = null;
  // Every candidate is computed and compared, whichever one matches.
  for (let delta = -window; delta <= window; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    if (sameCode(hotp(secret, step), given) && found === null) found = step;
  }
  return found;
}

/** @returns {Buffer} a fresh random secret */
const newSecret = () => crypto.randomBytes(SECRET_BYTES);

/**
 * The address an authenticator app reads from a QR code (the "Key Uri Format").
 * @param {{ secretBase32: string, account: string, issuer: string }} p
 */
function otpauthUri({ secretBase32, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = `secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
  return `otpauth://totp/${label}?${query}`;
}

module.exports = { base32Encode, base32Decode, hotp, totp, stepAt, matchingStep, newSecret, otpauthUri, STEP_SECONDS, DIGITS, SECRET_BYTES };
