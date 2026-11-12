// Web Push subscription endpoints: the browser side of services/push.js. A client that has the
// notification toggle on asks for the server's public key, subscribes with its push service, and
// hands the result back here; turning the toggle off, or signing out, takes it away again.
//
// Rules:
// - All three need a login. A subscription is always the caller's own: nothing here accepts a
//   username.
// - When push cannot work on this server (the web-push module is not installed, or there are no
//   usable keys) every route says so instead of failing: GET answers { available: false } and
//   subscribing is refused with a 503. The client keeps its in-page notifications and shows no error.
// - Unsubscribing still removes the row even then. It only ever deletes the caller's own data, and
//   it is what sign-out relies on to stop the next person on a shared device inheriting notifications.
const { rateLimit } = require('../rateLimit');

// Per caller address, and a whole LAN party shares one behind the venue's router. Every page load of
// a client with notifications on makes one key request and one subscribe, so these are sized for a
// room full of people reloading at once; they exist to stop a single client looping, not to meter
// normal use.
const KEY_LIMIT = { id: 'push-key', windowMs: 5 * 60_000, max: 300 };
const SUBSCRIBE_LIMIT = { id: 'push-subscribe', windowMs: 5 * 60_000, max: 150 };
const UNSUBSCRIBE_LIMIT = { id: 'push-unsubscribe', windowMs: 5 * 60_000, max: 150 };

const UNAVAILABLE = 'Push notifications are not available on this server';

/** @param {Record<string, any>} deps */
function registerPushRoutes({ app, authMiddleware, push, validate, pushSubscribeInput, pushUnsubscribeInput }) {
  // The VAPID public key a browser must subscribe with. Public by nature (it ends up in every
  // subscription); behind a login only because nobody without one has a use for it.
  app.get('/push/public-key', rateLimit(KEY_LIMIT), authMiddleware, (req, res) => {
    if (!push.available()) return res.json({ available: false, publicKey: null });
    return res.json({ available: true, publicKey: push.publicKey() });
  });

  // Register this browser for the caller. Safe to repeat: the client re-sends its subscription on
  // every login, which is also how a browser that changed hands moves to its new user.
  app.post('/push/subscribe', rateLimit(SUBSCRIBE_LIMIT), authMiddleware, async (req, res) => {
    if (!push.available()) return res.status(503).json({ available: false, error: UNAVAILABLE });
    const parsed = validate(pushSubscribeInput, req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    // A token outlives its account (rename, deletion) until it expires. A row stored under a freed
    // username would deliver the NEXT owner of that name's messages to this old device.
    if (!(await push.accountExists(req.user.username))) return res.status(401).json({ error: 'Account not found' });
    await push.subscribe(req.user.username, parsed.data, req.headers['user-agent']);
    return res.json({ success: true });
  });

  app.post('/push/unsubscribe', rateLimit(UNSUBSCRIBE_LIMIT), authMiddleware, async (req, res) => {
    const parsed = validate(pushUnsubscribeInput, req.body);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    const removed = await push.unsubscribe(req.user.username, parsed.data.endpoint);
    // Idempotent: "already gone" is the state the caller asked for.
    return res.json({ success: true, removed, available: push.available() });
  });
}

module.exports = { registerPushRoutes };
