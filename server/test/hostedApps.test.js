// Hosted apps: a link app set to "Run inside LAN Party". It is someone else's site, framed on its
// own origin with allow-same-origin — which is safe only while that origin is not LAN Party's. So
// most of this file is about which addresses are REFUSED, and about a change to the address (or to
// the setting) never being published, or left running, on the strength of an earlier review.
//
// Also here: the room key, the opaque id an app is given for the voice channel it runs in.
//
// Layers: the checks on their own, the migration, then the real server over HTTP and sockets.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { io } = require('socket.io-client');
const { strToU8 } = require('fflate');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');
const { migrate, MIGRATIONS } = require('../db/schema');
const { runMigrations } = require('../db/migrate');
const { isHostedApp, ownHostKeys, servedFromLoopback, checkHostedUrl, createAppRoomKeys, appFrameOrigin } = require('../services/hostedApps');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
const STATUSES = ['draft', 'pending', 'published', 'rejected'];

// Addresses no hosted app may have, wherever LAN Party is served from. Used against the function
// and against the routes, so the two cannot drift apart.
const NEVER = {
  'http, and not this machine': [
    'http://music.example.test/',
    'http://192.168.0.10:8080/',
    'http://[::1]:8080/',
    'http://localhost.example.test/',
    'http://notlocalhost/',
  ],
  'credentials in the address': [
    'https://user:pw@music.example.test/',
    'https://user@music.example.test/',
    'https://:pw@music.example.test/',
    'http://user:pw@localhost:5173/',
  ],
  'not an address at all': [
    '',
    '   ',
    'not a url',
    'music.example.test',
    'music.example.test/app',
    'https://',
    'https:///music.example.test/',
    'https://exa mple.test/',
    'https://music.exa\nmple.test/',
    'htt\tps://music.example.test/',
    'https://[not-an-ip]/',
    'https://music.example.test:99999/',
    'https://' + 'a'.repeat(2100) + '.example.test/',
  ],
  'a scheme that is not https': [
    'javascript:alert(1)',
    'JavaScript://music.example.test/%0Aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'blob:https://music.example.test/2f1c8b8e-0000-4000-8000-000000000000',
    'file:///etc/passwd',
    'ftp://music.example.test/',
    'wss://music.example.test/',
    'view-source:https://music.example.test/',
    'about:blank',
    '//music.example.test/',
    'https:music.example.test',
    'https:/music.example.test',
    'https:\\\\music.example.test\\',
    'https://music.example.test\\@lanparty.example.test/',
  ],
};
const NOT_STRINGS = [undefined, null, 7, true, {}, ['https://music.example.test/'], { href: 'https://music.example.test/' }];

// ---------------------------------------------------------------------------------------------
describe('hosted app addresses (services/hostedApps.js)', () => {
  // LAN Party as one request sees it: reached at lanparty.example.test, nothing configured.
  const own = ownHostKeys({ host: 'lanparty.example.test' }, []);
  const check = (url, keys = own, where = undefined) => checkHostedUrl(url, keys, where);
  // LAN Party being run on the developer's own machine: the only place plain http is allowed.
  const LOCAL = { loopback: true };

  test('an https address is accepted, and comes back as the parser spells it', () => {
    const spelled = {
      'https://music.example.test': 'https://music.example.test/',
      'https://music.example.test/': 'https://music.example.test/',
      '  https://music.example.test/room  ': 'https://music.example.test/room',
      'HTTPS://Music.Example.TEST:443/Room?x=1&y=2#top': 'https://music.example.test/Room?x=1&y=2#top',
      'https://music.example.test:8443/a/../b': 'https://music.example.test:8443/b',
      // A name that only resembles ours is somebody else's.
      'https://lanparty.example.test.evil.example/': 'https://lanparty.example.test.evil.example/',
      'https://notlanparty.example.test/': 'https://notlanparty.example.test/',
      'https://lanparty.example.test:8443/': 'https://lanparty.example.test:8443/',
    };
    for (const [typed, stored] of Object.entries(spelled)) {
      const out = check(typed);
      assert.equal(out.ok, true, typed);
      assert.equal(out.url, stored, typed);
      assert.equal(out.origin, new URL(stored).origin);
      // What is stored passes again unchanged, so re-checking a saved address never moves it.
      assert.deepEqual(check(stored), out, stored);
    }
  });

  test('plain http is for an app on this machine, and only while LAN Party is on this machine too', () => {
    const local = ownHostKeys({ host: 'localhost:3000' }, []);
    const loopbackOnly = ['http://localhost:5173/', 'http://127.0.0.1:5173/app', 'http://localhost/', 'http://LOCALHOST:5173', 'http://127.1:5173/'];
    for (const ok of loopbackOnly) {
      assert.equal(check(ok, local, LOCAL).ok, true, ok);
    }
    assert.equal(check('http://127.1:5173/', local, LOCAL).url, 'http://127.0.0.1:5173/', 'the stored address says which machine it really is');
    // A real instance: every viewer's "localhost" is their own computer, so it is refused there.
    for (const where of [undefined, {}, { loopback: false }, { loopback: 'yes' }]) {
      for (const bad of loopbackOnly) {
        assert.deepEqual(check(bad, own, where), { ok: false, problem: 'An app that runs inside LAN Party needs a full https:// address' }, `${bad} ${JSON.stringify(where)}`);
      }
    }
    for (const bad of NEVER['http, and not this machine']) {
      for (const where of [undefined, LOCAL]) {
        assert.deepEqual(check(bad, own, where), { ok: false, problem: 'An app that runs inside LAN Party needs a full https:// address' }, bad);
      }
    }
  });

  test('"served from loopback" is every name the request was sent to being a loopback one', () => {
    for (const headers of [
      { host: 'localhost:3000' },
      { host: '127.0.0.1:3000' },
      { host: '[::1]:3000' },
      { host: 'LOCALHOST' },
      { host: '127.0.0.1:3000', origin: 'http://localhost:5173' },
      { host: 'localhost:3000', 'x-forwarded-host': '127.0.0.1:8080', origin: 'http://[::1]:5173' },
    ]) assert.equal(servedFromLoopback(headers), true, JSON.stringify(headers));
    for (const headers of [
      undefined, {}, { host: '' },
      { host: 'lanparty.example.test' },
      { host: '192.168.0.10:3000' },
      { host: 'localhost.example.test' },
      // A proxy on the same box talks to the server as 127.0.0.1; the public name is elsewhere.
      { host: '127.0.0.1:5280', 'x-forwarded-host': 'lanparty.example.test' },
      { host: '127.0.0.1:5280', origin: 'https://lanparty.example.test' },
      { host: 'localhost:3000', 'x-forwarded-host': 'localhost, lanparty.example.test' },
      { host: 'localhost:3000', origin: 'null' },
      { host: 'a b c' },
    ]) assert.equal(servedFromLoopback(headers), false, JSON.stringify(headers));
  });

  test('no username or password in the address', () => {
    for (const bad of NEVER['credentials in the address']) {
      const out = check(bad, own, LOCAL);
      assert.equal(out.ok, false, bad);
      assert.match(out.problem, /username or password/, bad);
    }
  });

  test('anything that is not a full http(s) address is refused: unparseable text, other schemes, and the parser\'s leniencies', () => {
    for (const bad of [...NEVER['not an address at all'], ...NEVER['a scheme that is not https'], ...NOT_STRINGS]) {
      const out = check(bad);
      assert.equal(out.ok, false, JSON.stringify(bad));
      assert.match(out.problem, /https:\/\//);
    }
  });

  test('never LAN Party\'s own address, however it is spelled', () => {
    const ownSpellings = [
      'https://lanparty.example.test/',
      'https://lanparty.example.test/app-bundles/abc-123/',
      'HTTPS://LANPARTY.EXAMPLE.TEST/',
      'https://LanParty.Example.Test/',
      'https://lanparty.example.test./',          // a trailing dot is the same machine
      'https://lanparty.example.test../',
      'https://lanparty.example.test:443/',       // the default port, written out
      'https://LANPARTY.example.test.:443/x?y#z',
      'https://lanparty.example.test:80/',        // the other default: the server may not know which scheme it is behind
      'https://lanparty%2Eexample%2Etest/',       // an encoded dot is a dot
      'https://lanparty。example。test/',     // so is an ideographic full stop
      'https://ＬＡＮＰＡＲＴＹ.example.test/', // and full-width letters are letters
    ];
    for (const bad of ownSpellings) {
      const out = check(bad);
      assert.equal(out.ok, false, bad);
      assert.match(out.problem, /LAN Party's own address/, bad);
    }
    // The same on a development machine, where the address is a port on localhost.
    const dev = ownHostKeys({ host: 'localhost:3000' }, []);
    for (const bad of ['http://localhost:3000/', 'http://LOCALHOST:3000/app', 'http://localhost.:3000/', 'https://localhost:3000/']) {
      assert.match(check(bad, dev, LOCAL).problem, /own address/, bad);
    }
    // Another port there is another origin: that is where the app being developed runs.
    assert.equal(check('http://localhost:5173/', dev, LOCAL).ok, true);
    assert.equal(check('http://127.0.0.1:3000/', ownHostKeys({ host: '127.0.0.1:3000' }, []), LOCAL).ok, false);
    assert.equal(check('http://127.1:3000/', ownHostKeys({ host: '127.0.0.1:3000' }, []), LOCAL).ok, false, 'a short spelling of the same ip');
    assert.equal(check('http://[::1]:3000/', ownHostKeys({ host: '[::1]:3000' }, []), LOCAL).ok, false);
  });

  test('"own address" is everything the request and the configuration say it is', () => {
    const keys = ownHostKeys(
      { host: 'internal:3000', 'x-forwarded-host': 'public.example.test, edge.example.test:8443', origin: 'https://app.example.test' },
      ['https://lanparty.example.test', ' https://second.example.test:444 ', 'bare.example.test:9000', '']
    );
    const refused = [
      'https://internal:3000/', 'https://public.example.test/', 'https://edge.example.test:8443/', 'https://app.example.test/',
      'https://lanparty.example.test/', 'https://LANPARTY.example.test.:443/', 'https://second.example.test:444/', 'https://bare.example.test:9000/',
    ];
    for (const bad of refused) assert.match(check(bad, keys).problem, /own address/, bad);
    // Ports are part of it: the same name on another port is another origin.
    for (const fine of ['https://second.example.test/', 'https://edge.example.test/', 'https://bare.example.test/', 'https://music.example.test/']) {
      assert.equal(check(fine, keys).ok, true, fine);
    }
    // Headers the sender controls can only add to the list. Nonsense in them adds nothing and breaks nothing.
    for (const headers of [undefined, {}, { host: '' }, { origin: 'null' }, { host: 'a b c', origin: '://', 'x-forwarded-host': ',,' }]) {
      const some = ownHostKeys(headers, ['https://lanparty.example.test']);
      assert.equal(check('https://lanparty.example.test/', some).ok, false);
      assert.equal(check('https://music.example.test/', some).ok, true);
    }
  });

  test('a hosted app is a link app with embed on; a bundle never is', () => {
    assert.equal(isHostedApp({ kind: 'link', embed: 1 }), true);
    assert.equal(isHostedApp({ kind: 'link', embed: true }), true);
    for (const row of [{ kind: 'link', embed: 0 }, { kind: 'link' }, { kind: 'bundle', embed: 1 }, { embed: 1 }, null, undefined]) {
      assert.equal(isHostedApp(row), false, JSON.stringify(row));
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('room keys (services/hostedApps.js)', () => {
  const key = createAppRoomKeys('a-server-secret');
  const SITE = 'https://music.example.test';

  test('32 lower-case hex characters, the same every time for the same app on the same site in the same channel', () => {
    const k = key(7, SITE, 'demo', 'voice1');
    assert.match(k, /^[0-9a-f]{32}$/);
    assert.equal(key(7, SITE, 'demo', 'voice1'), k);
    assert.equal(createAppRoomKeys('a-server-secret')(7, SITE, 'demo', 'voice1'), k, 'and after a restart');
  });

  test('different for another app, another channel, another server', () => {
    const seen = new Set([
      key(7, SITE, 'demo', 'voice1'),
      key(8, SITE, 'demo', 'voice1'),
      key(7, SITE, 'demo', 'voice2'),
      key(7, SITE, 'other', 'voice1'),
      key(71, SITE, 'demo', 'voice1'),
      // Parts that could run together into another set's text stay apart.
      key(7, SITE, 'demo:voice', '1'),
      key(7, SITE, 'demo', ':voice1'),
    ]);
    assert.equal(seen.size, 7);
  });

  test('bound to the site it is given to: another origin for the same app is another key, and a bundle is not a hosted app', () => {
    const here = key(7, SITE, 'demo', 'voice1');
    for (const other of ['https://elsewhere.example.test', 'http://music.example.test', 'https://music.example.test:8443', 'bundle']) {
      assert.notEqual(key(7, other, 'demo', 'voice1'), here, other);
    }
    // What decides the origin: a hosted app's address (path and query do not count), or 'bundle'.
    const hosted = (url) => appFrameOrigin({ kind: 'link', embed: 1, url });
    assert.equal(hosted('https://music.example.test/room?x=1#y'), SITE);
    assert.equal(hosted('https://music.example.test/'), SITE);
    assert.equal(hosted('https://bücher.example/'), 'https://xn--bcher-kva.example');
    assert.equal(appFrameOrigin({ kind: 'bundle', bundle_dir: 'abc-123', url: '' }), 'bundle');
    assert.equal(appFrameOrigin({ kind: 'bundle', bundle_dir: 'abc-123', embed: 1, url: SITE }), 'bundle');
    for (const row of [{ kind: 'link', embed: 0, url: SITE }, { kind: 'bundle', bundle_dir: null }, { kind: 'link', embed: 1, url: 'not a url' }, null]) {
      assert.equal(appFrameOrigin(row), null, JSON.stringify(row));
    }
    // So moving an app to a new path keeps its keys, and to a new origin rotates them.
    assert.equal(key(7, hosted('https://music.example.test/v2/'), 'demo', 'voice1'), here);
    assert.notEqual(key(7, hosted('https://music2.example.test/'), 'demo', 'voice1'), here);
  });

  test('it cannot be worked out without the server\'s secret, and says nothing about the ids', () => {
    const k = key(7, SITE, 'demo', 'voice1');
    assert.notEqual(createAppRoomKeys('another-secret')(7, SITE, 'demo', 'voice1'), k);
    for (const part of ['demo', 'voice1', 'music']) assert.ok(!k.includes(Buffer.from(part).toString('hex')), part);
    // Keyed under a label of its own, not with the base secret itself: the same HMAC made
    // straight from that secret is a different value.
    const crypto = require('node:crypto');
    const direct = crypto.createHmac('sha256', 'a-server-secret').update(JSON.stringify([7, SITE, 'demo', 'voice1'])).digest('hex').slice(0, 32);
    assert.notEqual(k, direct);
  });
});

// ---------------------------------------------------------------------------------------------
describe('migration 0012_app_embed', () => {
  const before0012 = MIGRATIONS.filter((m) => m.name < '0012');

  test('it is the next one after 0011', () => {
    assert.equal(before0012.length, 11);
    assert.equal(MIGRATIONS[11].name, '0012_app_embed');
  });

  test('every app that already exists stays what it was: no link starts running inside LAN Party', async () => {
    const db = await freshDb();
    await runMigrations(db, before0012);
    await db.run("INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind, status) VALUES ('Music DJ', 'd', 'https://music.example.test/', '', 'ann', 1, 'link', 'published')");
    await db.run("INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind, bundle_dir, status) VALUES ('Old Bundle', '', '', '', 'ben', 2, 'bundle', 'abc-123', 'pending')");
    assert.ok(!(await db.all('PRAGMA table_info(apps)')).some((c) => c.name === 'embed'));
    await migrate(db);
    const rows = await db.all('SELECT name, url, kind, bundle_dir, status, embed FROM apps ORDER BY created_at');
    assert.deepEqual(rows, [
      { name: 'Music DJ', url: 'https://music.example.test/', kind: 'link', bundle_dir: null, status: 'published', embed: 0 },
      { name: 'Old Bundle', url: '', kind: 'bundle', bundle_dir: 'abc-123', status: 'pending', embed: 0 },
    ]);
    // An insert that does not say is not hosted either.
    await db.run("INSERT INTO apps (name, created_by, created_at) VALUES ('Forgot', 'ann', 9)");
    assert.equal((await db.get("SELECT embed FROM apps WHERE name = 'Forgot'")).embed, 0);
    // Run again on a database that lost its migration record: nothing moves.
    await db.run("UPDATE apps SET embed = 1 WHERE name = 'Music DJ'");
    await db.exec('DROP TABLE schema_migrations');
    await migrate(db);
    assert.equal((await db.get("SELECT embed FROM apps WHERE name = 'Music DJ'")).embed, 1);
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------
// One server. It is configured as served from two origins (CLIENT_ORIGIN); the tests reach it at
// 127.0.0.1:<port>, which is therefore a third address of its own. 'owner' registers first and is
// the instance owner; 'dev' adds apps; 'ben' is a stranger to every app here.
describe('hosted apps (server)', () => {
  let server, call, base, port, tokens;
  /** @type {any[]} */
  const openSockets = [];
  let serial = 0;
  const HOSTED = 'https://music.example.test/';

  const addLink = async (who, body = {}) => {
    const res = await call('POST', '/apps', { name: `App ${++serial}`, url: HOSTED, ...body }, tokens[who]);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    return res.data.app;
  };
  const addHosted = (who, url = HOSTED) => addLink(who, { url, embed: true });
  const uploadBundle = async (who) => {
    const fd = new FormData();
    fd.append('name', `Bundle ${++serial}`);
    fd.append('bundle', new Blob([strToU8('<h1>bundle</h1>')], { type: 'text/html' }), 'index.html');
    const res = await call('POST', '/apps/bundle', fd, tokens[who]);
    assert.equal(res.status, 200);
    return res.data.app;
  };
  const act = (who, id, action, body) => call('POST', `/apps/${id}/${action}`, body, tokens[who]);
  const patch = (who, id, body) => call('PATCH', `/apps/${id}`, body, tokens[who]);
  // What a reviewer's client sends: the address it showed, and that it showed a hosted app.
  const reviewed = (app) => ({ url: app.url, embed: app.hosted });
  // One of dev's hosted apps, taken from draft to `status` along the real routes.
  const devHosted = async (status, url = HOSTED) => {
    const app = await addHosted('dev', url);
    const ok = async (who, action, body) => { const r = await act(who, app.id, action, body); assert.equal(r.status, 200, `${action} -> ${JSON.stringify(r.data)}`); };
    if (status === 'pending') await ok('dev', 'submit');
    if (status === 'published') await ok('owner', 'approve', reviewed(app));
    if (status === 'rejected') { await ok('dev', 'submit'); await ok('owner', 'reject', { note: 'needs work' }); }
    return app;
  };
  const listFor = async (who) => (await call('GET', '/apps', undefined, tokens[who])).data.apps;
  const seenBy = async (who, id) => (await listFor(who)).find((a) => a.id === id);
  const rowOf = async (id) => (await dbAll(server.dataDir, 'SELECT url, embed, status, name FROM apps WHERE id = ?', [id]))[0];
  // Writes a row the routes would never have written, for "however the row came to be".
  const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path.join(server.dataDir, 'data.sqlite'));
    db.run(sql, params, (err) => { db.close(); if (err) reject(err); else resolve(undefined); });
  });
  // A JSON request with headers fetch() will not let a test set (Host).
  const raw = (method, route, body, who, headers = {}) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${tokens[who]}`, ...headers },
    }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(payload);
  });

  // --- sockets ---
  function once(socket, event, match = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const onEvent = (payload) => {
        if (!match(payload)) return;
        clearTimeout(timer);
        socket.off(event, onEvent);
        resolve(payload);
      };
      const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`timed out waiting for "${event}"`)); }, timeoutMs);
      socket.on(event, onEvent);
    });
  }
  const isApp = (v) => v != null && v.type === 'app';
  async function enter(name, channelId) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[name] } });
    openSockets.push(socket);
    await once(socket, 'connect');
    socket.userName = name;
    socket.updates = [];
    socket.lists = [];
    socket.notices = [];
    socket.on('activity:update', (a) => { socket.updates.push(a); socket.act = a; });
    socket.on('activity:app-joined', (m) => socket.lists.push(m));
    for (const event of ['app:submitted', 'app:review-queue', 'app:reviewed']) socket.on(event, (payload) => socket.notices.push({ event, payload }));
    const joined = once(socket, 'channel:joined');
    socket.emit('join', { serverId: 'demo', name });
    await joined;
    if (channelId) {
      const peers = once(socket, 'voice:peers');
      socket.emit('voice:join', { serverId: 'demo', channelId });
      await peers;
    }
    return socket;
  }
  // Resolves with the starter's own view of the new run (they are joined from the first update).
  // Matched on who started it as well: an update about someone else's start in the same room may
  // still be on its way to this socket.
  const startApp = (socket, channelId, appId) => {
    const last = socket.act && isApp(socket.act) ? socket.act.state.run : null;
    const started = once(socket, 'activity:update', (v) => isApp(v) && v.by === socket.userName && v.state.run !== last);
    socket.emit('activity:start', { serverId: 'demo', channelId, type: 'app', appId });
    return started;
  };
  // A start the server must ignore. The built-in started right after it is handled later on the
  // same socket, so once that arrives the refused start has been worked through.
  const startRefused = async (socket, channelId, appId) => {
    const seen = socket.updates.length;
    socket.emit('activity:start', { serverId: 'demo', channelId, type: 'app', appId });
    await sleep(150);
    const marker = once(socket, 'activity:update', (v) => v != null && v.type === 'ttt');
    socket.emit('activity:start', { serverId: 'demo', channelId, type: 'ttt' });
    await marker;
    assert.ok(!socket.updates.slice(seen).some(isApp), 'the app must not have started');
  };
  const appEvent = (socket, channelId, event) => new Promise((resolve) => {
    socket.emit('activity:event', { serverId: 'demo', channelId, app: socket.act.state.run, event }, resolve);
  });

  before(async () => {
    server = await startServer({ env: { INSTANCE_OWNERS: '', CLIENT_ORIGIN: 'https://lanparty.example.test, https://alt.example.test:8443' } });
    base = server.base;
    port = Number(new URL(base).port);
    call = apiFor(base);
    tokens = {};
    for (const name of ['owner', 'dev', 'ben']) tokens[name] = await makeUser(call, name);
  });
  after(async () => {
    for (const s of openSockets) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  // --- the embed setting, and what an app looks like with it ---
  test('a link app without embed is exactly what it was: its url as typed, not embeddable, not startable', async () => {
    const typed = ['https://example.com/app', 'example.com/whatever', '  spaced.example  ', 'http://plain.example/', ''];
    for (const url of typed) {
      for (const extra of [{}, { embed: false }]) {
        const app = await addLink('dev', { url, ...extra });
        assert.equal(app.url, url.trim(), 'kept as typed (trimmed), not parsed, not checked');
        assert.equal(app.kind, 'link');
        assert.equal(app.embeddable, false);
        assert.equal(app.hosted, false);
        assert.equal(app.status, 'draft');
        assert.equal((await rowOf(app.id)).embed, 0);
      }
    }
    // An address that would be refused for a hosted app is still fine for a link that opens in a tab.
    const own = await addLink('owner', { url: `http://127.0.0.1:${port}/some/page` });
    assert.equal(own.hosted, false);
    assert.equal(own.status, 'published');
    // Published and all, a plain link runs in no room.
    const socket = await enter('owner', 'h-plain');
    await startRefused(socket, 'h-plain', own.id);
    // A bundle is embeddable as before, and is not "hosted" in this sense.
    const bundle = await uploadBundle('dev');
    assert.equal(bundle.embeddable, true);
    assert.equal(bundle.hosted, false);
    assert.equal(bundle.kind, 'bundle');
  });

  test('a link app with embed on is a hosted app: hosted, not "embeddable", its address stored as parsed', async () => {
    const app = await addHosted('dev', '  HTTPS://Music.Example.TEST:443/Room?x=1#top ');
    assert.equal(app.url, 'https://music.example.test/Room?x=1#top');
    assert.equal(app.kind, 'link');
    // `embeddable` means "a bundle" and only that: a client from before hosted apps existed reads it
    // as "frame this in the bundle sandbox", where a hosted site is a blank page. With it false such
    // a client shows the app as a plain link, which works.
    assert.equal(app.embeddable, false);
    assert.equal(app.hosted, true);
    assert.equal(app.status, 'draft', 'under the same review as any other app');
    assert.deepEqual(await rowOf(app.id), { url: 'https://music.example.test/Room?x=1#top', embed: 1, status: 'draft', name: app.name });
    // Nothing is added to it: no marker, no name, no room. The client adds `lanparty=1` itself.
    assert.ok(!/lanparty=/.test(app.url));
    // Hidden from strangers while a draft, like any app; `hosted` is there for everyone once published.
    assert.ok(!(await seenBy('ben', app.id)));
    assert.equal((await act('owner', app.id, 'approve', reviewed(app))).status, 200);
    const forBen = await seenBy('ben', app.id);
    assert.equal(forBen.hosted, true);
    assert.equal(forBen.embeddable, false);
    assert.equal(forBen.url, app.url);
    // An instance owner's own is published at once, as with a bundle.
    assert.equal((await addHosted('owner')).status, 'published');
    // A development app on this machine, on another port than LAN Party's.
    const local = await addHosted('dev', 'http://localhost:5173');
    assert.equal(local.url, 'http://localhost:5173/');
  });

  test('embed is true or false and nothing else', async () => {
    for (const embed of ['true', 'yes', 1, 0, null, {}, []]) {
      const res = await call('POST', '/apps', { name: 'Odd', url: HOSTED, embed }, tokens.dev);
      assert.equal(res.status, 400, JSON.stringify(embed));
      assert.equal(res.data.error, 'Invalid embed setting');
    }
    const link = await addLink('dev');
    for (const embed of ['true', 1, null, {}]) {
      assert.equal((await patch('dev', link.id, { embed })).status, 400, JSON.stringify(embed));
    }
    assert.equal((await rowOf(link.id)).embed, 0);
    assert.ok(!(await listFor('dev')).some((a) => a.name === 'Odd'), 'nothing was created');
  });

  // --- validation, on create and on every edit ---
  test('an address that may not be framed is refused when a hosted app is created, edited, or a link is turned into one', async () => {
    const hosted = await addHosted('dev');
    const link = await addLink('dev', { url: 'https://example.com/app' });
    const count = (await listFor('dev')).length;
    const refusedHere = {
      ...NEVER,
      'LAN Party\'s own address: where this request went': [
        `http://127.0.0.1:${port}/`,
        `http://127.0.0.1:${port}/app-bundles/abc-123/`,
        `http://127.1:${port}/`,
        `http://127.0.0.1.:${port}/x`,
        `https://127.0.0.1:${port}/`,
      ],
      'LAN Party\'s own address: an origin it is configured to be served from': [
        'https://lanparty.example.test/',
        'https://lanparty.example.test/app-bundles/abc-123/',
        'HTTPS://LANPARTY.EXAMPLE.TEST/',
        'https://LanParty.Example.Test./',
        'https://lanparty.example.test:443/',
        'https://LANPARTY.example.test.:443/x?y#z',
        'https://lanparty%2Eexample%2Etest/',
        'https://alt.example.test:8443/',
        'https://ALT.example.test.:8443/x',
      ],
    };
    for (const [why, urls] of Object.entries(refusedHere)) {
      for (const url of urls) {
        const label = `${why}: ${JSON.stringify(url)}`;
        const created = await call('POST', '/apps', { name: 'Refused', url, embed: true }, tokens.dev);
        assert.equal(created.status, 400, `create, ${label}`);
        assert.ok(created.data.error, label);
        if (/own address/.test(why)) assert.match(created.data.error, /LAN Party's own address/, label);
        // Editing a hosted app's address to it.
        assert.equal((await patch('dev', hosted.id, { url })).status, 400, `edit, ${label}`);
        // Turning a link into a hosted app at it, in one request...
        assert.equal((await patch('dev', link.id, { url, embed: true })).status, 400, `convert, ${label}`);
      }
    }
    for (const url of NOT_STRINGS) {
      assert.equal((await call('POST', '/apps', { name: 'Refused', url, embed: true }, tokens.dev)).status, 400, JSON.stringify(url));
      if (url !== undefined) assert.equal((await patch('dev', hosted.id, { url })).status, 400, JSON.stringify(url));
    }
    // ...or in two: a link may be given any address, but not then be set to run inside LAN Party.
    for (const url of ['javascript:alert(1)', 'https://lanparty.example.test/', `http://127.0.0.1:${port}/`, 'http://music.example.test/']) {
      const plain = await addLink('dev', { url });
      const res = await patch('dev', plain.id, { embed: true });
      assert.equal(res.status, 400, url);
      assert.deepEqual([(await rowOf(plain.id)).url, (await rowOf(plain.id)).embed], [url, 0]);
      await call('DELETE', `/apps/${plain.id}`, undefined, tokens.dev);
    }
    // Nothing was created and neither app moved.
    assert.equal((await listFor('dev')).length, count);
    assert.deepEqual(await rowOf(hosted.id), { url: HOSTED, embed: 1, status: 'draft', name: hosted.name });
    assert.deepEqual(await rowOf(link.id), { url: 'https://example.com/app', embed: 0, status: 'draft', name: link.name });
    // The other port of a configured name is another origin, and fine.
    assert.equal((await patch('dev', hosted.id, { url: 'https://alt.example.test/' })).status, 200);
  });

  test('the page that sent the request, and the name a proxy says it was sent to, are LAN Party\'s own address too', async () => {
    const body = (url) => ({ name: `Via ${++serial}`, url, embed: true });
    // Reached under another name (a reverse proxy, a LAN address): that name is ours as well.
    for (const [headers, url] of [
      [{ Host: 'public.example.test' }, 'https://PUBLIC.example.test./app'],
      [{ Host: 'public.example.test:8080' }, 'https://public.example.test:8080/'],
      [{ 'X-Forwarded-Host': 'edge.example.test' }, 'https://edge.example.test/'],
      [{ Origin: 'https://client.example.test' }, 'https://client.example.test/'],
      [{ Origin: 'http://localhost:5173' }, 'http://localhost:5173/'],
    ]) {
      const refused = await raw('POST', '/apps', body(url), 'dev', headers);
      assert.equal(refused.status, 400, url);
      assert.match(refused.data.error, /own address/);
      // The same address is fine for a request that does not come from there.
      const fine = await raw('POST', '/apps', body(url), 'dev');
      assert.equal(fine.status, 200, url);
      assert.equal(fine.data.app.hosted, true);
    }
  });

  test('plain http://localhost is accepted only from a LAN Party being run on this machine', async () => {
    const body = (url) => ({ name: `Local ${++serial}`, url, embed: true });
    // This test reaches the server at 127.0.0.1, with no other name in the request: loopback.
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1:5173/']) {
      const fine = await raw('POST', '/apps', body(url), 'dev');
      assert.equal(fine.status, 200, url);
      assert.equal(fine.data.app.url, url);
      // Requests that show the server is really reached under a public name, directly or through
      // a proxy on the same box, or from a page that is: refused.
      for (const headers of [
        { Host: 'lanparty.example.test' },
        { 'X-Forwarded-Host': 'lanparty.example.test' },
        { Origin: 'https://lanparty.example.test' },
        { Host: '192.168.0.10:3000' },
      ]) {
        const refused = await raw('POST', '/apps', body(url), 'dev', headers);
        assert.equal(refused.status, 400, `${url} ${JSON.stringify(headers)}`);
        assert.match(refused.data.error, /https:\/\//);
        // Nor can an existing one be edited or approved from there.
        assert.equal((await raw('PATCH', `/apps/${fine.data.app.id}`, { name: 'Renamed' }, 'dev', headers)).status, 400);
      }
      // Approving it from a public name is refused; from this machine it goes through.
      assert.equal((await raw('POST', `/apps/${fine.data.app.id}/approve`, { url, embed: true }, 'owner', { Host: 'lanparty.example.test' })).status, 409);
      assert.equal((await raw('POST', `/apps/${fine.data.app.id}/approve`, { url, embed: true }, 'owner')).status, 200);
    }
  });

  test('a published http://localhost app starts only for a socket that reached LAN Party on loopback', async () => {
    const app = await addHosted('owner', 'http://localhost:5173/');
    assert.equal(app.status, 'published');
    // Reached on loopback (as every socket in this file is): it starts.
    const here = await enter('ben', 'h-loop-1');
    assert.equal((await startApp(here, 'h-loop-1', app.id)).state.url, 'http://localhost:5173/');
    // A socket whose handshake came from a page on a public name: it does not.
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens.ben }, extraHeaders: { Origin: 'https://lanparty.example.test' } });
    openSockets.push(socket);
    await once(socket, 'connect');
    socket.userName = 'ben';
    socket.updates = [];
    socket.on('activity:update', (a) => { socket.updates.push(a); socket.act = a; });
    const joined = once(socket, 'channel:joined');
    socket.emit('join', { serverId: 'demo', name: 'ben' });
    await joined;
    const peers = once(socket, 'voice:peers');
    socket.emit('voice:join', { serverId: 'demo', channelId: 'h-loop-2' });
    await peers;
    await startRefused(socket, 'h-loop-2', app.id);
    // An https app starts there as usual.
    const https = await addHosted('owner');
    assert.equal((await startApp(socket, 'h-loop-2', https.id)).state.url, HOSTED);
  });

  // --- starting one in a room ---
  test('a hosted app starts in a room under the same rules as a bundle, and is refused otherwise', async () => {
    const published = await devHosted('published');
    for (const who of ['ben', 'dev', 'owner']) {
      const socket = await enter(who, `h-pub-${who}`);
      const started = await startApp(socket, `h-pub-${who}`, published.id);
      const { run, roomKey, ...rest } = started.state;
      assert.match(run, /^[0-9a-f]{16}$/);
      assert.match(roomKey, /^[0-9a-f]{32}$/);
      assert.deepEqual(rest, {
        appId: published.id, name: published.name, url: HOSTED, hosted: true, iconUrl: '', createdBy: 'dev', approved: true,
        shared: {}, rev: 0, lastBy: null, joined: [who],
      });
      assert.equal(started.by, who);
    }
    for (const status of ['draft', 'pending']) {
      const app = await devHosted(status);
      const room = `h-${status}`;
      const dev = await enter('dev', room);
      const ben = await enter('ben', room);
      const card = once(ben, 'activity:update', isApp);
      const started = await startApp(dev, room, app.id);
      assert.equal(started.state.approved, false, status);
      assert.equal(started.state.hosted, true);
      const seen = await card;
      assert.equal(seen.state.approved, false, 'the people asked to join are told it is not approved');
      assert.equal(seen.state.hosted, true);
      assert.equal(seen.state.url, HOSTED);
      // An instance owner may start it to review it; nobody else, from any room.
      const owner = await enter('owner', `${room}-owner`);
      assert.equal((await startApp(owner, `${room}-owner`, app.id)).state.approved, false);
      await startRefused(await enter('ben', `${room}-ben`), `${room}-ben`, app.id);
      await startRefused(ben, room, app.id);
    }
    const rejected = await devHosted('rejected');
    for (const who of ['dev', 'owner', 'ben']) await startRefused(await enter(who, `h-rej-${who}`), `h-rej-${who}`, rejected.id);
    // What the client sent besides the id is ignored: the room gets the address in the row.
    const ben = await enter('ben', 'h-forged');
    const started = once(ben, 'activity:update', isApp);
    ben.emit('activity:start', { serverId: 'demo', channelId: 'h-forged', type: 'app', appId: published.id, url: 'https://evil.example/', hosted: false, roomKey: 'f'.repeat(32) });
    const state = (await started).state;
    assert.equal(state.url, HOSTED);
    assert.equal(state.hosted, true);
    assert.notEqual(state.roomKey, 'f'.repeat(32));
  });

  test('a row that points at LAN Party itself is neither published nor started nor edited, however it came to be', async () => {
    // Written behind the routes' backs: a hosted app whose address is an origin this server is
    // configured to be served from, and one at the address the test reaches it by.
    const configured = await devHosted('pending');
    await dbRun('UPDATE apps SET url = ? WHERE id = ?', ['https://lanparty.example.test/app-bundles/x/', configured.id]);
    const here = await addHosted('owner');
    await dbRun('UPDATE apps SET url = ? WHERE id = ?', [`http://127.0.0.1:${port}/`, here.id]);

    // The instance owner is shown it, and cannot publish it even naming exactly what they see.
    const shown = await seenBy('owner', configured.id);
    assert.equal(shown.url, 'https://lanparty.example.test/app-bundles/x/');
    const res = await act('owner', configured.id, 'approve', reviewed(shown));
    assert.equal(res.status, 409, JSON.stringify(res.data));
    assert.match(res.data.error, /LAN Party's own address/);
    assert.equal((await rowOf(configured.id)).status, 'pending');
    // Its uploader cannot start it in a room, and nor can anyone start the published one.
    await startRefused(await enter('dev', 'h-own-1'), 'h-own-1', configured.id);
    assert.equal((await rowOf(here.id)).status, 'published');
    await startRefused(await enter('ben', 'h-own-2'), 'h-own-2', here.id);
    // Every edit of a hosted app asks again, so not even a rename goes through until it is fixed...
    assert.equal((await patch('dev', configured.id, { name: 'Renamed' })).status, 400);
    assert.equal((await rowOf(configured.id)).name, configured.name);
    // ...by moving it somewhere else, or by making it a plain link again.
    assert.equal((await patch('dev', configured.id, { name: 'Renamed', embed: false })).status, 200);
    assert.equal((await patch('owner', here.id, { url: HOSTED })).status, 200);
    const fixed = await startApp(await enter('ben', 'h-own-3'), 'h-own-3', here.id);
    assert.equal(fixed.state.url, HOSTED);
  });

  // --- editing the address or the setting ---
  test('editing a hosted app\'s address, or turning the setting on or off, sends the app back to draft from any status', async () => {
    const edits = {
      'a new address': { from: (s) => devHosted(s), body: { url: 'https://other.example.test/app' }, after: { url: 'https://other.example.test/app', hosted: true } },
      'run inside turned off': { from: (s) => devHosted(s), body: { embed: false }, after: { url: HOSTED, hosted: false } },
      'both at once': { from: (s) => devHosted(s), body: { url: 'plain.example/typed', embed: false }, after: { url: 'plain.example/typed', hosted: false } },
      'run inside turned on': { from: (s) => devLink(s), body: { embed: true }, after: { url: HOSTED, hosted: true } },
      'a plain link pointed somewhere else': { from: (s) => devLink(s), body: { url: 'https://elsewhere.example/' }, after: { url: 'https://elsewhere.example/', hosted: false } },
    };
    for (const [label, edit] of Object.entries(edits)) {
      for (const status of STATUSES) {
        const app = await edit.from(status);
        const res = await patch('dev', app.id, edit.body);
        assert.equal(res.status, 200, `${label}, ${status}: ${JSON.stringify(res.data)}`);
        assert.equal(res.data.app.status, 'draft', `${label}: a ${status} app goes back to draft`);
        assert.equal(res.data.app.url, edit.after.url, label);
        assert.equal(res.data.app.hosted, edit.after.hosted, label);
        assert.equal(res.data.app.embeddable, false, label);
        assert.equal((await rowOf(app.id)).status, 'draft');
        if (status === 'published') assert.ok(!(await seenBy('ben', app.id)), `${label}: no longer in anyone else's directory`);
      }
    }
  });
  // One of dev's plain links at HOSTED's address, taken to `status`.
  async function devLink(status) {
    const app = await addLink('dev');
    if (status === 'pending' || status === 'rejected') assert.equal((await act('dev', app.id, 'submit')).status, 200);
    if (status === 'published') assert.equal((await act('owner', app.id, 'approve', reviewed(app))).status, 200);
    if (status === 'rejected') assert.equal((await act('owner', app.id, 'reject')).status, 200);
    return app;
  }

  test('an edit that changes neither leaves the status alone', async () => {
    for (const status of STATUSES) {
      const app = await devHosted(status);
      // Details only; the address and the setting sent back exactly as they are; a different
      // spelling of the same address.
      for (const body of [{ name: `Renamed ${app.id}`, description: 'new words' }, { url: HOSTED, embed: true }, { url: '  HTTPS://MUSIC.example.test:443  ' }, { embed: true }]) {
        const res = await patch('dev', app.id, body);
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(res.data.app.status, status, `${status}: ${JSON.stringify(body)}`);
        assert.equal(res.data.app.url, HOSTED);
        assert.equal(res.data.app.hosted, true);
      }
      assert.equal((await rowOf(app.id)).name, `Renamed ${app.id}`);
    }
  });

  test('an instance owner editing their own hosted app keeps its status', async () => {
    const app = await addHosted('owner');
    assert.equal(app.status, 'published');
    const moved = await patch('owner', app.id, { url: 'https://other.example.test/' });
    assert.equal(moved.data.app.status, 'published', 'nobody else to ask');
    assert.equal(moved.data.app.url, 'https://other.example.test/');
    assert.equal((await patch('owner', app.id, { embed: false })).data.app.status, 'published');
    assert.equal((await patch('owner', app.id, { embed: true })).data.app.status, 'published');
    // Their own unpublished app stays unpublished rather than being published by an edit.
    await act('owner', app.id, 'unpublish');
    assert.equal((await patch('owner', app.id, { url: HOSTED })).data.app.status, 'draft');
  });

  test('only the uploader edits, only a link has an address or the setting, and a stranger learns nothing', async () => {
    const app = await devHosted('published');
    assert.equal((await patch('owner', app.id, { url: 'https://owner.example.test/' })).status, 403, 'an instance owner reviews; they do not repoint someone else\'s app');
    assert.equal((await patch('ben', app.id, { embed: false })).status, 403);
    const draft = await devHosted('draft');
    assert.deepEqual(await patch('ben', draft.id, { url: 'https://ben.example.test/' }), { status: 404, data: { error: 'App not found' } });
    assert.deepEqual(await patch('ben', draft.id, { url: 'javascript:alert(1)', embed: true }), { status: 404, data: { error: 'App not found' } }, 'not even a validation error');
    assert.deepEqual(await rowOf(app.id), { url: HOSTED, embed: 1, status: 'published', name: app.name });

    const bundle = await uploadBundle('dev');
    for (const body of [{ url: HOSTED }, { embed: true }, { embed: false }, { name: 'x', url: HOSTED, embed: true }]) {
      const res = await patch('dev', bundle.id, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.data.error, /Only a link app/);
    }
    const still = await seenBy('dev', bundle.id);
    assert.deepEqual([still.kind, still.hosted, still.url, still.name], ['bundle', false, bundle.url, bundle.name]);
    assert.equal((await patch('dev', bundle.id, { name: 'Still a bundle' })).status, 200, 'its details can be edited as before');
  });

  test('a running hosted app is ended in its rooms when its address or the setting is edited, and not by anything else', async () => {
    const endings = {
      'address edited': { owner: false, body: { url: 'https://other.example.test/' } },
      'run inside turned off': { owner: false, body: { embed: false } },
      'address edited by an instance owner, whose app stays published': { owner: true, body: { url: 'https://other.example.test/' } },
    };
    let n = 0;
    for (const [label, { owner, body }] of Object.entries(endings)) {
      const app = owner ? await addHosted('owner') : await devHosted('published');
      const other = await addHosted('owner');
      const room = `h-end-${++n}`;
      const starter = await enter('ben', room);
      const watcher = await enter(owner ? 'dev' : 'owner', room);
      const bystander = await enter('ben', `${room}-other`);
      const first = await startApp(starter, room, app.id);
      await startApp(bystander, `${room}-other`, other.id);

      // Edits that are not about what it runs leave the room alone.
      for (const harmless of [{ name: `Renamed ${app.id}` }, { url: HOSTED }, { embed: true }, { description: 'words' }]) {
        assert.equal((await patch(owner ? 'owner' : 'dev', app.id, harmless)).status, 200);
      }
      // A refused one too.
      assert.equal((await patch(owner ? 'owner' : 'dev', app.id, { url: 'https://lanparty.example.test/' })).status, 400);
      await sleep(150);
      assert.equal(starter.act.state.run, first.state.run, `${label}: still the same run`);

      const ended = [once(starter, 'activity:update', (v) => v === null), once(watcher, 'activity:update', (v) => v === null)];
      const res = await patch(owner ? 'owner' : 'dev', app.id, body);
      assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.app.status, owner ? 'published' : 'draft', label);
      await Promise.all(ended);
      await sleep(100);
      assert.equal(bystander.act.state.appId, other.id, `${label}: a room running a different app is left alone`);

      if (owner) {
        // Started again, it runs from the new address.
        assert.equal((await startApp(starter, room, app.id)).state.url, 'https://other.example.test/');
      } else {
        // It is a draft now: not ben's to start any more.
        await startRefused(starter, room, app.id);
      }
    }
  });

  test('an address edit moves the review queue, and the owners hear of it', async () => {
    const owner = await enter('owner');
    const dev = await enter('dev');
    const pending = await devHosted('pending');
    const published = await devHosted('published');
    await sleep(200);
    owner.notices = [];
    dev.notices = [];
    await patch('dev', pending.id, { name: 'Just a rename' });      // details are not a review event
    await patch('dev', pending.id, { url: HOSTED });                // nor is an edit that changes nothing
    await patch('dev', pending.id, { url: 'https://other.example.test/' });
    await patch('dev', published.id, { embed: false });
    await sleep(200);
    assert.deepEqual(owner.notices, [
      { event: 'app:review-queue', payload: { id: pending.id, name: 'Just a rename', status: 'draft' } },
      { event: 'app:review-queue', payload: { id: published.id, name: published.name, status: 'draft' } },
    ]);
    assert.deepEqual(dev.notices, [], 'the uploader is not told about their own edit');
  });

  // --- approval is bound to what was reviewed ---
  test('approving a hosted app names the address that was reviewed: an edited one is never published by it', async () => {
    const app = await devHosted('pending');
    const shown = await seenBy('owner', app.id);
    assert.deepEqual([shown.url, shown.hosted], [HOSTED, true]);
    // An approval that does not say what was reviewed approves nothing.
    for (const body of [undefined, {}, { embed: true }, { url: 7, embed: true }, { url: null, embed: true }, { url: HOSTED }]) {
      assert.equal((await act('owner', app.id, 'approve', body)).status, 400, JSON.stringify(body));
    }
    // Nor does one that names the address but says it does not run inside LAN Party.
    for (const body of [{ url: HOSTED, embed: false }, { url: HOSTED, embed: 'true' }, { url: HOSTED, embed: 1 }]) {
      assert.equal((await act('owner', app.id, 'approve', body)).status, 409, JSON.stringify(body));
    }
    assert.equal((await rowOf(app.id)).status, 'pending');

    // The uploader repoints it while it is being looked at (it drops back to draft, which an
    // instance owner may still publish directly)...
    const moved = await patch('dev', app.id, { url: 'https://unseen.example.test/' });
    assert.equal(moved.data.app.status, 'draft');
    const stale = await act('owner', app.id, 'approve', reviewed(shown));
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.match(stale.data.error, /changed since you opened it/);
    assert.equal((await rowOf(app.id)).status, 'draft');
    // ...and submits it again: pending under the same name, as it was when the owner opened it.
    assert.equal((await act('dev', app.id, 'submit')).status, 200);
    for (const url of [HOSTED, 'https://unseen.example.test', 'https://UNSEEN.example.test/', 'https://unseen.example.test/?', '']) {
      assert.equal((await act('owner', app.id, 'approve', { url, embed: true })).status, 409, url);
    }
    assert.equal((await rowOf(app.id)).status, 'pending', 'the unseen address was not published');
    assert.ok(!(await seenBy('ben', app.id)));

    // Having opened the new address, the owner approves that.
    const current = await seenBy('owner', app.id);
    assert.equal(current.url, 'https://unseen.example.test/');
    const ok = await act('owner', app.id, 'approve', reviewed(current));
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.data.app.status, ok.data.app.url, ok.data.app.hosted], ['published', 'https://unseen.example.test/', true]);

    // An instance owner publishing their own is held to the same rule.
    const own = await addHosted('owner');
    await act('owner', own.id, 'unpublish');
    await patch('owner', own.id, { url: 'https://other.example.test/' });
    assert.equal((await act('owner', own.id, 'approve', reviewed(own))).status, 409);
    assert.equal((await act('owner', own.id, 'approve', { url: 'https://other.example.test/', embed: true })).status, 200);
  });

  test('a link reviewed as a link is not published as a hosted app, nor the other way round', async () => {
    // Reviewed as a plain link, which only ever opens in a tab...
    const link = await addLink('dev');
    await act('dev', link.id, 'submit');
    const shown = await seenBy('owner', link.id);
    assert.equal(shown.hosted, false);
    // ...then set to run inside LAN Party, and submitted again under the same name and address.
    assert.equal((await patch('dev', link.id, { embed: true })).data.app.status, 'draft');
    await act('dev', link.id, 'submit');
    // Whatever the reviewer's client sends about what it showed, it is not this.
    for (const body of [undefined, {}, { url: HOSTED }, reviewed(shown)]) {
      const res = await act('owner', link.id, 'approve', body);
      assert.ok(res.status === 400 || res.status === 409, JSON.stringify(body));
    }
    assert.equal((await rowOf(link.id)).status, 'pending');
    assert.equal((await act('owner', link.id, 'approve', { url: HOSTED, embed: true })).status, 200);

    // The other way round: reviewed as a hosted app, made a plain link, submitted again.
    const hosted = await devHosted('pending');
    const seen = await seenBy('owner', hosted.id);
    await patch('dev', hosted.id, { embed: false });
    await act('dev', hosted.id, 'submit');
    assert.equal((await act('owner', hosted.id, 'approve', reviewed(seen))).status, 409);
    assert.equal((await rowOf(hosted.id)).status, 'pending');
    // A plain link whose address was edited: a request that names the old one publishes nothing.
    await patch('dev', hosted.id, { url: 'https://elsewhere.example/' });
    await act('dev', hosted.id, 'submit');
    assert.equal((await act('owner', hosted.id, 'approve', { url: HOSTED, embed: false })).status, 409);
    assert.equal((await act('owner', hosted.id, 'approve', { url: 'https://elsewhere.example/', embed: false })).status, 200);
    // A plain link is held to the same: it names its address and that it does not run inside.
    const plain = await addLink('dev');
    for (const body of [undefined, {}, { embed: false }, { url: HOSTED }]) {
      assert.equal((await act('owner', plain.id, 'approve', body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await act('owner', plain.id, 'approve', { url: HOSTED, embed: true })).status, 409, 'not what it is');
    assert.equal((await act('owner', plain.id, 'approve', { url: 'https://elsewhere.example/', embed: false })).status, 409, 'not where it goes');
    assert.equal((await rowOf(plain.id)).status, 'draft');
    assert.equal((await act('owner', plain.id, 'approve', reviewed(plain))).status, 200);
  });

  // --- the room key ---
  test('the room key: stable for an app in a channel, different across apps and channels, 32 lower-case hex', async () => {
    const one = await addHosted('owner');
    const two = await addHosted('owner', 'https://other.example.test/');
    const bundle = await uploadBundle('owner');
    const a = await enter('owner', 'rk-a');
    const b = await enter('owner', 'rk-b');
    const keyOf = async (socket, channel, app) => (await startApp(socket, channel, app.id)).state.roomKey;

    const first = await startApp(a, 'rk-a', one.id);
    assert.match(first.state.roomKey, /^[0-9a-f]{32}$/);
    // A new run of the same app in the same channel: a new run id, the same room.
    const again = await startApp(a, 'rk-a', one.id);
    assert.notEqual(again.state.run, first.state.run);
    assert.equal(again.state.roomKey, first.state.roomKey);
    // Someone else starting it there gets the same room too.
    const ben = await enter('ben', 'rk-a');
    assert.equal(await keyOf(ben, 'rk-a', one), first.state.roomKey);

    const keys = {
      'app one, channel a': first.state.roomKey,
      'app one, channel b': await keyOf(b, 'rk-b', one),
      'app two, channel a': await keyOf(a, 'rk-a', two),
      'app two, channel b': await keyOf(b, 'rk-b', two),
      'a bundle, channel a': await keyOf(a, 'rk-a', bundle),   // bundles get one as well
      'a bundle, channel b': await keyOf(b, 'rk-b', bundle),
    };
    for (const [label, key] of Object.entries(keys)) assert.match(key, /^[0-9a-f]{32}$/, label);
    assert.equal(new Set(Object.values(keys)).size, 6, 'no two of them are the same');
    // Opaque: neither the channel nor the app can be read off it.
    for (const key of Object.values(keys)) {
      for (const part of ['rk-a', 'rk-b', 'demo']) assert.ok(!key.includes(Buffer.from(part).toString('hex')));
    }
    // Still the same after other apps have come and gone.
    assert.equal(await keyOf(a, 'rk-a', one), first.state.roomKey);
    // What the client claims the room is called does not matter: it is the room the socket is in.
    b.emit('activity:start', { serverId: 'demo', channelId: 'rk-a', type: 'app', appId: one.id });
    await sleep(200);
    assert.ok(!b.updates.some((u) => isApp(u) && u.state.roomKey === first.state.roomKey), 'not in that room, no key for it');
  });

  test('the room key is bound to the app\'s origin: a new path keeps it, a new origin rotates it', async () => {
    const app = await addHosted('owner', 'https://keyed.example.test/v1/');
    const socket = await enter('owner', 'rk-origin');
    const keyNow = async () => (await startApp(socket, 'rk-origin', app.id)).state.roomKey;
    const first = await keyNow();
    assert.equal(await keyNow(), first, 'stable');
    // Same origin, another path and query: the same site, the same keys.
    assert.equal((await patch('owner', app.id, { url: 'https://keyed.example.test/v2/?room=1' })).status, 200);
    assert.equal(await keyNow(), first);
    // Another origin under the same app id: that site does not inherit the old one's keys.
    const moved = {};
    for (const url of ['https://elsewhere.example.test/v2/', 'https://keyed.example.test:8443/v2/']) {
      assert.equal((await patch('owner', app.id, { url })).status, 200, url);
      moved[url] = await keyNow();
      assert.notEqual(moved[url], first, url);
    }
    assert.equal(new Set(Object.values(moved)).size, 2);
    // And back again: the keys are a function of the site, so they come back with it.
    assert.equal((await patch('owner', app.id, { url: 'https://keyed.example.test/' })).status, 200);
    assert.equal(await keyNow(), first);
  });

  test('the room key reaches the people who joined the app, and nobody else', async () => {
    for (const kind of ['hosted', 'bundle']) {
      const app = kind === 'hosted' ? await addHosted('owner') : await uploadBundle('owner');
      const room = `rk-who-${kind}`;
      const starter = await enter('owner', room);
      const ben = await enter('ben', room);
      const card = once(ben, 'activity:update', isApp);
      const started = await startApp(starter, room, app.id);
      const key = started.state.roomKey;
      assert.match(key, /^[0-9a-f]{32}$/, kind);

      // In the voice room but not in the app: the join card, without the key.
      const seen = await card;
      assert.equal(seen.state.roomKey, null, kind);
      assert.equal(seen.state.name, app.name);
      // State changes and messages among those who joined tell him nothing either.
      assert.equal((await appEvent(starter, room, { kind: 'set', patch: { round: 1 } })).ok, true);
      assert.equal((await appEvent(starter, room, { kind: 'emit', data: 'hi' })).ok, true);
      await sleep(150);

      // Arriving in the voice room later: the card again.
      const late = await enter('dev');
      const lateCard = once(late, 'activity:update', isApp);
      late.emit('voice:join', { serverId: 'demo', channelId: room });
      assert.equal((await lateCard).state.roomKey, null, kind);

      // Joining is what hands it over...
      assert.equal((await appEvent(ben, room, { kind: 'join' })).ok, true);
      assert.equal(ben.act.state.roomKey, key, kind);
      assert.deepEqual(ben.act.state.shared, { round: 1 });
      // ...and every later update to someone who joined carries it.
      assert.equal((await appEvent(ben, room, { kind: 'set', patch: { round: 2 } })).ok, true);
      assert.equal(ben.act.state.roomKey, key);
      assert.equal(starter.act.state.roomKey, key);
      // Leaving the app takes his view back to the card.
      assert.equal((await appEvent(ben, room, { kind: 'leave' })).ok, true);
      assert.equal(ben.act.state.roomKey, null, kind);
      assert.deepEqual(ben.act.state.shared, {});

      // Nothing the late arrival was ever sent has it, in any event.
      await sleep(150);
      assert.ok(late.updates.filter(isApp).length >= 1);
      assert.ok(!JSON.stringify([late.updates, late.lists]).includes(key), `${kind}: the key never reached someone who did not join`);
      // Nor is it anywhere in the app directory.
      for (const who of ['owner', 'ben']) assert.ok(!JSON.stringify(await listFor(who)).includes(key));
    }
  });

  test('approving an app that is running re-sends each person their own view: the key still only to those who joined', async () => {
    const app = await devHosted('pending');
    const dev = await enter('dev', 'rk-approve');
    const ben = await enter('ben', 'rk-approve');
    const started = await startApp(dev, 'rk-approve', app.id);
    const forDev = once(dev, 'activity:update', (v) => isApp(v) && v.state.approved === true);
    const forBen = once(ben, 'activity:update', (v) => isApp(v) && v.state.approved === true);
    assert.equal((await act('owner', app.id, 'approve', reviewed(app))).status, 200);
    assert.equal((await forDev).state.roomKey, started.state.roomKey);
    assert.equal((await forBen).state.roomKey, null);
  });
});
