// Uploaded files served from LAN Party's own origin, and the framing policy every response carries.
//
// An uploaded .html (or .svg) served as a page from this origin would run as whoever opened it, with
// their session. So for each of the five mounts people can put files into, an upload that tries to
// be a page is either refused when it is uploaded or served so that it cannot be one (a sandboxed,
// scriptless CSP, nosniff, and a download rather than a document). Real media still serves inline.
//
// Layers: the helpers on their own, then the real server over HTTP.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { strToU8 } = require('fflate');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');
const {
  frameAncestorsDirective, storedExtension, GIF_TYPES, SOUND_TYPES, SOUND_EXTENSIONS, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS, FEEDBACK_IMAGE_TYPES,
} = require('../services/userFiles');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Small stand-ins with the right leading bytes. Nothing here decodes them; the server serves by the
// stored extension, which is what is under test.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const GIF = strToU8('GIF89a\x01\x00\x01\x00\x00\x00\x00;');
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
const HTML = strToU8('<!doctype html><script>fetch("/user/settings")</script><h1>owned</h1>');
const SVG = strToU8('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');

const SANDBOX_CSP = /^default-src 'none'; sandbox; frame-ancestors 'self'$/;

// ---------------------------------------------------------------------------------------------
describe('stored extensions and frame-ancestors (services/userFiles.js)', () => {
  test('the extension comes from the accepted type, else from the fallback table, never from the filename as such', () => {
    assert.equal(storedExtension({ mimetype: 'image/png', originalname: 'evil.html' }, GIF_TYPES), '.png');
    assert.equal(storedExtension({ mimetype: 'IMAGE/GIF; charset=x', originalname: 'a' }, GIF_TYPES), '.gif');
    for (const mimetype of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/javascript', 'image/x-icon', '']) {
      assert.equal(storedExtension({ mimetype, originalname: 'a.gif' }, GIF_TYPES), null, mimetype);
    }
    assert.equal(storedExtension({ mimetype: 'application/octet-stream', originalname: 'clip.MP3' }, SOUND_TYPES, SOUND_EXTENSIONS), '.mp3');
    assert.equal(storedExtension({ mimetype: 'application/octet-stream', originalname: 'clip.opus' }, SOUND_TYPES, SOUND_EXTENSIONS), '.ogg');
    assert.equal(storedExtension({ mimetype: 'audio/webm;codecs=opus', originalname: 'entrance.webm' }, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS), '.webm');
    assert.equal(storedExtension({ mimetype: 'audio/mp4', originalname: 'entrance.webm' }, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS), '.m4a');
    for (const originalname of ['x.html', 'x.htm', 'x.svg', 'x.xhtml', 'x.xml', 'x.js', 'x.mjs', 'x', '.mp3', 'mp3']) {
      assert.equal(storedExtension({ mimetype: 'application/octet-stream', originalname }, SOUND_TYPES, SOUND_EXTENSIONS), null, originalname);
      assert.equal(storedExtension({ mimetype: 'text/html', originalname }, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS), null, originalname);
    }
    // No table can produce an extension a browser would render as a page or run as a script.
    const every = [GIF_TYPES, SOUND_TYPES, SOUND_EXTENSIONS, ENTRANCE_TYPES, ENTRANCE_EXTENSIONS, FEEDBACK_IMAGE_TYPES].flatMap((t) => Object.values(t));
    for (const ext of every) assert.doesNotMatch(ext, /^\.(html?|xhtml|xml|svg|js|mjs)$/i, ext);
  });

  test('frame-ancestors is \'self\', plus configured client origins that are real origins', () => {
    assert.equal(frameAncestorsDirective(), "frame-ancestors 'self'");
    assert.equal(frameAncestorsDirective([]), "frame-ancestors 'self'");
    assert.equal(
      frameAncestorsDirective(['http://localhost:5173', ' https://LanParty.Example.TEST:443/app ', 'https://lanparty.example.test', 'bare.example:9000', "'none'; script-src *", 'javascript:alert(1)', '']),
      "frame-ancestors 'self' http://localhost:5173 https://lanparty.example.test",
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe('uploaded files and framing (server)', () => {
  let server, call, base, token;

  before(async () => {
    server = await startServer();
    base = server.base;
    call = apiFor(base);
    token = await makeUser(call, 'uploader');
  });
  after(async () => { await server.stop(); });

  const form = (field, bytes, type, filename, extra = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    fd.append(field, new Blob([bytes], { type }), filename);
    return fd;
  };
  const served = async (url) => {
    const res = await fetch(base + url);
    await res.arrayBuffer();
    return res;
  };
  // What every uploaded file is sent with, whatever it is.
  const assertLocked = (res, label) => {
    assert.equal(res.status, 200, label);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', label);
    assert.match(res.headers.get('content-security-policy') || '', SANDBOX_CSP, label);
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', label);
  };
  const assertDownload = (res, label) => {
    assertLocked(res, label);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream', label);
    assert.equal(res.headers.get('content-disposition'), 'attachment', label);
  };
  const assertInline = (res, type, label) => {
    assertLocked(res, label);
    assert.match(res.headers.get('content-type') || '', new RegExp(`^${type.replace('+', '\\+')}`), label);
    assert.equal(res.headers.get('content-disposition'), null, `${label}: shown, not downloaded`);
  };

  // --- framing ---
  test('every response says only LAN Party may frame it', async () => {
    for (const route of ['/webrtc/ice', '/servers', '/sdk/lanparty.js', '/no/such/route', '/entrances/missing.webm']) {
      const res = await fetch(base + route);
      await res.arrayBuffer();
      assert.equal(res.headers.get('content-security-policy'), "frame-ancestors 'self'", route);
      assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', route);
    }
  });

  test('an uploaded bundle keeps its sandbox CSP, with frame-ancestors in the same policy', async () => {
    const res = await call('POST', '/apps/bundle', form('bundle', strToU8('<h1>bundle</h1>'), 'text/html', 'index.html', { name: 'Framed' }), token);
    assert.equal(res.status, 200);
    const page = await fetch(base + res.data.app.url);
    assert.match(await page.text(), /bundle/);
    // One header, one policy, both directives: a second header would be a second policy.
    assert.equal(page.headers.get('content-security-policy'), "sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock; frame-ancestors 'self'");
    assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  });

  // --- /uploads: any file may be shared in chat, so the serving layer is what covers it ---
  test('/uploads: html and other documents download; images, svg, text and video show inline but locked down', async () => {
    const upload = async (bytes, type, filename) => {
      const res = await call('POST', '/files/upload', form('file', bytes, type, filename), token);
      assert.equal(res.status, 200, filename);
      return res.data.attachment.url;
    };
    for (const [bytes, type, filename] of [
      [HTML, 'text/html', 'page.html'],
      [HTML, 'text/html', 'page.htm'],
      [HTML, 'application/xhtml+xml', 'page.xhtml'],
      [HTML, 'text/xml', 'feed.xml'],
      [HTML, 'application/javascript', 'app.js'],
      [HTML, 'application/pdf', 'doc.pdf'],
      [HTML, 'application/octet-stream', 'noext'],
    ]) assertDownload(await served(await upload(bytes, type, filename)), filename);
    assertInline(await served(await upload(PNG, 'image/png', 'pic.png')), 'image/png', 'png');
    // An SVG still displays (in an <img> the CSP is ignored); opened directly it runs no script.
    assertInline(await served(await upload(SVG, 'image/svg+xml', 'draw.svg')), 'image/svg+xml', 'svg');
    assertInline(await served(await upload(strToU8('just words'), 'text/plain', 'notes.txt')), 'text/plain', 'txt');
    assertInline(await served(await upload(WEBM, 'video/webm', 'clip.webm')), 'video/webm', 'webm');
    assertInline(await served(await upload(MP3, 'audio/mpeg', 'song.mp3')), 'audio/mpeg', 'mp3');
  });

  // A shared cache that stored a file before the protective headers existed must not be told
  // "not modified": it would keep serving its stored copy, old headers included, indefinitely.
  test('a validator from before the headers changed gets the whole file again, with the headers', async () => {
    const up = await call('POST', '/files/upload', form('file', PNG, 'image/png', 'cached.png'), token);
    const url = up.data.attachment.url;
    const first = await served(url);
    const etag = first.headers.get('etag');
    assert.match(etag || '', /^W\/"uf\d+-[0-9a-f]+-[0-9a-f]+"$/, 'the ETag carries the headers version');
    assert.equal(first.headers.get('last-modified'), null, 'no second validator that an old cache could still use');

    // What the static server used to hand out for the same file: size and mtime, no version.
    const [, size, mtime] = /^W\/"uf\d+-([0-9a-f]+)-([0-9a-f]+)"$/.exec(etag);
    const before = await fetch(base + url, { headers: { 'If-None-Match': `W/"${size}-${mtime}"`, 'If-Modified-Since': new Date().toUTCString() } });
    await before.arrayBuffer();
    assertInline(before, 'image/png', 'a pre-change validator is stale: full response, protective headers');

    // The current one still saves the transfer. (Raw http: fetch adds Cache-Control: no-cache to a
    // request that sets If-None-Match itself, and that alone forces a full response.)
    const now = await new Promise((resolve, reject) => {
      require('node:http').get(base + url, { headers: { 'If-None-Match': etag } }, (res) => { res.resume(); resolve(res); }).on('error', reject);
    });
    assert.equal(now.statusCode, 304);
    assert.match(String(now.headers['content-security-policy'] || ''), SANDBOX_CSP, 'and a 304 carries the policy too');
  });

  // --- /gifs ---
  test('/gifs: only raster image types are taken, stored under their own extension', async () => {
    for (const [bytes, type, filename] of [[HTML, 'text/html', 'x.html'], [SVG, 'image/svg+xml', 'x.svg'], [HTML, 'application/octet-stream', 'x.gif']]) {
      const res = await call('POST', '/gifs', form('file', bytes, type, filename), token);
      assert.equal(res.status, 400, filename);
      assert.match(res.data.error, /GIF library/);
    }
    // HTML claiming to be a PNG, under an .html name: stored as .png, served as one.
    const res = await call('POST', '/gifs', form('file', HTML, 'image/png', 'evil.html'), token);
    assert.equal(res.status, 200);
    const evil = res.data.gifs.find((g) => g.name === 'evil.html');
    assert.match(evil.url, /^\/gifs\/\d+-[a-z0-9]+\.png$/);
    assertInline(await served(evil.url), 'image/png', 'html-as-png');
    const real = await call('POST', '/gifs', form('file', GIF, 'image/gif', 'dance.gif', { name: 'Dance' }), token);
    const dance = real.data.gifs.find((g) => g.name === 'Dance');
    assert.match(dance.url, /\.gif$/);
    assertInline(await served(dance.url), 'image/gif', 'gif');
    const files = fs.readdirSync(path.join(server.dataDir, 'gifs'));
    assert.ok(files.every((f) => /\.(gif|png|jpg|webp|avif)$/.test(f)), files.join(', '));
  });

  // --- /sounds ---
  test('/sounds: audio only, stored under an audio extension whatever the name says', async () => {
    for (const [bytes, type, filename] of [[HTML, 'text/html', 'x.html'], [SVG, 'image/svg+xml', 'x.svg'], [HTML, 'application/octet-stream', 'x.html'], [HTML, 'application/octet-stream', 'x.js']]) {
      const res = await call('POST', '/sounds', form('file', bytes, type, filename), token);
      assert.equal(res.status, 400, filename);
      assert.match(res.data.error, /audio/i);
    }
    const disguised = await call('POST', '/sounds', form('file', HTML, 'audio/mpeg', 'evil.html', { name: 'Disguised' }), token);
    assert.equal(disguised.status, 200);
    const sound = disguised.data.sounds.find((s) => s.name === 'Disguised');
    assert.match(sound.url, /^\/sounds\/\d+-[a-z0-9]+\.mp3$/);
    assertInline(await served(sound.url), 'audio/mpeg', 'html-as-mp3');
    // No useful type, a real audio extension: kept, as some clients send audio that way.
    const plain = await call('POST', '/sounds', form('file', MP3, 'application/octet-stream', 'horn.mp3', { name: 'Horn' }), token);
    assert.equal(plain.status, 200);
    const horn = plain.data.sounds.find((s) => s.name === 'Horn');
    assert.match(horn.url, /\.mp3$/);
    assertInline(await served(horn.url), 'audio/mpeg', 'mp3');
  });

  // --- /entrances ---
  test('/entrances: a recording, stored under an audio extension; html and svg are refused', async () => {
    for (const [bytes, type, filename] of [[HTML, 'text/html', 'entrance.html'], [SVG, 'image/svg+xml', 'entrance.svg'], [HTML, 'application/octet-stream', 'entrance.xhtml']]) {
      const res = await call('POST', '/profile/entrance-sound', form('clip', bytes, type, filename), token);
      assert.equal(res.status, 400, filename);
      assert.match(res.data.error, /audio/i);
    }
    const res = await call('POST', '/profile/entrance-sound', form('clip', WEBM, 'audio/webm;codecs=opus', 'entrance.html'), token);
    assert.equal(res.status, 200);
    assert.match(res.data.url, /^\/entrances\/\d+-[a-z0-9]+\.webm$/);
    assertInline(await served(res.data.url), 'video/webm', 'webm clip');
    const files = fs.readdirSync(path.join(server.dataDir, 'entrances'));
    assert.ok(files.every((f) => /\.(webm|ogg|oga|mp3|m4a|aac|wav|weba|flac)$/.test(f)), files.join(', '));
  });

  // --- /feedback-media ---
  test('/feedback-media: a screenshot is stored as an image; anything else is dropped; a refused report leaves nothing behind', async () => {
    const dir = path.join(server.dataDir, 'feedback-media');
    const before = fs.readdirSync(dir).length;
    // A report that is turned down: its screenshot does not stay in the public folder.
    for (const fields of [{ type: 'spam', message: 'x' }, { type: 'feedback' }]) {
      const res = await call('POST', '/feedback', form('screenshot', PNG, 'image/png', 'shot.png', fields), token);
      assert.equal(res.status, 400, JSON.stringify(fields));
    }
    await sleep(100);
    assert.equal(fs.readdirSync(dir).length, before, 'the refused reports\' screenshots were removed');
    // An html "screenshot" is not kept at all; the report itself still goes through.
    const html = await call('POST', '/feedback', form('screenshot', HTML, 'text/html', 'shot.html', { type: 'bug', message: 'html shot' }), token);
    assert.ok(html.status === 200 || html.status === 502, JSON.stringify(html.data));
    assert.equal(fs.readdirSync(dir).length, before);
    const [noShot] = await dbAll(server.dataDir, 'SELECT screenshot_url FROM feedback WHERE message = ?', ['html shot']);
    assert.equal(noShot.screenshot_url, null);
    // HTML claiming to be a PNG, under an .html name: kept as .png, served as one.
    const ok = await call('POST', '/feedback', form('screenshot', HTML, 'image/png', 'shot.html', { type: 'bug', message: 'png shot' }), token);
    assert.ok(ok.status === 200 || ok.status === 502, JSON.stringify(ok.data));
    const [row] = await dbAll(server.dataDir, 'SELECT screenshot_url FROM feedback WHERE message = ?', ['png shot']);
    const name = row.screenshot_url.split('/').pop();
    assert.match(name, /^\d+-[a-z0-9]+\.png$/);
    assertInline(await served(`/feedback-media/${name}`), 'image/png', 'screenshot');
  });
});
