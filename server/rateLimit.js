// Minimal fixed-window rate limiter.
//
// Deliberately dependency-free: the SBC does not reinstall node_modules on deploy, so adding a package
// means an extra ordered install step before every restart. For a self-hosted app with a handful of
// users an in-memory counter is proportionate — it is NOT a defence against a distributed attacker,
// it exists to stop password guessing and to keep one client from monopolising an expensive route.
//
// State is per-process. There is only ever one pm2 instance of this app, so that is sufficient; it
// would need Redis (or pm2 in fork-per-core mode) to survive clustering.

const buckets = new Map(); // `${key}:${routeId}` -> { count, resetAt }

// Bound the map so a flood of unique IPs can't grow it without limit.
const MAX_TRACKED = 10_000;

function sweep(now) {
  if (buckets.size < MAX_TRACKED) return;
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  // Still oversized (all windows live) — drop the oldest-resetting entries.
  if (buckets.size >= MAX_TRACKED) {
    const sorted = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (let i = 0; i < Math.ceil(sorted.length / 4); i++) buckets.delete(sorted[i][0]);
  }
}

/**
 * Identify the caller. Behind the Cloudflare tunnel every request arrives from localhost, so the
 * forwarded header is the only thing that distinguishes clients. It is client-controllable, which is
 * why this is a courtesy limit rather than a security boundary.
 */
function callerKey(req) {
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '';
  const first = String(fwd).split(',')[0].trim();
  return first || req.ip || req.socket?.remoteAddress || 'unknown';
}

/**
 * @param {{ id: string, windowMs: number, max: number, message?: string }} opts
 * @returns {(req: any, res: any, next: Function) => void} express middleware
 */
function rateLimit({ id, windowMs, max, message }) {
  return function limiter(req, res, next) {
    const now = Date.now();
    const key = `${callerKey(req)}:${id}`;
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      sweep(now);
      buckets.set(key, b);
    }
    b.count += 1;
    const remaining = Math.max(0, max - b.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    if (b.count > max) {
      const retry = Math.ceil((b.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: message || 'Too many requests — try again shortly.', retryAfter: retry });
    }
    return next();
  };
}

/** Test seam: forget all counters. */
function resetRateLimits() { buckets.clear(); }

module.exports = { rateLimit, resetRateLimits };
