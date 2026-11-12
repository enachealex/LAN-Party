// Stands in for the `web-push` library inside a test server (helpers.startServer with
// WEB_PUSH_MODULE pointing here), so the real routes and triggers run end to end and nothing is ever
// sent to a push service.
//
// Every send is appended to DATA_DIR/push-sent.jsonl, which is how a test — a different process —
// sees exactly who was pushed and with what. The outcome is chosen by the endpoint's path, so one
// test can mix a working browser with a dead one:
//   /gone/…     rejects with 410, as a push service does for an expired subscription
//   /missing/…  rejects with 404
//   /busy/…     rejects with 500
//   /throw/…    throws synchronously, like a bug in the library
//   anything else is accepted
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.DATA_DIR || '.', 'push-sent.jsonl');

function failure(statusCode, endpoint) {
  // Shaped like web-push's WebPushError, which carries the full endpoint: the server must not log it.
  return Object.assign(new Error('Received unexpected response code'), { name: 'WebPushError', statusCode, endpoint });
}

function sendNotification(subscription, payload, options = {}) {
  // Deliberately leaves the VAPID details out of the record, apart from the public subject: the
  // private key has no business in a log, not even a test's.
  fs.appendFileSync(LOG, `${JSON.stringify({
    endpoint: subscription.endpoint,
    keys: subscription.keys,
    payload: JSON.parse(payload),
    ttl: options.TTL,
    urgency: options.urgency,
    topic: options.topic,
    subject: options.vapidDetails && options.vapidDetails.subject,
  })}\n`);
  const where = new URL(subscription.endpoint).pathname;
  if (where.startsWith('/throw/')) throw new Error('simulated sender bug');
  if (where.startsWith('/gone/')) return Promise.reject(failure(410, subscription.endpoint));
  if (where.startsWith('/missing/')) return Promise.reject(failure(404, subscription.endpoint));
  if (where.startsWith('/busy/')) return Promise.reject(failure(500, subscription.endpoint));
  return Promise.resolve({ statusCode: 201, body: '', headers: {} });
}

module.exports = { sendNotification };
