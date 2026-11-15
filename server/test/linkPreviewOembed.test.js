// Link previews for YouTube links, which come from YouTube's oEmbed endpoint rather than from the
// watch page (services/linkPreview.js, OEMBED_PROVIDERS): a watch page is ~1.5 MB with its title
// past the 512 KB that is read of any page, so the page route finds nothing.
//
// NOTHING HERE TOUCHES THE NETWORK: "DNS" and "HTTP" are two tables in this file (fakeNet), handed
// to the fetcher in place of the real ones, as in linkPreview.test.js. The oEmbed request goes
// through the same fetcher as a page does, so what is checked here is that it is held to the same
// rules, and that nothing in the JSON is believed.
const { test, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { migrate } = require('../db/schema');
const { createLinkPreviews, oembedFor, previewLinkOf, MAX_JSON_BYTES, MAX_HTML_BYTES, TITLE_MAX, USER_AGENT } = require('../services/linkPreview');

const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '151.101.1.69';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(32, 3)]);
const ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;
const oembedUrl = (id = ID) => `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`;
const THUMB = `https://i.ytimg.com/vi/${ID}/hqdefault.jpg`;
const json = (body, extra = {}) => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra });
const ANSWER = { title: 'Never Gonna Give You Up', author_name: 'Rick Astley', author_url: 'https://www.youtube.com/@RickAstleyYT', type: 'video', provider_name: 'YouTube', provider_url: 'https://www.youtube.com/', thumbnail_url: THUMB, html: '<iframe src="https://www.youtube.com/embed/x"></iframe>' };

function fakeNet({ hosts = {}, pages = {} } = {}) {
  const log = [];
  const resolve = async (hostname) => {
    log.push({ kind: 'resolve', hostname });
    const answer = hosts[hostname];
    if (!answer) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return answer.map((address) => ({ address, family: net.isIP(address) }));
  };
  const request = async (req) => {
    const url = `${req.protocol}//${req.hostname}${req.path}`;
    const entry = { kind: 'request', url, hostname: req.hostname, address: req.address, port: req.port, headers: req.headers, bytesRead: 0 };
    log.push(entry);
    const found = pages[url] || { status: 404, headers: { 'content-type': 'text/html' }, body: '' };
    const bytes = Buffer.isBuffer(found.body) ? found.body : Buffer.from(found.body || '');
    return {
      status: found.status || 200,
      headers: found.headers || {},
      body: (async function* chunks() { for (let i = 0; i < bytes.length; i += 16384) { entry.bytesRead += Math.min(16384, bytes.length - i); yield bytes.subarray(i, i + 16384); } }()),
      destroy() {},
    };
  };
  return { resolve, request, log, requests: () => log.filter((e) => e.kind === 'request'), lookups: () => log.filter((e) => e.kind === 'resolve') };
}

const tmpDirs = [];
const dbs = [];
async function service(fake, env = {}) {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await migrate(db);
  dbs.push(db);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanparty-oembed-'));
  tmpDirs.push(dataDir);
  const lines = [];
  const add = (...a) => lines.push(a.map(String).join(' '));
  const previews = createLinkPreviews({ db, dataDir, env, resolve: fake.resolve, request: fake.request, timeoutMs: 2000, log: { log: add, warn: add } });
  return { previews, db, dataDir, lines };
}
after(async () => {
  for (const db of dbs) { try { await db.close(); } catch (_) { /* already closed */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
});

const youtube = (pages = {}, hosts = {}) => fakeNet({
  hosts: { 'www.youtube.com': [PUBLIC_A], 'youtu.be': [PUBLIC_A], 'm.youtube.com': [PUBLIC_A], 'music.youtube.com': [PUBLIC_A], 'youtube.com': [PUBLIC_A], 'i.ytimg.com': [PUBLIC_B], ...hosts },
  pages: { [oembedUrl()]: json(ANSWER), [THUMB]: { headers: { 'content-type': 'image/jpeg' }, body: JPEG }, ...pages },
});
async function refused(promise, reason) {
  await assert.rejects(promise, (err) => { assert.equal(err.name, 'Refusal'); assert.equal(err.reason, reason); return true; });
}
const normal = (text) => previewLinkOf(text);

describe('link previews: YouTube links use oEmbed', () => {
  test('every shape of YouTube link maps to one oEmbed request about the canonical watch address', () => {
    const shapes = [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=${ID}&t=42s&list=PL123&feature=share`,
      `https://www.youtube.com/watch?feature=share&v=${ID}`,
      `http://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}&si=abc`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?t=10&si=xyz`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://youtube.com/shorts/${ID}/`,
      `https://m.youtube.com/shorts/${ID}?feature=share`,
      `https://WWW.YouTube.com/watch?v=${ID}#t=5`,
    ];
    for (const posted of shapes) {
      const href = normal(posted);
      assert.ok(href, posted);
      assert.deepEqual(oembedFor(href), { siteName: 'YouTube', oembed: oembedUrl() }, posted);
    }
    assert.equal(oembedUrl(), 'https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ&format=json');
    // An id that cannot be a video id: recognised as YouTube's, and nothing to ask about. Whatever
    // was written there never reaches the oEmbed address.
    for (const posted of [
      'https://www.youtube.com/watch?v=short', `https://www.youtube.com/watch?v=${ID}x`, 'https://www.youtube.com/watch', 'https://www.youtube.com/watch?v=',
      'https://www.youtube.com/watch?v=dQw4w9WgXc%26', 'https://www.youtube.com/watch?v=..%2F..%2Fadmin', `https://www.youtube.com/watch?v=${ID}%26format%3Dxml`,
      'https://youtu.be/tooshort', `https://youtu.be/${ID}/extra`, 'https://youtu.be/dQw4w9WgXc!', 'https://www.youtube.com/shorts/', 'https://www.youtube.com/shorts/nope',
      `https://www.youtube.com/shorts/${ID}/more`, 'https://m.youtube.com/watch?list=PL123',
    ]) {
      assert.deepEqual(oembedFor(normal(posted)), { siteName: 'YouTube', oembed: null }, posted);
    }
    // Not a video link, or not YouTube at all: the ordinary page route.
    for (const posted of [
      'https://www.youtube.com/', 'https://www.youtube.com/@SomeChannel', 'https://www.youtube.com/playlist?list=PL123', `https://www.youtube.com/embed/${ID}`,
      'https://youtu.be/', `https://www.youtube.com.evil.example/watch?v=${ID}`, `https://notyoutube.com/watch?v=${ID}`, `https://evil.example/www.youtube.com/watch?v=${ID}`,
      `https://gaming.youtube.com/watch?v=${ID}`, `https://youtu.be.evil.example/${ID}`, 'https://news.example.com/story',
    ]) {
      assert.equal(oembedFor(normal(posted)), null, posted);
    }
    for (const value of ['', 'not a url', null, undefined]) assert.equal(oembedFor(value), null);
  });

  test('the watch page is never fetched: the preview comes from the oEmbed JSON and its thumbnail', async () => {
    // The watch page is there, as large as the real one, with its title past what is ever read.
    const hugeWatchPage = { headers: { 'content-type': 'text/html' }, body: `<html><head>${'x'.repeat(MAX_HTML_BYTES + 300000)}<meta property="og:title" content="From the page"></head></html>` };
    const posted = `https://youtu.be/${ID}?t=10`;
    const fake = youtube({ [WATCH]: hugeWatchPage, [`https://youtu.be/${ID}?t=10`]: hugeWatchPage });
    const { previews, dataDir } = await service(fake);
    const preview = await previews.fetchPreview(posted, new Set());
    assert.equal(preview.url, posted, 'the card links to what was posted');
    assert.equal(preview.title, 'Never Gonna Give You Up');
    assert.equal(preview.description, 'by Rick Astley');
    assert.equal(preview.siteName, 'YouTube');
    assert.match(preview.image, /^\/link-previews\/[a-f0-9]{32}\.jpg$/);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'link-previews', path.basename(preview.image))), JPEG);
    assert.ok(!JSON.stringify(preview).includes('ytimg'), 'readers load the picture from this server');

    assert.deepEqual(fake.requests().map((r) => [r.url, r.address, r.port]), [[oembedUrl(), PUBLIC_A, 443], [THUMB, PUBLIC_B, 443]]);
    assert.deepEqual(fake.lookups().map((l) => l.hostname), ['www.youtube.com', 'i.ytimg.com'], 'resolved and pinned like any other fetch');
    const [oembed] = fake.requests();
    assert.equal(oembed.headers.Accept, 'application/json');
    assert.equal(oembed.headers['User-Agent'], USER_AGENT);
    assert.deepEqual(Object.keys(oembed.headers).map((h) => h.toLowerCase()).sort(), ['accept', 'accept-encoding', 'accept-language', 'connection', 'user-agent']);

    // A generic site still takes the page route, untouched.
    const other = fakeNet({ hosts: { 'news.example.com': [PUBLIC_A] }, pages: { 'https://news.example.com/story': { headers: { 'content-type': 'text/html' }, body: '<title>Plain page</title>' } } });
    assert.deepEqual(await (await service(other)).previews.fetchPreview('https://news.example.com/story', new Set()), { url: 'https://news.example.com/story', title: 'Plain page' });
    assert.equal(other.requests()[0].headers.Accept, 'text/html,application/xhtml+xml');
  });

  test('a YouTube link with an id that cannot be one gets nothing, and nothing is fetched', async () => {
    const fake = youtube({ 'https://www.youtube.com/watch?v=nope': { headers: { 'content-type': 'text/html' }, body: '<title>Should not be read</title>' } });
    const { previews } = await service(fake);
    await refused(previews.fetchPreview('https://www.youtube.com/watch?v=nope', new Set()), 'bad-id');
    await refused(previews.fetchPreview('https://youtu.be/tooshort', new Set()), 'bad-id');
    assert.equal(await previews.previewFor('https://www.youtube.com/watch?v=nope', { user: 'ann' }), null);
    assert.equal(fake.log.length, 0);
  });

  test('an oEmbed answer that is too big, malformed, or not JSON yields no preview', async () => {
    const big = JSON.stringify({ title: 'T', padding: 'x'.repeat(MAX_JSON_BYTES) });
    const cases = {
      'declared too big': [json(ANSWER, { headers: { 'content-type': 'application/json', 'content-length': String(MAX_JSON_BYTES + 1) } }), 'too-large'],
      'actually too big': [json(big), 'too-large'],
      'cut-off JSON': [json('{"title":"Never Gonna'), 'bad-json'],
      'not JSON at all': [json('Not Found'), 'bad-json'],
      'empty': [json(''), 'bad-json'],
      'an array': [json([ANSWER]), 'bad-json'],
      'a string': [json('"just a string"'), 'bad-json'],
      'null': [json('null'), 'bad-json'],
      'no title': [json({ author_name: 'Somebody', thumbnail_url: THUMB }), 'no-metadata'],
      'a title that is not text': [json({ title: { toString: 'x' }, author_name: 'A' }), 'no-metadata'],
      'a title that cleans to nothing': [json({ title: '\u0000‮  ​' }), 'no-metadata'],
      'JSON served as html': [{ headers: { 'content-type': 'text/html' }, body: JSON.stringify(ANSWER) }, 'content-type'],
      'JSON served as text': [{ headers: { 'content-type': 'text/plain' }, body: JSON.stringify(ANSWER) }, 'content-type'],
      'JSON served as javascript': [{ headers: { 'content-type': 'application/javascript' }, body: JSON.stringify(ANSWER) }, 'content-type'],
      'no content type': [{ headers: {}, body: JSON.stringify(ANSWER) }, 'content-type'],
      'compressed': [json(ANSWER, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }), 'content-encoding'],
      'private video (401)': [{ status: 401, headers: { 'content-type': 'text/html' }, body: 'Unauthorized' }, 'status'],
      'no such video (404)': [{ status: 404, headers: { 'content-type': 'text/html' }, body: 'Not Found' }, 'status'],
      'server error': [json(ANSWER, { status: 500 }), 'status'],
    };
    for (const [label, [answer, reason]] of Object.entries(cases)) {
      const fake = youtube({ [oembedUrl()]: answer });
      const { previews, db } = await service(fake);
      await refused(previews.fetchPreview(WATCH, new Set()), reason);
      assert.deepEqual(fake.requests().map((r) => r.url), [oembedUrl()], `${label}: the watch page is not tried instead, and no image is fetched`);
      if (label === 'declared too big') assert.equal(fake.requests()[0].bytesRead, 0, 'refused before a byte was read');
      if (label === 'actually too big') assert.ok(fake.requests()[0].bytesRead <= MAX_JSON_BYTES + 16384, 'reading stopped at the cap');
      // And through the front door it is simply "no preview", remembered like any other failure.
      assert.equal(await previews.previewFor(WATCH, { user: 'ann' }), null, label);
      assert.deepEqual(await db.all('SELECT url, status FROM link_previews'), [{ url: WATCH, status: 'none' }]);
    }
    assert.equal(MAX_JSON_BYTES, 64 * 1024);
  });

  test('hostile strings in the JSON are cleaned and capped, and its other fields are ignored', async () => {
    const fake = youtube({
      [oembedUrl()]: json({
        title: `<img src=x onerror=alert(1)>\u0000\u001b[31m ‮evil‬ &lt;b&gt; ${'long '.repeat(500)}`,
        author_name: `‮moc.elgoog\n\n<script>alert(1)</script> ${'a'.repeat(1000)}`,
        provider_name: 'Totally Your Bank',
        provider_url: 'javascript:alert(1)',
        author_url: 'http://192.168.1.1/admin',
        url: 'http://localhost/',
        html: '<script>alert(document.cookie)</script>',
        thumbnail_url: THUMB,
        __proto__: { polluted: true },
        constructor: { prototype: { polluted: true } },
      }),
    });
    const { previews } = await service(fake);
    const preview = await previews.fetchPreview(WATCH, new Set());
    assert.deepEqual(Object.keys(preview).sort(), ['description', 'image', 'siteName', 'title', 'url'], 'only these ever come out');
    assert.equal(preview.url, WATCH, 'never a URL from the JSON');
    assert.equal(preview.siteName, 'YouTube', 'ours, not the answer\'s');
    assert.ok(preview.title.startsWith('<img src=x onerror=alert(1)> [31m evil <b> long long'), preview.title);
    assert.equal(Array.from(preview.title).length, TITLE_MAX);
    assert.ok(preview.description.startsWith('by moc.elgoog <script>alert(1)</script> aaa'));
    assert.ok(Array.from(preview.description).length <= 103);
    for (const field of [preview.title, preview.description]) assert.doesNotMatch(field, /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/);
    assert.equal(({}).polluted, undefined);
    assert.deepEqual(fake.requests().map((r) => r.hostname), ['www.youtube.com', 'i.ytimg.com'], 'none of the other addresses in it were contacted');

    // No author: no description line, rather than a dangling "by".
    const anonymous = youtube({ [oembedUrl()]: json({ title: 'Untitled upload', author_name: 42, thumbnail_url: 7 }) });
    assert.deepEqual(await (await service(anonymous)).previews.fetchPreview(WATCH, new Set()), { url: WATCH, title: 'Untitled upload', siteName: 'YouTube' });
  });

  test('a thumbnail that breaks the rules is dropped, and the text preview is kept', async () => {
    const text = { url: WATCH, title: 'Never Gonna Give You Up', description: 'by Rick Astley', siteName: 'YouTube' };
    const cases = {
      'a name that resolves into the LAN': ['https://inside.example.com/cam.jpg', 1],
      'a name that resolves to loopback': ['https://loop.example.com/x.jpg', 1],
      'a name in the tailnet range': ['https://tail.example.com/x.jpg', 1],
      'an address': ['http://192.168.1.1/logo.jpg', 1],
      'an address in decimal': ['http://2130706433/x.jpg', 1],
      'the metadata address': ['http://169.254.169.254/latest/meta-data/', 1],
      'localhost': ['http://localhost/x.jpg', 1],
      'another port': ['https://i.ytimg.com:8443/x.jpg', 1],
      'credentials': ['https://user:pw@i.ytimg.com/x.jpg', 1],
      'a data url': ['data:image/png;base64,iVBORw0KGgo=', 1],
      'a javascript url': ['javascript:alert(1)', 1],
      'a file url': ['file:///etc/passwd', 1],
      'an SVG': ['https://i.ytimg.com/logo.svg', 2],
      'a page, not an image': ['https://i.ytimg.com/page', 2],
      'an image by label only': ['https://i.ytimg.com/html-as-jpeg', 2],
      'an image that is too big': ['https://i.ytimg.com/huge.jpg', 2],
      'a redirect into the LAN': ['https://i.ytimg.com/hop', 2],
      'a missing image': ['https://i.ytimg.com/gone.jpg', 2],
    };
    for (const [label, [thumbnail, expectedRequests]] of Object.entries(cases)) {
      const fake = youtube({
        [oembedUrl()]: json({ ...ANSWER, thumbnail_url: thumbnail }),
        'https://i.ytimg.com/logo.svg': { headers: { 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
        'https://i.ytimg.com/page': { headers: { 'content-type': 'text/html' }, body: '<title>x</title>' },
        'https://i.ytimg.com/html-as-jpeg': { headers: { 'content-type': 'image/jpeg' }, body: '<!doctype html><script>alert(1)</script>' },
        'https://i.ytimg.com/huge.jpg': { headers: { 'content-type': 'image/jpeg' }, body: Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024 + 10, 1)]) },
        'https://i.ytimg.com/hop': { status: 302, headers: { location: 'https://inside.example.com/cam.jpg' } },
        'https://inside.example.com/cam.jpg': { headers: { 'content-type': 'image/jpeg' }, body: JPEG },
        'https://loop.example.com/x.jpg': { headers: { 'content-type': 'image/jpeg' }, body: JPEG },
        'https://tail.example.com/x.jpg': { headers: { 'content-type': 'image/jpeg' }, body: JPEG },
      }, { 'inside.example.com': ['192.168.1.10'], 'loop.example.com': ['127.0.0.1'], 'tail.example.com': ['100.101.102.103'] });
      const { previews, dataDir } = await service(fake);
      assert.deepEqual(await previews.fetchPreview(WATCH, new Set()), text, label);
      assert.equal(fake.requests().length, expectedRequests, `${label}: ${fake.requests().map((r) => r.url).join(', ')}`);
      assert.ok(fake.requests().every((r) => r.address === PUBLIC_A || r.address === PUBLIC_B), `${label}: nothing was sent to a private address`);
      assert.ok(!fs.existsSync(path.join(dataDir, 'link-previews')) || fs.readdirSync(path.join(dataDir, 'link-previews')).length === 0, `${label}: no file was kept`);
    }
  });

  test('a redirect on the oEmbed request is checked and resolved again, like any other hop', async () => {
    const hop = (to) => ({ status: 302, headers: { location: to } });
    // A redirect to another public address is followed, and that hop is resolved and pinned afresh.
    const moved = youtube({ [oembedUrl()]: hop('https://oembed.example.net/v1?id=1'), 'https://oembed.example.net/v1?id=1': json(ANSWER) }, { 'oembed.example.net': [PUBLIC_B] });
    assert.equal((await (await service(moved)).previews.fetchPreview(WATCH, new Set())).title, 'Never Gonna Give You Up');
    assert.deepEqual(moved.requests().slice(0, 2).map((r) => [r.hostname, r.address]), [['www.youtube.com', PUBLIC_A], ['oembed.example.net', PUBLIC_B]]);
    assert.deepEqual(moved.lookups().slice(0, 2).map((l) => l.hostname), ['www.youtube.com', 'oembed.example.net']);

    const ends = {
      'https://inside.example.com/oembed': 'private', 'http://192.168.1.1/': 'ip-literal', 'http://localhost/': 'single-label', 'http://nas.local/': 'internal-name',
      'https://www.youtube.com:8443/oembed': 'port', 'https://a:b@www.youtube.com/oembed': 'credentials', 'https://party.example.org/app/': 'own-host', 'file:///etc/passwd': 'scheme',
    };
    for (const [location, reason] of Object.entries(ends)) {
      const fake = youtube({ [oembedUrl()]: hop(location), 'https://inside.example.com/oembed': json(ANSWER) }, { 'inside.example.com': ['10.0.0.5'] });
      const { previews } = await service(fake);
      await refused(previews.fetchPreview(WATCH, new Set(['party.example.org'])), reason);
      assert.deepEqual(fake.requests().map((r) => r.url), [oembedUrl()], location);
    }
    // Too many of them ends it as well.
    const loop = youtube({ [oembedUrl()]: hop(oembedUrl()) });
    await refused((await service(loop)).previews.fetchPreview(WATCH, new Set()), 'too-many-redirects');
    assert.equal(loop.requests().length, 4);
    // A name for YouTube that resolves somewhere private is refused before anything is sent.
    const rebound = youtube({}, { 'www.youtube.com': ['192.168.1.10'] });
    await refused((await service(rebound)).previews.fetchPreview(WATCH, new Set()), 'private');
    assert.equal(rebound.requests().length, 0);
  });

  test('the cache key is the posted link, and the kill switch still turns it all off', async () => {
    const fake = youtube();
    const { previews, db } = await service(fake);
    const first = await previews.previewFor(`https://youtu.be/${ID}`, { user: 'ann' });
    assert.equal(first.title, 'Never Gonna Give You Up');
    assert.equal(first.url, `https://youtu.be/${ID}`);
    const fetched = fake.requests().length;
    assert.deepEqual(await previews.previewFor(`https://youtu.be/${ID}`, { user: 'ben' }), first);
    assert.equal(fake.requests().length, fetched, 'posted again: nothing fetched');
    assert.deepEqual((await db.all('SELECT url, status FROM link_previews')), [{ url: `https://youtu.be/${ID}`, status: 'ok' }]);

    // On a message: the card is attached like any other, linking to the link as written.
    await db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts) VALUES (1, 'demo', 'general', 'ann', ?, 1)", `watch this https://youtu.be/${ID}#t=30`);
    const events = [];
    await previews.attachTo({ table: 'messages', id: 1, user: 'ann', emit: (p) => events.push(p) });
    assert.deepEqual(events.map((p) => [p.url, p.title, p.siteName]), [[`https://youtu.be/${ID}#t=30`, 'Never Gonna Give You Up', 'YouTube']]);

    for (const value of ['0', 'off']) {
      const offNet = youtube();
      const off = await service(offNet, { LINK_PREVIEWS: value });
      assert.equal(off.previews.enabled(), false);
      assert.equal(await off.previews.previewFor(WATCH, { user: 'ann' }), null);
      await off.db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts) VALUES (1, 'demo', 'general', 'ann', ?, 1)", WATCH);
      assert.equal(await off.previews.attachTo({ table: 'messages', id: 1, user: 'ann', emit() { throw new Error('must not be called'); } }), null);
      assert.equal(offNet.log.length, 0, 'not even a lookup');
    }
  });

  test('LINK_PREVIEW_DEBUG logs the host and a reason code, and nothing else', async () => {
    const secret = 'https://news.example.com/private/report?token=s3cr3t-token&user=ann';
    const pages = {
      [oembedUrl()]: json({ ...ANSWER, thumbnail_url: 'https://inside.example.com/cam.jpg?key=hunter2' }),
      [secret]: { status: 403, headers: { 'content-type': 'text/html' }, body: '' },
    };
    const hosts = { 'inside.example.com': ['192.168.1.10'], 'news.example.com': [PUBLIC_A] };

    // Off (the default): silent.
    const quiet = await service(youtube(pages, hosts));
    await quiet.previews.previewFor(WATCH, { user: 'ann' });
    await quiet.previews.previewFor(secret, { user: 'ann' });
    assert.deepEqual(quiet.lines.filter((l) => /not kept|no preview/.test(l)), []);

    const loud = await service(youtube(pages, hosts), { LINK_PREVIEW_DEBUG: '1' });
    assert.equal((await loud.previews.previewFor(WATCH, { user: 'ann' })).title, 'Never Gonna Give You Up');
    assert.equal(await loud.previews.previewFor(secret, { user: 'ann' }), null);
    assert.equal(await loud.previews.previewFor('https://www.youtube.com/watch?v=bad', { user: 'ann' }), null);
    const notes = loud.lines.filter((l) => /not kept|no preview/.test(l));
    assert.deepEqual(notes, [
      '[link-preview] image not kept: inside.example.com (private)',
      '[link-preview] no preview: news.example.com (status)',
      '[link-preview] no preview: www.youtube.com (bad-id)',
    ]);
    const all = loud.lines.join('\n');
    for (const leak of ['s3cr3t', 'token', 'hunter2', 'report', 'cam.jpg', 'ann', 'watch?v', '192.168']) assert.ok(!all.includes(leak), leak);
  });
});
