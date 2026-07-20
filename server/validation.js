// @ts-check
// Request-shape validation for the API boundary. Schemas live here (rather than inline `String(x||'')`
// coercion in each route) so the accepted shape is declared in one place and stays in sync with the
// types. This file opts into type-checking via the `// @ts-check` comment above — run `npm run check`.
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

module.exports = { feedbackInput, inviteInput, validate, FEEDBACK_TYPES };
