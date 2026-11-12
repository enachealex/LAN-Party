// v3: navigations used to be cached under their full URL, query string included. Bumping the name
// makes `activate` delete those entries, which could hold an invite code.
const CACHE_NAME = 'lan-party-cache-v3';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : undefined))))
  );
  self.clients.claim();
});

// Network-first for page navigations so a redeploy shows up on the next load — the cached copy is
// only an offline fallback. Everything else (API, sockets, media) goes straight to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.mode !== 'navigate') return;
  event.respondWith(
    fetch(req)
      .then((resp) => {
        // Stored under ONE fixed key, never the request URL. The shell is the same document whatever
        // the query string, and an invite arrives as /app/?invite=CODE: keyed by URL, that code would
        // sit in Cache Storage for anyone else on this browser profile to read, and every distinct
        // link would add another copy of the shell that nothing ever evicts.
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(self.registration.scope, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(self.registration.scope))
  );
});

// ---- Web Push: notifications while the app is closed ----
// The server sends { title, body, tag, url } (server/services/push.js) to people who have no focused
// window. This worker is the only part of the app guaranteed to be running then.

// Where a notification should take you, as a url inside THIS worker's scope. The server writes the
// path as /app/?open=…, but the app is not always mounted at /app/ (the dev server, another host), so
// only the query is taken from the payload and it is applied to wherever this worker actually lives.
// That also means a payload can never send a click to another site.
function targetUrl(raw) {
  const target = new URL(self.registration.scope);
  try {
    if (raw) target.search = new URL(raw, self.registration.scope).search;
  } catch (_) { /* not a url: open the app itself */ }
  return target.href;
}

self.addEventListener('push', (event) => {
  // Anything that is not our JSON object still gets a (generic) notification: browsers penalise a
  // push that shows nothing, eventually by revoking the subscription.
  let data = {};
  try {
    const parsed = event.data ? event.data.json() : null;
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch (_) { /* fall through with the defaults */ }
  const title = typeof data.title === 'string' && data.title ? data.title : 'LAN Party';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      icon: new URL('icons/logo-192.png', self.registration.scope).href,
      // One notification per conversation: a newer message replaces the older one under the same
      // tag instead of stacking up, and renotify makes the replacement alert again — otherwise the
      // second message in a conversation would arrive in silence.
      tag: typeof data.tag === 'string' && data.tag ? data.tag : 'lanparty',
      renotify: true,
      data: { url: targetUrl(data.url) },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.filter((c) => c.url.startsWith(self.registration.scope));
    // Prefer a window that is already visible; any app window beats opening a second copy.
    const existing = open.find((c) => c.visibilityState === 'visible') || open[0];
    if (existing) {
      // Tell the running app where to go rather than navigating it: a reload would drop a voice call.
      existing.postMessage({ type: 'lanparty:open', url });
      try { await existing.focus(); } catch (_) { /* focus can be refused; the message still landed */ }
      return;
    }
    await self.clients.openWindow(url);
  })());
});
