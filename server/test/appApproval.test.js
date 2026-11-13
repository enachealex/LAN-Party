// Publish approval for the app directory: "anyone drafts, the instance owner publishes".
//
// Four layers: who the instance owner is (the helper on its own), what the migration does to apps
// that already exist, the HTTP surface (who may move an app between statuses, and who can see that
// an app exists at all), and the sockets (who may start an unapproved app in a room, what happens
// to a room when its app stops being startable, and who is told about a review).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { io } = require('socket.io-client');
const { zipSync, strToU8 } = require('fflate');
const { startServer, apiFor, makeUser, dbAll, PASSWORD } = require('./helpers');
const { migrate, MIGRATIONS } = require('../db/schema');
const { runMigrations } = require('../db/migrate');
const { createInstanceOwners, parseInstanceOwners } = require('../services/instanceOwners');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freshDb = () => open({ filename: ':memory:', driver: sqlite3.Database });
const STATUSES = ['draft', 'pending', 'published', 'rejected'];

// ---------------------------------------------------------------------------------------------
describe('instance owner rule', () => {
  const withUsers = async (...names) => {
    const db = await freshDb();
    await migrate(db);
    for (const n of names) await db.run('INSERT INTO users (username, email) VALUES (?, ?)', n, `${n}@example.com`);
    return db;
  };

  test('INSTANCE_OWNERS is split on commas; spaces, empty entries and repeats are dropped', () => {
    assert.deepEqual(parseInstanceOwners('ann,ben'), ['ann', 'ben']);
    assert.deepEqual(parseInstanceOwners('  ann ,, ben ,ann, '), ['ann', 'ben']);
    for (const empty of [undefined, null, '', '   ', ',', ' , ,, ']) assert.deepEqual(parseInstanceOwners(empty), []);
  });

  test('by default it is the oldest account, and only that one', async () => {
    const db = await withUsers('first', 'second', 'third');
    const o = createInstanceOwners({ db, env: {} });
    assert.deepEqual(await o.instanceOwners(), ['first']);
    assert.equal(await o.isInstanceOwner('first'), true);
    assert.equal(await o.isInstanceOwner('second'), false);
    assert.equal(await o.isInstanceOwner('third'), false);
    await db.close();
  });

  test('the default follows the account, not the name: a rename keeps it, a deletion passes it on', async () => {
    const db = await withUsers('first', 'second');
    const o = createInstanceOwners({ db, env: {} });
    await db.run("UPDATE users SET username = 'renamed' WHERE username = 'first'");
    assert.equal(await o.isInstanceOwner('renamed'), true);
    assert.equal(await o.isInstanceOwner('first'), false, 'the old name means nothing any more');
    await db.run("DELETE FROM users WHERE username = 'renamed'");
    assert.deepEqual(await o.instanceOwners(), ['second']);
    await db.close();
  });

  test('nobody is an owner of an instance with no accounts, and a missing name is never one', async () => {
    const db = await withUsers();
    const o = createInstanceOwners({ db, env: {} });
    assert.deepEqual(await o.instanceOwners(), []);
    for (const nobody of [undefined, null, '', 0, {}, ['first']]) assert.equal(await o.isInstanceOwner(/** @type {any} */ (nobody)), false);
    await db.close();
  });

  test('INSTANCE_OWNERS replaces the default entirely', async () => {
    const db = await withUsers('first', 'second', 'third');
    const o = createInstanceOwners({ db, env: { INSTANCE_OWNERS: ' third , ,second,' } });
    assert.deepEqual(await o.instanceOwners(), ['third', 'second']);
    assert.equal(await o.isInstanceOwner('third'), true);
    assert.equal(await o.isInstanceOwner('second'), true);
    assert.equal(await o.isInstanceOwner('first'), false, 'the oldest account is no longer an owner');
    await db.close();
  });

  test('an unknown name in INSTANCE_OWNERS matches nobody, and does not bring the default back', async () => {
    const db = await withUsers('first', 'second');
    const o = createInstanceOwners({ db, env: { INSTANCE_OWNERS: 'ghost' } });
    assert.equal(await o.isInstanceOwner('first'), false);
    assert.equal(await o.isInstanceOwner('second'), false);
    // Exact match: a different spelling of a real name is a different name.
    const cased = createInstanceOwners({ db, env: { INSTANCE_OWNERS: 'FIRST' } });
    assert.equal(await cased.isInstanceOwner('first'), false);
    await db.close();
  });

  test('a listed name is reserved in any spelling of its case; only the exact one holds the role', async () => {
    const db = await withUsers('first');
    const o = createInstanceOwners({ db, env: { INSTANCE_OWNERS: 'Boss, second-boss' } });
    for (const taken of ['Boss', 'boss', 'BOSS', 'second-boss', 'Second-Boss']) assert.equal(o.isReservedName(taken), true, taken);
    for (const free of ['first', 'bos', 'boss2', ' boss', '', undefined, null, 7, ['Boss']]) assert.equal(o.isReservedName(free), false, String(free));
    assert.equal(o.isListedName('Boss'), true);
    assert.equal(o.isListedName('boss'), false);
    assert.equal(o.isListedName(undefined), false);
    // With no list there is nothing to reserve: the default follows an account id, not a name.
    const plain = createInstanceOwners({ db, env: {} });
    assert.equal(plain.isReservedName('first'), false);
    assert.equal(plain.isListedName('first'), false);
    await db.close();
  });

  test('the boot check names every listed name that no account has, and says when only the case differs', async () => {
    const db = await withUsers('first', 'boss', 'second-boss');
    assert.deepEqual(await createInstanceOwners({ db, env: {} }).configProblems(), []);
    assert.deepEqual(await createInstanceOwners({ db, env: { INSTANCE_OWNERS: 'boss, second-boss' } }).configProblems(), []);
    const problems = await createInstanceOwners({ db, env: { INSTANCE_OWNERS: 'boss, Second-Boss, ghost' } }).configProblems();
    assert.equal(problems.length, 2);
    assert.match(problems[0], /"Second-Boss".*spelled "second-boss".*NOT an instance owner/);
    assert.match(problems[1], /"ghost".*no account has that name/);
    await db.close();
  });

  test('an INSTANCE_OWNERS that names nobody is the same as not setting it', async () => {
    const db = await withUsers('first', 'second');
    for (const blank of ['', '   ', ' , ,']) {
      const o = createInstanceOwners({ db, env: { INSTANCE_OWNERS: blank } });
      assert.deepEqual(await o.instanceOwners(), ['first']);
    }
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------
describe('migration 0011_app_publish_approval', () => {
  const before0011 = MIGRATIONS.filter((m) => m.name < '0011');
  // The production database as it stands before this ships: everything up to 0010, with apps in it.
  const oldDb = async () => {
    const db = await freshDb();
    await runMigrations(db, before0011);
    await db.run("INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind) VALUES ('Old Link', 'd', 'https://example.com/', '', 'ann', 1, 'link')");
    await db.run("INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind, bundle_dir) VALUES ('Old Bundle', '', '', '', 'ben', 2, 'bundle', 'abc-123')");
    // From before 0003 gave apps a kind: the column is NULL on rows like this one.
    await db.run("INSERT INTO apps (name, created_by, created_at) VALUES ('Older Still', 'ann', 0)");
    return db;
  };

  test('the migration is the next one after 0010', () => {
    assert.equal(MIGRATIONS[before0011.length].name, '0011_app_publish_approval');
    assert.equal(before0011.length, 10);
  });

  test('apps that already exist stay published, with their data untouched', async () => {
    const db = await oldDb();
    assert.ok(!(await db.all('PRAGMA table_info(apps)')).some((c) => c.name === 'status'), 'the old schema has no status');
    await migrate(db);
    const rows = await db.all('SELECT name, status, created_by, bundle_dir, review_note, reviewed_by, reviewed_at, submitted_at FROM apps ORDER BY created_at');
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [['Older Still', 'published'], ['Old Link', 'published'], ['Old Bundle', 'published']]);
    assert.equal(rows[2].bundle_dir, 'abc-123');
    assert.equal(rows[1].created_by, 'ann');
    for (const r of rows) assert.deepEqual([r.review_note, r.reviewed_by, r.reviewed_at, r.submitted_at], [null, null, null, null]);
    await db.close();
  });

  test('a row inserted without a status afterwards is a draft, not published', async () => {
    const db = await oldDb();
    await migrate(db);
    await db.run("INSERT INTO apps (name, created_by, created_at) VALUES ('Forgot', 'ann', 9)");
    assert.equal((await db.get("SELECT status FROM apps WHERE name = 'Forgot'")).status, 'draft');
    await db.close();
  });

  test('running it again cannot publish drafts made since', async () => {
    const db = await oldDb();
    await migrate(db);
    await db.run("INSERT INTO apps (name, created_by, created_at, status) VALUES ('New Draft', 'cara', 9, 'draft')");
    await db.run("INSERT INTO apps (name, created_by, created_at, status) VALUES ('Turned Down', 'cara', 10, 'rejected')");
    // A database that lost its migration record re-runs everything (see migrations.test.js).
    await db.exec('DROP TABLE schema_migrations');
    await migrate(db);
    assert.equal((await db.get("SELECT status FROM apps WHERE name = 'New Draft'")).status, 'draft');
    assert.equal((await db.get("SELECT status FROM apps WHERE name = 'Turned Down'")).status, 'rejected');
    assert.equal((await db.get("SELECT status FROM apps WHERE name = 'Old Link'")).status, 'published');
    await db.close();
  });

  test('a fresh database has the columns too', async () => {
    const db = await freshDb();
    await migrate(db);
    const cols = (await db.all('PRAGMA table_info(apps)')).map((c) => c.name);
    for (const c of ['status', 'review_note', 'reviewed_by', 'reviewed_at', 'submitted_at']) assert.ok(cols.includes(c), `apps.${c}`);
    await db.close();
  });
});

// ---------------------------------------------------------------------------------------------
// One server for the HTTP and socket tests. 'owner' registers first, so the default rule makes them
// the instance owner; 'dev' uploads; 'ben' is a stranger to every app here.
describe('app approval (server)', () => {
  let server, call, base, tokens;
  /** @type {any[]} */
  const openSockets = [];
  let serial = 0;

  const html = (text) => ({ bytes: strToU8(`<h1>${text}</h1>`), type: 'text/html', filename: 'index.html' });
  const bundleForm = (file, fields = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append('bundle', new Blob([file.bytes], { type: file.type }), file.filename);
    return fd;
  };
  const uploadBundle = async (who, text = 'v1') => {
    const res = await call('POST', '/apps/bundle', bundleForm(html(text), { name: `Bundle ${++serial}`, description: 'a test app' }), tokens[who]);
    assert.equal(res.status, 200);
    return res.data.app;
  };
  const addLink = async (who) => {
    const res = await call('POST', '/apps', { name: `Link ${++serial}`, url: 'https://example.com/app' }, tokens[who]);
    assert.equal(res.status, 200);
    return res.data.app;
  };
  const act = (who, id, action, body) => call('POST', `/apps/${id}/${action}`, body, tokens[who]);
  // What a reviewer's client sends to approve a plain link: the address it showed, and that it does
  // not run inside LAN Party. (Hosted apps are in hostedApps.test.js.)
  const linkReviewed = (app) => ({ url: app.url, embed: false });
  // Take one of dev's apps from draft to `status` along the real routes.
  // (Approving names what was reviewed: a bundle's files by its url, a link's address and `embed`.
  // A bundle has no `embed` to name, and one that is sent is not looked at.)
  const moveTo = async ({ id, url }, status) => {
    const ok = async (who, action, body) => { const r = await act(who, id, action, body); assert.equal(r.status, 200, `${action} -> ${JSON.stringify(r.data)}`); };
    if (status === 'pending') await ok('dev', 'submit');
    if (status === 'published') await ok('owner', 'approve', { url, embed: false });
    if (status === 'rejected') { await ok('dev', 'submit'); await ok('owner', 'reject', { note: 'needs work' }); }
  };
  const devApp = async (status, kind = 'link') => {
    const app = kind === 'bundle' ? await uploadBundle('dev') : await addLink('dev');
    await moveTo(app, status);
    return app;
  };
  const listFor = async (who) => (await call('GET', '/apps', undefined, tokens[who])).data.apps;
  const seenBy = async (who, id) => (await listFor(who)).find((a) => a.id === id);
  const statusOf = async (id) => (await dbAll(server.dataDir, 'SELECT status FROM apps WHERE id = ?', [id]))[0]?.status;
  const bundleDirs = () => fs.readdirSync(path.join(server.dataDir, 'app-bundles'));
  const dirOf = (app) => app.url.split('/')[2];

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
  const NOTICES = ['app:submitted', 'app:review-queue', 'app:reviewed'];
  // A signed-in socket (so it sits in its `user:<name>` room) that records every app notice and
  // activity update it gets; with a channelId it is also in that voice room.
  async function enter(name, channelId) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[name] } });
    openSockets.push(socket);
    await once(socket, 'connect');
    socket.updates = [];
    socket.notices = [];
    socket.on('activity:update', (a) => { socket.updates.push(a); socket.act = a; });
    for (const event of NOTICES) socket.on(event, (payload) => socket.notices.push({ event, payload }));
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
  const startApp = (socket, channelId, appId) => {
    const started = once(socket, 'activity:update', isApp);
    socket.emit('activity:start', { serverId: 'demo', channelId, type: 'app', appId });
    return started;
  };
  // A start the server must ignore. The built-in started right after it is handled later on the
  // same socket, so once that arrives the refused start has been worked through.
  const startRefused = async (socket, channelId, appId) => {
    const seen = socket.updates.length;
    socket.emit('activity:start', { serverId: 'demo', channelId, type: 'app', appId });
    await sleep(150); // the app start awaits two queries; let them finish before the marker goes in
    const marker = once(socket, 'activity:update', (v) => v != null && v.type === 'ttt');
    socket.emit('activity:start', { serverId: 'demo', channelId, type: 'ttt' });
    await marker;
    assert.ok(!socket.updates.slice(seen).some(isApp), 'the app must not have started');
  };

  before(async () => {
    server = await startServer({ env: { INSTANCE_OWNERS: '' } });
    base = server.base;
    call = apiFor(base);
    tokens = {};
    for (const name of ['owner', 'dev', 'ben']) tokens[name] = await makeUser(call, name);
  });
  after(async () => {
    for (const s of openSockets) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  // --- who is told they are an instance owner ---
  test('the client learns whether it is an instance owner from the server, everywhere it learns "me"', async () => {
    for (const [who, expected] of [['owner', true], ['dev', false], ['ben', false]]) {
      const login = await call('POST', '/auth/login', { username: who, password: 'Test123!pw' });
      assert.equal(login.data.user.instanceOwner, expected, `login as ${who}`);
      const me = await call('GET', '/auth/me', undefined, tokens[who]);
      assert.equal(me.data.user.instanceOwner, expected, `/auth/me as ${who}`);
      const sync = await call('GET', '/user/sync', undefined, tokens[who]);
      assert.equal(sync.data.instanceOwner, expected, `/user/sync as ${who}`);
      const apps = await call('GET', '/apps', undefined, tokens[who]);
      assert.equal(apps.data.instanceOwner, expected, `/apps as ${who}`);
    }
  });

  test('claiming to be an instance owner in a request changes nothing', async () => {
    const app = await devApp('draft');
    for (const body of [{ instanceOwner: true }, { user: { instanceOwner: true } }, { status: 'published' }]) {
      assert.equal((await act('dev', app.id, 'approve', body)).status, 403);
    }
    const edit = await call('PATCH', `/apps/${app.id}`, { name: 'Sneaky', status: 'published', instanceOwner: true }, tokens.dev);
    assert.equal(edit.status, 200);
    assert.equal(edit.data.app.status, 'draft');
    const link = await call('POST', '/apps', { name: 'Born Published?', url: 'https://example.com/', status: 'published' }, tokens.dev);
    assert.equal(link.data.app.status, 'draft');
  });

  // --- uploads ---
  test('a new upload is a draft; an instance owner\'s is published straight away', async () => {
    const devBundle = await uploadBundle('dev');
    const devLink = await addLink('dev');
    assert.equal(devBundle.status, 'draft');
    assert.equal(devLink.status, 'draft');
    assert.equal(devBundle.kind, 'bundle');
    assert.equal(devBundle.embeddable, true);
    assert.match(devBundle.url, /^\/app-bundles\/[^/]+\/$/);
    // The uploader can open their own draft: the files are served.
    const page = await fetch(base + devBundle.url);
    assert.equal(page.status, 200);
    await page.text();

    const ownBundle = await uploadBundle('owner');
    const ownLink = await addLink('owner');
    assert.equal(ownBundle.status, 'published');
    assert.equal(ownLink.status, 'published');
    assert.equal(await statusOf(devBundle.id), 'draft');
    assert.equal(await statusOf(ownBundle.id), 'published');
    // Nobody else's directory has the drafts; everyone's has the owner's.
    const bens = (await listFor('ben')).map((a) => a.id);
    assert.ok(!bens.includes(devBundle.id) && !bens.includes(devLink.id));
    assert.ok(bens.includes(ownBundle.id) && bens.includes(ownLink.id));
  });

  // --- visibility ---
  test('visibility: a stranger sees published apps only, the uploader their own, an instance owner everything', async () => {
    /** @type {Record<string, any>} */
    const apps = {};
    for (const status of STATUSES) apps[status] = await devApp(status);

    for (const status of STATUSES) {
      const id = apps[status].id;
      const stranger = await seenBy('ben', id);
      const uploader = await seenBy('dev', id);
      const owner = await seenBy('owner', id);

      assert.equal(!!stranger, status === 'published', `stranger and a ${status} app`);
      assert.equal(uploader.status, status);
      assert.equal(owner.status, status);
      // The review fields: for the uploader and the instance owner, never for anyone else.
      if (stranger) {
        assert.equal(stranger.status, 'published');
        for (const k of ['reviewNote', 'submittedAt', 'reviewedAt', 'reviewedBy']) assert.ok(!(k in stranger), `a stranger must not get ${k}`);
      }
      for (const k of ['reviewNote', 'submittedAt', 'reviewedAt']) {
        assert.ok(k in uploader, `the uploader gets ${k}`);
        assert.ok(k in owner, `an instance owner gets ${k}`);
      }
      assert.ok(!('reviewedBy' in uploader), 'which owner decided is not the uploader\'s to know');
      assert.ok('reviewedBy' in owner);
    }
    // What those fields hold.
    const draft = await seenBy('dev', apps.draft.id);
    assert.deepEqual([draft.reviewNote, draft.submittedAt, draft.reviewedAt], ['', null, null]);
    const pending = await seenBy('owner', apps.pending.id);
    assert.equal(typeof pending.submittedAt, 'number');
    assert.equal(pending.reviewedAt, null);
    const rejected = await seenBy('dev', apps.rejected.id);
    assert.equal(rejected.reviewNote, 'needs work');
    assert.equal(typeof rejected.reviewedAt, 'number');
    assert.equal((await seenBy('owner', apps.rejected.id)).reviewedBy, 'owner');
    assert.equal((await seenBy('owner', apps.published.id)).reviewedBy, 'owner');
    // A link's url is there in full for the reviewer.
    assert.equal(pending.url, 'https://example.com/app');
    assert.equal(pending.kind, 'link');
  });

  test('nobody else can learn that an unpublished app exists: every per-app route answers as for an unknown id', async () => {
    const UNKNOWN = 999_999;
    const routes = (id) => [
      ['PATCH', `/apps/${id}`, () => ({ name: 'x' })],
      ['POST', `/apps/${id}/submit`, () => ({})],
      ['POST', `/apps/${id}/withdraw`, () => ({})],
      ['POST', `/apps/${id}/approve`, () => ({})],
      ['POST', `/apps/${id}/reject`, () => ({ note: 'x' })],
      ['POST', `/apps/${id}/reject`, () => ({ note: 'x'.repeat(501) })], // not even a validation error
      ['POST', `/apps/${id}/unpublish`, () => ({})],
      ['PUT', `/apps/${id}/bundle`, () => bundleForm(html('x'))],
      ['PUT', `/apps/${id}/bundle`, () => undefined],
      ['DELETE', `/apps/${id}`, () => undefined],
    ];
    const answers = async (id) => {
      const out = [];
      for (const [method, route, body] of routes(id)) out.push(await call(method, route, body(), tokens.ben));
      return out;
    };
    const unknown = await answers(UNKNOWN);
    for (const r of unknown) assert.deepEqual(r, { status: 404, data: { error: 'App not found' } });
    const dirsBefore = bundleDirs().length;
    for (const status of ['draft', 'pending', 'rejected']) {
      for (const kind of ['link', 'bundle']) {
        const app = await devApp(status, kind);
        const dirs = bundleDirs().length;
        assert.deepEqual(await answers(app.id), unknown, `a ${status} ${kind} app must look like an unknown id`);
        assert.equal(await statusOf(app.id), status, 'and nothing happened to it');
        assert.equal(bundleDirs().length, dirs, 'no upload was stored');
      }
    }
    assert.equal(bundleDirs().length, dirsBefore + 3, 'only the three bundles this test uploaded');
    // A published app is known to exist, so there the same stranger is told "not yours" instead.
    const pub = await devApp('published');
    assert.equal((await call('DELETE', `/apps/${pub.id}`, undefined, tokens.ben)).status, 403);
    // Malformed ids are a 400 for everyone, which says nothing about any app.
    assert.equal((await call('DELETE', '/apps/abc', undefined, tokens.ben)).status, 400);
    assert.equal((await act('ben', 0, 'approve')).status, 400);
    // No token, no answer at all.
    assert.equal((await call('GET', '/apps')).status, 401);
    assert.equal((await call('POST', `/apps/${pub.id}/approve`)).status, 401);
  });

  // --- transitions ---
  test('the transition table: every action, from every status, by every kind of person', async () => {
    const RULES = {
      submit: { by: ['dev'], from: ['draft', 'rejected'], to: 'pending' },
      withdraw: { by: ['dev'], from: ['pending'], to: 'draft' },
      approve: { by: ['owner'], from: ['pending', 'draft', 'rejected'], to: 'published' },
      reject: { by: ['owner'], from: ['pending', 'published'], to: 'rejected' },
      unpublish: { by: ['dev', 'owner'], from: ['published'], to: 'draft' },
    };
    let checked = 0;
    for (const [action, rule] of Object.entries(RULES)) {
      for (const status of STATUSES) {
        for (const who of ['dev', 'owner', 'ben']) {
          const app = await devApp(status);
          // An approval names what was reviewed; nothing else does, or needs to.
          const res = await act(who, app.id, action, action === 'approve' ? linkReviewed(app) : undefined);
          const visible = status === 'published' || who !== 'ben';
          const expected = !visible ? 404 : !rule.by.includes(who) ? 403 : !rule.from.includes(status) ? 409 : 200;
          const label = `${action} of a ${status} app by ${who}`;
          assert.equal(res.status, expected, `${label}: ${JSON.stringify(res.data)}`);
          if (expected === 200) {
            assert.equal(res.data.success, true);
            assert.equal(res.data.app.status, rule.to, label);
            assert.equal(res.data.app.id, app.id);
            assert.ok(Array.isArray(res.data.apps));
            assert.equal(await statusOf(app.id), rule.to, label);
          } else {
            assert.ok(res.data.error, label);
            assert.equal(await statusOf(app.id), status, `${label} must leave it ${status}`);
          }
          checked += 1;
        }
      }
    }
    assert.equal(checked, 60);
    // An action that is not one of them is not a route.
    const app = await devApp('draft');
    assert.equal((await act('owner', app.id, 'publish')).status, 404);
    assert.equal(await statusOf(app.id), 'draft');
  });

  test('an instance owner is the uploader of their own apps too', async () => {
    const app = await addLink('owner');
    assert.equal(app.status, 'published');
    assert.equal((await act('owner', app.id, 'unpublish')).data.app.status, 'draft');
    assert.equal((await act('owner', app.id, 'submit')).data.app.status, 'pending');
    assert.equal((await act('owner', app.id, 'withdraw')).data.app.status, 'draft');
    assert.equal((await act('owner', app.id, 'approve', linkReviewed(app))).data.app.status, 'published');
  });

  test('the same transition asked twice works once', async () => {
    const app = await devApp('pending');
    const [a, b] = await Promise.all([act('owner', app.id, 'approve', linkReviewed(app)), act('owner', app.id, 'approve', linkReviewed(app))]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal(await statusOf(app.id), 'published');
  });

  test('approving a bundle names the files that were reviewed: a swapped bundle is never published by it', async () => {
    const app = await devApp('pending', 'bundle');
    // What the instance owner is shown, and opens to test.
    const reviewed = (await seenBy('owner', app.id)).url;
    assert.equal(reviewed, app.url);
    // An approval that does not say what was reviewed approves nothing.
    for (const body of [undefined, {}, { url: 7 }, { url: null }]) {
      assert.equal((await act('owner', app.id, 'approve', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(await statusOf(app.id), 'pending');

    // The uploader swaps the code while it is being looked at (the app drops back to draft, which
    // an instance owner may still publish directly).
    const swap = await call('PUT', `/apps/${app.id}/bundle`, bundleForm(html('unseen')), tokens.dev);
    assert.equal(swap.status, 200);
    const stale = await act('owner', app.id, 'approve', { url: reviewed });
    assert.equal(stale.status, 409, JSON.stringify(stale.data));
    assert.match(stale.data.error, /replaced since you opened it/);
    assert.equal(await statusOf(app.id), 'draft');

    // ...and submits it again: pending under the same name, as it was when the owner opened it.
    assert.equal((await act('dev', app.id, 'submit')).status, 200);
    assert.equal((await seenBy('owner', app.id)).name, app.name);
    for (const url of [reviewed, '/app-bundles/guess/', swap.data.app.url.slice(0, -1), '']) {
      assert.equal((await act('owner', app.id, 'approve', { url })).status, 409, url);
    }
    assert.equal(await statusOf(app.id), 'pending', 'the unseen files were not published');
    assert.ok(!(await seenBy('ben', app.id)));

    // Having opened the new files, the owner approves those.
    const current = (await seenBy('owner', app.id)).url;
    assert.equal(current, swap.data.app.url);
    const ok = await act('owner', app.id, 'approve', { url: current });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.app.status, 'published');
    assert.equal(ok.data.app.url, current);

    // A plain link names its address and `embed: false`, like the other kinds name theirs. (What
    // happens when its address is edited, or it is set to run inside LAN Party, is in
    // hostedApps.test.js.)
    const link = await devApp('pending');
    for (const body of [undefined, {}, { embed: false }, { url: 7, embed: false }, { url: link.url }]) {
      assert.equal((await act('owner', link.id, 'approve', body)).status, 400, JSON.stringify(body));
    }
    assert.equal(await statusOf(link.id), 'pending');
    assert.equal((await act('owner', link.id, 'approve', linkReviewed(link))).status, 200);
    // An instance owner publishing their own bundle is held to the same rule.
    const own = await uploadBundle('owner');
    await act('owner', own.id, 'unpublish');
    const replaced = await call('PUT', `/apps/${own.id}/bundle`, bundleForm(html('v2')), tokens.owner);
    assert.equal((await act('owner', own.id, 'approve', { url: own.url })).status, 409);
    assert.equal((await act('owner', own.id, 'approve', { url: replaced.data.app.url })).status, 200);
  });

  test('a rejection can carry a note of up to 500 characters, shown to the uploader until the next decision', async () => {
    const app = await devApp('pending');
    assert.equal((await act('owner', app.id, 'reject', { note: 'x'.repeat(501) })).status, 400);
    assert.equal((await act('owner', app.id, 'reject', { note: 42 })).status, 400);
    assert.equal((await act('owner', app.id, 'reject', { note: { text: 'no' } })).status, 400);
    assert.equal(await statusOf(app.id), 'pending', 'a refused note rejects nothing');

    const note = 'y'.repeat(500);
    const rejected = await act('owner', app.id, 'reject', { note: `  ${note}  ` });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.app.reviewNote, note, 'trimmed, and all 500 characters kept');
    assert.equal((await seenBy('dev', app.id)).reviewNote, note);

    // Resubmitting keeps it in view (it is what was asked for); approval clears it.
    assert.equal((await act('dev', app.id, 'submit')).data.app.reviewNote, note);
    assert.equal((await seenBy('owner', app.id)).reviewNote, note);
    assert.equal((await act('owner', app.id, 'approve', linkReviewed(app))).data.app.reviewNote, '');
    assert.equal((await seenBy('dev', app.id)).reviewNote, '');

    // No note, an empty one and null are all "no note"; a new rejection replaces the old note.
    for (const body of [undefined, {}, { note: '' }, { note: '   ' }, { note: null }]) {
      const other = await devApp('rejected');
      await act('dev', other.id, 'submit');
      const again = await act('owner', other.id, 'reject', body);
      assert.equal(again.status, 200);
      assert.equal(again.data.app.reviewNote, '', `note for body ${JSON.stringify(body)}`);
    }
  });

  // --- details ---
  test('the uploader can edit name, description and icon in any status, and the status does not move', async () => {
    for (const status of STATUSES) {
      const app = await devApp(status);
      const res = await call('PATCH', `/apps/${app.id}`, { name: `  Renamed ${status}  `, description: ' new words ', iconUrl: '/uploads/icon.png' }, tokens.dev);
      assert.equal(res.status, 200, status);
      assert.equal(res.data.app.name, `Renamed ${status}`);
      assert.equal(res.data.app.description, 'new words');
      assert.equal(res.data.app.iconUrl, '/uploads/icon.png');
      assert.equal(res.data.app.status, status);
      assert.equal(await statusOf(app.id), status);
    }
  });

  test('editing details: one field at a time, validated, and only by the uploader', async () => {
    const app = await devApp('published');
    const patch = (who, body) => call('PATCH', `/apps/${app.id}`, body, tokens[who]);
    // Fields that are not sent are left alone.
    await patch('dev', { name: 'Kept', description: 'kept too', iconUrl: '/uploads/a.png' });
    const one = await patch('dev', { description: 'only this' });
    assert.deepEqual([one.data.app.name, one.data.app.description, one.data.app.iconUrl], ['Kept', 'only this', '/uploads/a.png']);
    // An empty icon clears it; lengths are capped as on upload.
    assert.equal((await patch('dev', { iconUrl: '' })).data.app.iconUrl, '');
    const long = await patch('dev', { name: 'n'.repeat(200), description: 'd'.repeat(900) });
    assert.equal(long.data.app.name.length, 80);
    assert.equal(long.data.app.description.length, 500);

    for (const bad of [{}, { name: '' }, { name: '   ' }, { name: 7 }, { description: 7 }, { iconUrl: 'https://evil.example/x.png' }, { iconUrl: 7 }, { other: 'x' }]) {
      assert.equal((await patch('dev', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await seenBy('dev', app.id)).name.length, 80, 'refused edits changed nothing');

    // Not the uploader: an instance owner reviews, they do not rewrite; a stranger does neither.
    assert.equal((await patch('owner', { name: 'Owner Was Here' })).status, 403);
    assert.equal((await patch('ben', { name: 'Ben Was Here' })).status, 403);
    const draft = await devApp('draft');
    assert.equal((await call('PATCH', `/apps/${draft.id}`, { name: 'x' }, tokens.owner)).status, 403);
    assert.equal((await call('PATCH', `/apps/${draft.id}`, { name: 'x' }, tokens.ben)).status, 404);
  });

  // --- bundle replace ---
  test('replacing a bundle serves the new files from a new path, removes the old ones, and resets to draft', async () => {
    for (const status of STATUSES) {
      const app = await devApp(status, 'bundle');
      const oldDir = dirOf(app);
      const zip = Buffer.from(zipSync({ 'index.html': strToU8('<h1>v2</h1><script src="app.js"></script>'), 'app.js': strToU8('window.V=2') }));
      const res = await call('PUT', `/apps/${app.id}/bundle`, bundleForm({ bytes: zip, type: 'application/zip', filename: 'v2.zip' }), tokens.dev);
      assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.data)}`);
      assert.equal(res.data.app.status, 'draft', `a ${status} app goes back to draft`);
      assert.equal(await statusOf(app.id), 'draft');
      assert.notEqual(res.data.app.url, app.url, 'the served path changes');
      assert.match(res.data.app.url, /^\/app-bundles\/[^/]+\/$/);
      // New files at the new path...
      const page = await fetch(base + res.data.app.url);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /v2/);
      const asset = await fetch(base + res.data.app.url + 'app.js');
      assert.equal(asset.status, 200);
      await asset.text();
      // ...and nothing left at the old one, on the wire or on disk.
      const gone = await fetch(base + app.url);
      assert.equal(gone.status, 404);
      await gone.text();
      assert.ok(!bundleDirs().includes(oldDir), 'old folder removed');
      assert.ok(bundleDirs().includes(dirOf(res.data.app)));
      // Name, description and id are the app's, not the upload's.
      assert.equal(res.data.app.id, app.id);
      assert.equal(res.data.app.name, app.name);
      if (status === 'published') assert.ok(!(await seenBy('ben', app.id)), 'no longer in anyone else\'s directory');
    }
  });

  test('a replacement that fails validation leaves the old bundle and the status exactly as they were', async () => {
    const app = await devApp('published', 'bundle');
    const dirs = bundleDirs().sort();
    const put = (file) => call('PUT', `/apps/${app.id}/bundle`, file ? bundleForm(file) : new FormData(), tokens.dev);
    const noIndex = Buffer.from(zipSync({ 'main.js': strToU8('x') }));
    const slip = Buffer.from(zipSync({ 'index.html': strToU8('<h1>x</h1>'), '../escape.txt': strToU8('x') }));
    const failures = [
      [{ bytes: noIndex, type: 'application/zip', filename: 'a.zip' }, 400],
      [{ bytes: slip, type: 'application/zip', filename: 'a.zip' }, 400],
      [{ bytes: strToU8('not a zip'), type: 'application/zip', filename: 'a.zip' }, 400],
      [{ bytes: strToU8('hello'), type: 'text/plain', filename: 'a.txt' }, 400],
      [{ bytes: new Uint8Array(15 * 1024 * 1024 + 1), type: 'text/html', filename: 'big.html' }, 413],
      [null, 400], // no file at all
    ];
    for (const [file, expected] of failures) {
      const res = await put(file);
      assert.equal(res.status, expected, JSON.stringify(res.data));
      assert.ok(res.data.error);
    }
    assert.equal(await statusOf(app.id), 'published');
    assert.deepEqual(bundleDirs().sort(), dirs, 'no folder added, none removed');
    const page = await fetch(base + app.url);
    assert.equal(page.status, 200, 'the old bundle is still served');
    assert.match(await page.text(), /v1/);
    assert.equal((await seenBy('ben', app.id)).url, app.url);
  });

  test('replacing a bundle: only the uploader, only a bundle; an instance owner\'s own app keeps its status', async () => {
    const app = await devApp('published', 'bundle');
    const put = (who, id) => call('PUT', `/apps/${id}/bundle`, bundleForm(html('theirs')), tokens[who]);
    assert.equal((await put('ben', app.id)).status, 403);
    assert.equal((await put('owner', app.id)).status, 403, 'an instance owner cannot swap someone else\'s code');
    const still = await fetch(base + app.url);
    assert.match(await still.text(), /v1/);
    assert.equal(await statusOf(app.id), 'published');

    const link = await devApp('draft');
    assert.equal((await put('dev', link.id)).status, 400);

    const own = await uploadBundle('owner');
    const res = await put('owner', own.id);
    assert.equal(res.status, 200);
    assert.equal(res.data.app.status, 'published', 'nobody else to ask');
    assert.notEqual(res.data.app.url, own.url);
    const old = await fetch(base + own.url);
    assert.equal(old.status, 404);
    await old.text();
    // Their own unpublished app stays unpublished rather than being published by a replace.
    await act('owner', own.id, 'unpublish');
    assert.equal((await put('owner', own.id)).data.app.status, 'draft');
  });

  // --- delete ---
  test('delete: the uploader or an instance owner, and the files go with it', async () => {
    const mine = await devApp('published', 'bundle');
    assert.equal((await call('DELETE', `/apps/${mine.id}`, undefined, tokens.ben)).status, 403);
    assert.equal(await statusOf(mine.id), 'published');
    const del = await call('DELETE', `/apps/${mine.id}`, undefined, tokens.dev);
    assert.equal(del.status, 200);
    assert.ok(!del.data.apps.some((a) => a.id === mine.id));
    assert.ok(!bundleDirs().includes(dirOf(mine)));
    assert.equal((await call('DELETE', `/apps/${mine.id}`, undefined, tokens.dev)).status, 404);

    for (const status of STATUSES) {
      const theirs = await devApp(status, 'bundle');
      const byOwner = await call('DELETE', `/apps/${theirs.id}`, undefined, tokens.owner);
      assert.equal(byOwner.status, 200, `an instance owner deleting a ${status} app`);
      assert.equal(await statusOf(theirs.id), undefined);
      assert.ok(!bundleDirs().includes(dirOf(theirs)));
      const gone = await fetch(base + theirs.url);
      assert.equal(gone.status, 404);
      await gone.text();
    }
  });

  // --- starting in a room ---
  test('activity:start: a published app is anyone\'s to start, and is marked approved', async () => {
    const app = await devApp('published', 'bundle');
    for (const who of ['ben', 'dev', 'owner']) {
      const socket = await enter(who, `v-pub-${who}`);
      const started = await startApp(socket, `v-pub-${who}`, app.id);
      assert.equal(started.state.appId, app.id);
      assert.equal(started.state.approved, true);
      assert.equal(started.by, who);
    }
  });

  test('activity:start: a draft or pending app starts for its uploader and for an instance owner, marked NOT approved', async () => {
    for (const status of ['draft', 'pending']) {
      const app = await devApp(status, 'bundle');
      const room = `v-${status}`;
      const dev = await enter('dev', room);
      const ben = await enter('ben', room);
      // Ben is in the room: he gets the join card, and it says the app is not approved.
      const card = once(ben, 'activity:update', isApp);
      const started = await startApp(dev, room, app.id);
      assert.equal(started.state.approved, false, status);
      assert.equal(started.state.createdBy, 'dev');
      assert.deepEqual(started.state.joined, ['dev']);
      const seen = await card;
      assert.equal(seen.state.approved, false, 'the people asked to join are told');
      assert.equal(seen.state.name, app.name);
      assert.deepEqual(seen.state.shared, {}, 'and get nothing from it until they choose to join');
      // He may join if he wants to: that is his choice to make.
      const joined = await new Promise((resolve) => ben.emit('activity:event', { serverId: 'demo', channelId: room, app: seen.state.run, event: { kind: 'join' } }, resolve));
      assert.equal(joined.ok, true);
      assert.equal(ben.act.state.approved, false);

      // An instance owner can start it as well (to review it in a room).
      const owner = await enter('owner', `${room}-owner`);
      assert.equal((await startApp(owner, `${room}-owner`, app.id)).state.approved, false);

      // Anyone else cannot, even from a room of their own.
      const alone = await enter('ben', `${room}-ben`);
      await startRefused(alone, `${room}-ben`, app.id);
      // And being in the room where it runs does not make it his to restart.
      await startRefused(ben, room, app.id);
    }
  });

  test('activity:start: a rejected app starts for nobody', async () => {
    const app = await devApp('rejected', 'bundle');
    for (const who of ['dev', 'owner', 'ben']) {
      const socket = await enter(who, `v-rej-${who}`);
      await startRefused(socket, `v-rej-${who}`, app.id);
    }
    // "Nobody" lasts as long as the status does, and no longer: rejected is not a ban. Once the
    // uploader has resubmitted it, it is pending again and theirs to run...
    await act('dev', app.id, 'submit');
    const dev = await enter('dev', 'v-rej-again');
    assert.equal((await startApp(dev, 'v-rej-again', app.id)).state.approved, false);
    // ...withdrawn, it is a draft like any other...
    assert.equal((await act('dev', app.id, 'withdraw')).data.app.status, 'draft');
    assert.equal((await startApp(dev, 'v-rej-again', app.id)).state.approved, false);
    // ...and so is a rejected app whose bundle was replaced. Still nobody else's to start.
    const other = await devApp('rejected', 'bundle');
    assert.equal((await call('PUT', `/apps/${other.id}/bundle`, bundleForm(html('v2')), tokens.dev)).data.app.status, 'draft');
    assert.equal((await startApp(dev, 'v-rej-again', other.id)).state.approved, false);
    const ben = await enter('ben', 'v-rej-ben');
    await startRefused(ben, 'v-rej-ben', app.id);
    await startRefused(ben, 'v-rej-ben', other.id);
  });

  test('a signed-out socket cannot start an unapproved app, whatever name it gives', async () => {
    const app = await devApp('draft', 'bundle');
    const anon = io(base, { transports: ['websocket'], forceNew: true });
    openSockets.push(anon);
    await once(anon, 'connect');
    anon.updates = [];
    anon.on('activity:update', (a) => anon.updates.push(a));
    anon.emit('join', { serverId: 'demo', name: 'dev' });
    anon.emit('voice:join', { serverId: 'demo', channelId: 'v-anon' });
    anon.emit('activity:start', { serverId: 'demo', channelId: 'v-anon', type: 'app', appId: app.id });
    await sleep(300);
    assert.ok(!anon.updates.some(isApp));
  });

  // --- a running app that stops being startable ---
  test('a running app is ended in its rooms when it is rejected, unpublished, replaced or deleted', async () => {
    const endings = {
      'rejected while pending': { from: 'pending', starter: 'dev', end: (app) => act('owner', app.id, 'reject', { note: 'no' }) },
      'rejected while published': { from: 'published', starter: 'ben', end: (app) => act('owner', app.id, 'reject') },
      'unpublished by an instance owner': { from: 'published', starter: 'ben', end: (app) => act('owner', app.id, 'unpublish') },
      'unpublished by its uploader': { from: 'published', starter: 'ben', end: (app) => act('dev', app.id, 'unpublish') },
      'bundle replaced': { from: 'published', starter: 'ben', end: (app) => call('PUT', `/apps/${app.id}/bundle`, bundleForm(html('v2')), tokens.dev) },
      'draft bundle replaced': { from: 'draft', starter: 'dev', end: (app) => call('PUT', `/apps/${app.id}/bundle`, bundleForm(html('v2')), tokens.dev) },
      'deleted by an instance owner': { from: 'pending', starter: 'dev', end: (app) => call('DELETE', `/apps/${app.id}`, undefined, tokens.owner) },
    };
    let n = 0;
    for (const [label, { from, starter, end }] of Object.entries(endings)) {
      const app = await devApp(from, 'bundle');
      const other = await devApp('published', 'bundle');
      const room = `v-end-${++n}`;
      const starterSocket = await enter(starter, room);
      const watcher = await enter(starter === 'ben' ? 'dev' : 'ben', room);
      const bystander = await enter('ben', `${room}-other`);
      await startApp(starterSocket, room, app.id);
      await startApp(bystander, `${room}-other`, other.id);
      const ended = [once(starterSocket, 'activity:update', (v) => v === null), once(watcher, 'activity:update', (v) => v === null)];
      const res = await end(app);
      assert.equal(res.status, 200, `${label}: ${JSON.stringify(res.data)}`);
      await Promise.all(ended);
      assert.equal(starterSocket.act, null, label);
      assert.equal(watcher.act, null, label);
      await sleep(100);
      assert.equal(bystander.act.state.appId, other.id, `${label}: a room running a different app is left alone`);
    }
  });

  test('an instance owner replacing their own published app still ends the rooms on the old files', async () => {
    const app = await uploadBundle('owner');
    const ben = await enter('ben', 'v-own-replace');
    await startApp(ben, 'v-own-replace', app.id);
    const ended = once(ben, 'activity:update', (v) => v === null);
    const res = await call('PUT', `/apps/${app.id}/bundle`, bundleForm(html('v2')), tokens.owner);
    assert.equal(res.data.app.status, 'published');
    await ended;
    // Started again, it runs from the new path.
    assert.equal((await startApp(ben, 'v-own-replace', app.id)).state.url, res.data.app.url);
  });

  test('withdrawing leaves the uploader\'s room running; approving one in flight clears the warning', async () => {
    const app = await devApp('pending', 'bundle');
    const dev = await enter('dev', 'v-flight');
    const ben = await enter('ben', 'v-flight');
    const first = await startApp(dev, 'v-flight', app.id);
    assert.equal((await act('dev', app.id, 'withdraw')).status, 200);
    await sleep(150);
    assert.equal(dev.act.state.run, first.state.run, 'still the same run');
    assert.equal(dev.act.state.approved, false);

    const approvedForDev = once(dev, 'activity:update', (v) => isApp(v) && v.state.approved === true);
    const approvedForBen = once(ben, 'activity:update', (v) => isApp(v) && v.state.approved === true);
    assert.equal((await act('owner', app.id, 'approve', { url: app.url })).status, 200);
    const [d, b] = await Promise.all([approvedForDev, approvedForBen]);
    assert.equal(d.state.run, first.state.run, 'the run goes on');
    assert.deepEqual(d.state.joined, ['dev']);
    assert.deepEqual(b.state.shared, {}, 'someone who has not joined still gets only the card');
  });

  // --- notifications ---
  test('notifications reach the people they are for, and carry id, name and status only', async () => {
    const owner = await enter('owner');
    const dev = await enter('dev');
    const ben = await enter('ben');
    const all = [owner, dev, ben];
    const reset = () => { for (const s of all) s.notices = []; };
    // Each step: the action, then what each socket must have been told (and nothing else).
    const settle = async (expected) => {
      await sleep(200);
      for (const [name, socket] of [['owner', owner], ['dev', dev], ['ben', ben]]) {
        assert.deepEqual(socket.notices, expected[name] || [], `what ${name} was told`);
      }
      reset();
    };
    const app = await addLink('dev');
    const note = (event, status) => ({ event, payload: { id: app.id, name: app.name, status } });
    await settle({}); // a new draft is nobody's news

    await act('dev', app.id, 'submit');
    await settle({ owner: [note('app:submitted', 'pending')] });

    await act('dev', app.id, 'withdraw');
    await settle({ owner: [note('app:review-queue', 'draft')] });

    await act('dev', app.id, 'submit');
    await settle({ owner: [note('app:submitted', 'pending')] });

    await act('owner', app.id, 'reject', { note: 'private words for the uploader, read from GET /apps' });
    await settle({ owner: [note('app:review-queue', 'rejected')], dev: [note('app:reviewed', 'rejected')] });

    await act('dev', app.id, 'submit');
    await settle({ owner: [note('app:submitted', 'pending')] });

    await act('owner', app.id, 'approve', linkReviewed(app));
    await settle({ owner: [note('app:review-queue', 'published')], dev: [note('app:reviewed', 'published')] });

    // Unpublished by its uploader: their own doing, so only the owners' lists hear of it.
    await act('dev', app.id, 'unpublish');
    await settle({ owner: [note('app:review-queue', 'draft')] });

    // Published straight from draft, then unpublished by the instance owner: the uploader is told.
    await act('owner', app.id, 'approve', linkReviewed(app));
    await settle({ owner: [note('app:review-queue', 'published')], dev: [note('app:reviewed', 'published')] });
    await act('owner', app.id, 'unpublish');
    await settle({ owner: [note('app:review-queue', 'draft')], dev: [note('app:reviewed', 'draft')] });

    // Refused requests tell nobody anything.
    await act('ben', app.id, 'approve');
    await act('dev', app.id, 'approve');
    await act('owner', app.id, 'reject'); // a draft cannot be rejected
    await act('dev', app.id, 'withdraw');
    await call('PATCH', `/apps/${app.id}`, { description: 'edited' }, tokens.dev); // details are not a review event
    await settle({});

    await call('DELETE', `/apps/${app.id}`, undefined, tokens.owner);
    await settle({ owner: [note('app:review-queue', 'deleted')], dev: [note('app:reviewed', 'deleted')] });

    // An instance owner's own apps: their lists update, but they are not "told" about themselves.
    const own = await addLink('owner');
    await act('owner', own.id, 'unpublish');
    await act('owner', own.id, 'approve', linkReviewed(own));
    await settle({ owner: [
      { event: 'app:review-queue', payload: { id: own.id, name: own.name, status: 'draft' } },
      { event: 'app:review-queue', payload: { id: own.id, name: own.name, status: 'published' } },
    ] });
  });

  test('a pending bundle that is replaced leaves the review queue, and the owners hear of it', async () => {
    const owner = await enter('owner');
    const app = await devApp('pending', 'bundle');
    await sleep(150);
    owner.notices = [];
    await call('PUT', `/apps/${app.id}/bundle`, bundleForm(html('v2')), tokens.dev);
    await sleep(200);
    assert.deepEqual(owner.notices, [{ event: 'app:review-queue', payload: { id: app.id, name: app.name, status: 'draft' } }]);
  });

  test('a rename carries the uploader\'s apps and the reviewer\'s name along', async () => {
    const app = await devApp('published');
    assert.equal((await seenBy('owner', app.id)).reviewedBy, 'owner');
    // dev renames: the app is still theirs, in whatever status.
    const draft = await devApp('draft');
    const renamed = await call('POST', '/user/username', { username: 'dev2' }, tokens.dev);
    assert.equal(renamed.status, 200);
    const mine = (await call('GET', '/apps', undefined, renamed.data.token)).data.apps;
    assert.equal(mine.find((a) => a.id === draft.id).status, 'draft');
    assert.equal((await call('POST', `/apps/${draft.id}/submit`, undefined, renamed.data.token)).status, 200);
    // The instance owner renames: still the oldest account, so still the owner, and the decisions
    // they made are still shown as theirs.
    const boss = await call('POST', '/user/username', { username: 'owner2' }, tokens.owner);
    assert.equal(boss.status, 200);
    const all = await call('GET', '/apps', undefined, boss.data.token);
    assert.equal(all.data.instanceOwner, true);
    assert.equal(all.data.apps.find((a) => a.id === app.id).reviewedBy, 'owner2');
    assert.equal((await call('POST', `/apps/${draft.id}/approve`, { url: draft.url, embed: false }, boss.data.token)).status, 200);
    // Back again, so the rest of the file (and its tokens) keep working whatever order tests run in.
    tokens.dev = (await call('POST', '/user/username', { username: 'dev' }, renamed.data.token)).data.token;
    tokens.owner = (await call('POST', '/user/username', { username: 'owner' }, boss.data.token)).data.token;
  });
});

// ---------------------------------------------------------------------------------------------
describe('app approval with INSTANCE_OWNERS set', () => {
  let server, call, tokens;
  /** @type {any[]} */
  const openSockets = [];

  const html = (text) => { const fd = new FormData(); fd.append('name', `Bundle ${text}`); fd.append('bundle', new Blob([strToU8(`<h1>${text}</h1>`)], { type: 'text/html' }), 'index.html'); return fd; };
  const register = (username) => call('POST', '/auth/register', { username, email: `${username.toLowerCase()}-x@example.com`, password: PASSWORD, passwordConfirm: PASSWORD });
  const rename = (who, username) => call('POST', '/user/username', { username }, tokens[who]);
  const isOwner = async (token) => (await call('GET', '/apps', undefined, token)).data.instanceOwner;

  before(async () => {
    // A listed name cannot be registered, so the accounts are made first, on a server with no
    // list, and the list arrives with a restart — the order an operator has to follow too.
    const setup = await startServer({ env: { INSTANCE_OWNERS: '' } });
    const setupCall = apiFor(setup.base);
    tokens = {};
    for (const name of ['first', 'boss', 'second-boss', 'dev']) tokens[name] = await makeUser(setupCall, name);
    await setup.stop({ keepData: true });
    // Spaces, an empty entry and a name nobody has registered.
    server = await startServer({ dataDir: setup.dataDir, env: { INSTANCE_OWNERS: ' boss , ,ghost, second-boss' } });
    call = apiFor(server.base);
  });
  after(async () => {
    for (const s of openSockets) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('the named accounts are the owners; the oldest account is not', async () => {
    for (const [who, expected] of [['first', false], ['boss', true], ['second-boss', true], ['dev', false]]) {
      assert.equal((await call('GET', '/auth/me', undefined, tokens[who])).data.user.instanceOwner, expected, who);
      assert.equal((await call('GET', '/apps', undefined, tokens[who])).data.instanceOwner, expected, who);
    }
    const byFirst = await call('POST', '/apps', { name: 'From The Oldest', url: 'https://example.com/' }, tokens.first);
    assert.equal(byFirst.data.app.status, 'draft');
    const byBoss = await call('POST', '/apps', { name: 'From A Boss', url: 'https://example.com/' }, tokens.boss);
    assert.equal(byBoss.data.app.status, 'published');

    assert.equal((await call('POST', `/apps/${byFirst.data.app.id}/approve`, undefined, tokens.first)).status, 403);
    assert.equal((await call('POST', `/apps/${byFirst.data.app.id}/approve`, { url: 'https://example.com/', embed: false }, tokens['second-boss'])).status, 200);
  });

  test('a listed name cannot be taken: not registered, not renamed into, in any spelling of its case', async () => {
    assert.match(server.log(), /INSTANCE_OWNERS lists "ghost", and no account has that name/);
    assert.doesNotMatch(server.log(), /INSTANCE_OWNERS lists "boss"/);
    // The listed name nobody has, and case variants of the ones somebody does.
    for (const name of ['ghost', 'Ghost', 'Boss', 'SECOND-BOSS']) {
      const res = await register(name);
      assert.deepEqual([res.status, res.data], [409, { error: 'Username already exists', field: 'username' }], name);
      assert.deepEqual((await call('POST', '/auth/check-availability', { username: name })).data, { username: false }, name);
      assert.equal((await call('POST', '/auth/login', { username: name, password: PASSWORD })).status, 401, `${name} must not exist`);
      const renamed = await rename('dev', name);
      assert.deepEqual([renamed.status, renamed.data], [409, { error: 'Username already taken' }], name);
    }
    assert.equal(await isOwner(tokens.dev), false);
    assert.deepEqual((await dbAll(server.dataDir, 'SELECT username FROM users ORDER BY id')).map((u) => u.username), ['first', 'boss', 'second-boss', 'dev']);
    // Names that are not listed are as available as ever.
    assert.deepEqual((await call('POST', '/auth/check-availability', { username: 'ghostly' })).data.username, true);
    assert.equal((await register('ghostly')).status, 200);
    const moved = await rename('dev', 'dev-two');
    assert.equal(moved.status, 200);
    assert.equal(await isOwner(moved.data.token), false);
    tokens.dev = (await call('POST', '/user/username', { username: 'dev' }, moved.data.token)).data.token;
  });

  test('an owner named in the list cannot rename away from the name that makes them one', async () => {
    const res = await rename('boss', 'boss-renamed');
    assert.equal(res.status, 409);
    assert.match(res.data.error, /INSTANCE_OWNERS/);
    assert.equal(await isOwner(tokens.boss), true, 'still boss, still an owner');
    // So the name is never left free for someone else to take the role with.
    assert.equal((await rename('dev', 'boss')).status, 409);
    assert.equal(await isOwner(tokens.dev), false);
    // The oldest account is not an owner here, and renames as anyone does.
    const first = await rename('first', 'first-two');
    assert.equal(first.status, 200);
    tokens.first = (await call('POST', '/user/username', { username: 'first' }, first.data.token)).data.token;
  });

  test('an owner replacing their own bundle never undoes another owner\'s rejection of it', async () => {
    // The two requests race on purpose. Whichever way they interleave, the rejection that was
    // answered "rejected" has to be what the app is afterwards.
    for (let round = 0; round < 6; round += 1) {
      const app = (await call('POST', '/apps/bundle', html(`race ${round}`), tokens.boss)).data.app;
      assert.equal(app.status, 'published');
      const [replaced, rejected] = await Promise.all([
        call('PUT', `/apps/${app.id}/bundle`, html('v2'), tokens.boss),
        call('POST', `/apps/${app.id}/reject`, { note: 'no' }, tokens['second-boss']),
      ]);
      assert.equal(replaced.status, 200, JSON.stringify(replaced.data));
      assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
      const [row] = await dbAll(server.dataDir, 'SELECT status, review_note FROM apps WHERE id = ?', [app.id]);
      assert.deepEqual([row.status, row.review_note], ['rejected', 'no'], `round ${round}`);
    }
    // One at a time: the replace leaves a status it did not set exactly as it found it.
    const app = (await call('POST', '/apps/bundle', html('calm'), tokens.boss)).data.app;
    await call('POST', `/apps/${app.id}/reject`, undefined, tokens['second-boss']);
    const after = await call('PUT', `/apps/${app.id}/bundle`, html('v2'), tokens.boss);
    assert.equal(after.data.app.status, 'rejected');
    assert.notEqual(after.data.app.url, app.url);
  });

  test('every named owner is notified of a submission, and nobody else', async () => {
    const connect = async (name) => {
      const socket = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[name] } });
      openSockets.push(socket);
      await new Promise((resolve) => socket.once('connect', resolve));
      socket.notices = [];
      for (const event of ['app:submitted', 'app:review-queue', 'app:reviewed']) socket.on(event, (payload) => socket.notices.push({ event, payload }));
      const joined = new Promise((resolve) => socket.once('channel:joined', resolve));
      socket.emit('join', { serverId: 'demo', name });
      await joined;
      return socket;
    };
    const sockets = {};
    for (const name of ['first', 'boss', 'second-boss', 'dev']) sockets[name] = await connect(name);
    const app = (await call('POST', '/apps', { name: 'Needs Eyes', url: 'https://example.com/' }, tokens.dev)).data.app;
    await call('POST', `/apps/${app.id}/submit`, undefined, tokens.dev);
    await sleep(250);
    const submitted = [{ event: 'app:submitted', payload: { id: app.id, name: 'Needs Eyes', status: 'pending' } }];
    assert.deepEqual(sockets.boss.notices, submitted);
    assert.deepEqual(sockets['second-boss'].notices, submitted);
    assert.deepEqual(sockets.first.notices, [], 'the oldest account is not an owner here');
    assert.deepEqual(sockets.dev.notices, []);
  });
});
