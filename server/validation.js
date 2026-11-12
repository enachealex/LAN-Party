// @ts-check
// Request-shape validation for the API boundary. Schemas live here (rather than inline `String(x||'')`
// coercion in each route) so the accepted shape is declared in one place and stays in sync with the
// types. This file opts into type-checking via the `// @ts-check` comment above — run `npm run check`.
const net = require('net');
const { z } = require('zod');

const FEEDBACK_TYPES = /** @type {const} */ (['feedback', 'request', 'bug']);

// POST /feedback — a user-submitted report that gets stored and forwarded to Vaultline.
// `title` is truncated rather than rejected, matching the previous hand-rolled behaviour.
const feedbackInput = z.object({
  // Missing/blank falls back to 'feedback' and matching is case-insensitive, as before.
  type: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : 'feedback'),
    z.enum(FEEDBACK_TYPES)
  ),
  message: z.string().trim().min(1).max(8000),
  title: z.string().trim().transform((s) => s.slice(0, 160)).optional(),
  diagnostics: z.string().optional(),
});

// POST /servers/:serverId/invite — add a user to a server by username.
const inviteInput = z.object({
  username: z.string().trim().min(1),
});

// POST /servers/:serverId/invites — mint a shareable invite link. Both fields are optional, and null
// means "no limit" so the client can send its "never expires" choice explicitly. Numbers only: a
// string is rejected rather than coerced, so "7" can never be read as something the admin did not pick.
// The ceilings keep a typo from producing a limit that is unlimited in all but name.
const INVITE_MAX_HOURS = 24 * 30;
const INVITE_MAX_USES = 1000;
const inviteLinkInput = z.object({
  expiresInHours: z.number().int().min(1).max(INVITE_MAX_HOURS).nullish(),
  maxUses: z.number().int().min(1).max(INVITE_MAX_USES).nullish(),
});

// POST /push/subscribe — a browser's Web Push subscription (PushSubscription.toJSON()). The endpoint is
// a URL this server will later POST to, and it arrives from a client, so it is held to what a real
// push service looks like: https on the default port, a public hostname, no credentials. That is what
// stops a subscription being used to aim the server's own requests at a LAN address or a local port.
// Every real push service (FCM, Mozilla, Apple, WNS) fits; a URL that does not is not a subscription.
const INTERNAL_SUFFIXES = /\.(local|localhost|internal|lan|home|arpa|test|invalid)$/;
// …and beyond looking public, the host has to BE a push service. A textual check cannot know what a
// name resolves to: a public-looking hostname can point at a LAN or tailnet address, and any https
// host at all could be made a target the server POSTs to on demand. Browsers only ever hand out
// endpoints on these hosts, so anything else is not a subscription a browser produced.
// PUSH_EXTRA_HOSTS (comma-separated) adds hosts, for tests and for a self-hosted push relay.
const PUSH_SERVICE_HOSTS = /(^|\.)(fcm\.googleapis\.com|android\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
/** @param {string} host */
function isPushServiceHost(host) {
  if (PUSH_SERVICE_HOSTS.test(host)) return true;
  const extra = (process.env.PUSH_EXTRA_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return extra.includes(host);
}
/** @param {string} value */
function isPushEndpoint(value) {
  let url;
  try { url = new URL(value); } catch (_) { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, ''); // "localhost." is still localhost
  if (net.isIP(host) || host.startsWith('[')) return false; // an address, v4 or bracketed v6
  if (!host.includes('.') || INTERNAL_SUFFIXES.test(host)) return false; // a bare or network-local name
  return isPushServiceHost(host);
}
/**
 * A base64url string that decodes to exactly `bytes` bytes. The keys are fixed-size by definition (a
 * P-256 point and a 16-byte secret); one of any other size makes every later send throw, so it is
 * refused here, where the browser that sent it can still be told.
 * @param {number} bytes
 */
const base64urlOf = (bytes) => z.string().max(256).refine(
  (s) => /^[A-Za-z0-9_-]+=*$/.test(s) && Buffer.from(s, 'base64url').length === bytes
);
const pushEndpoint = z.string().max(2048).refine(isPushEndpoint);
const pushSubscribeInput = z.object({
  endpoint: pushEndpoint,
  keys: z.object({ p256dh: base64urlOf(65), auth: base64urlOf(16) }),
});
// POST /push/unsubscribe — only the endpoint: it is what identifies the browser.
const pushUnsubscribeInput = z.object({ endpoint: pushEndpoint });

// Map a Zod issue onto the exact error string the client already renders, so tightening validation
// never changes what a user sees. Keyed by field, with size checks distinguished by issue code.
/** @param {{ path: ReadonlyArray<string | number | symbol>, code?: string, message?: string }} issue */
function messageFor(issue) {
  const field = String(issue.path[0] ?? '');
  if (field === 'type') return 'Invalid feedback type';
  if (field === 'message') {
    return issue.code === 'too_big' ? 'Message is too long (max 8000 characters)' : 'Message is required';
  }
  if (field === 'username') return 'Username required';
  if (field === 'expiresInHours') return `Expiry must be a whole number of hours between 1 and ${INVITE_MAX_HOURS}`;
  if (field === 'maxUses') return `Max uses must be a whole number between 1 and ${INVITE_MAX_USES}`;
  if (field === 'endpoint') return 'A push subscription needs the https endpoint of a push service';
  if (field === 'keys') return 'A push subscription needs its p256dh and auth keys';
  return issue.message || 'Invalid request';
}

/**
 * Validate `data` against `schema`, returning parsed (and coerced) data or a client-safe message.
 * @template T
 * @param {{ safeParse: (d: unknown) => { success: true, data: T } | { success: false, error: { issues: any[] } } }} schema
 * @param {unknown} data
 * @returns {{ ok: true, data: T } | { ok: false, error: string }}
 */
function validate(schema, data) {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: issue ? messageFor(issue) : 'Invalid request' };
}

module.exports = { feedbackInput, inviteInput, inviteLinkInput, pushSubscribeInput, pushUnsubscribeInput, validate, FEEDBACK_TYPES, INVITE_MAX_HOURS, INVITE_MAX_USES };
