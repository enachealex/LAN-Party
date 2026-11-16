// LAN Party's own GIF library (services/gifLibrary.js, routes/library.js, scripts/import-gifs.js):
// searching by name and tags, pages, one copy of each picture, only real images, saving a GIF out
// of chat before the 7-day upload sweep, and who may change or remove one.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { startServer, apiFor, makeUserFromOwnAddress: makeUser, dbAll } = require('./helpers');
const { normalizeTags, sniffImage, nameFromFilename } = require('../services/gifLibrary');

// Real 1x1 images. Each GIF differs in one byte, so each is a different picture.
const gifBytes = (n) => { const b = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'); b[13] = n; return b; };
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

const form = (bytes, filename, fields = {}, type = 'image/gif') => {
  const f = new FormData();
  f.append('file', new Blob([bytes], { type }), filename);
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};

describe('the service on its own', () => {
  test('tags are lowercase words, deduplicated and capped', () => {
    assert.deepEqual(normalizeTags('Funny, cat  CAT reaction!!'), ['funny', 'cat', 'reaction']);
    assert.deepEqual(normalizeTags(['Thumbs-Up', '__x__', '']), ['thumbs-up', 'x']);
    assert.equal(normalizeTags(Array.from({ length: 40 }, (_, i) => `t${i}`)).length, 12);
    assert.deepEqual(normalizeTags(undefined), []);
  });
  test('what a file is comes from its bytes', () => {
    assert.equal(sniffImage(gifBytes(1)).type, 'image/gif');
    assert.equal(sniffImage(PNG_BYTES).type, 'image/png');
    assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>')), null);
  });
  test('a display name from a filename', () => {
    assert.equal(nameFromFilename('reactions/happy_dance.gif'), 'happy dance');
    assert.equal(nameFromFilename('1700000000000-abc123-cat.party.gif'), 'cat party');
  });
});

describe('GIF library over HTTP', () => {
  let server, call;
  const tok = {};
  const ids = {};

  before(async () => {
    // No list configured: the first account registered (boss) is the instance owner.
    server = await startServer({ env: { INSTANCE_OWNERS: '' } });
    call = apiFor(server.base);
    for (const name of ['boss', 'ann', 'ben']) tok[name] = await makeUser(server.base, name);
  });
  after(async () => { await server?.stop(); });

  test('an upload keeps the name and tags it was given, and is served from /gifs', async () => {
    const res = await call('POST', '/gifs', form(gifBytes(1), 'whatever.gif', { name: 'Happy dance', tags: 'happy, Dance party' }), tok.ann);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.duplicate, false);
    const g = res.data.gif;
    assert.equal(g.name, 'Happy dance');
    assert.deepEqual(g.tags, ['happy', 'dance', 'party']);
    assert.equal(g.createdBy, 'ann');
    assert.equal(g.canManage, true);
    assert.match(g.url, /^\/gifs\/\d+-[0-9a-f]{8}\.gif$/);
    const served = await fetch(server.base + g.url);
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), gifBytes(1));
    ids.dance = g.id;
  });

  test('the same picture again is not stored twice', async () => {
    const files = () => fs.readdirSync(path.join(server.dataDir, 'gifs')).length;
    const before = files();
    const res = await call('POST', '/gifs', form(gifBytes(1), 'copy.gif'), tok.ben);
    assert.equal(res.status, 200);
    assert.equal(res.data.duplicate, true);
    assert.equal(res.data.gif.id, ids.dance);
    assert.equal(res.data.gif.canManage, false, "it is still ann's");
    assert.equal(files(), before, 'the second copy was dropped');
  });

  test('a file that is not an image is refused, whatever it is called', async () => {
    const res = await call('POST', '/gifs', form(Buffer.from('<html><script>alert(1)</script></html>'), 'cute.gif'), tok.ann);
    assert.equal(res.status, 400);
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM gifs'))[0].n, 1);
  });

  test('search matches every word against the name or the tags', async () => {
    ids.cat = (await call('POST', '/gifs', form(gifBytes(2), 'cat.gif', { name: 'Cat vibing', tags: 'cat music' }), tok.ben)).data.gif.id;
    ids.png = (await call('POST', '/gifs', form(PNG_BYTES, 'still.png', { name: 'Thumbs up', tags: 'yes ok' }, 'image/png'), tok.ben)).data.gif.id;
    const names = async (q) => (await call('GET', `/gifs?q=${encodeURIComponent(q)}`, undefined, tok.ann)).data.gifs.map((g) => g.name);
    assert.deepEqual(await names(''), ['Thumbs up', 'Cat vibing', 'Happy dance'], 'everything, newest first');
    assert.deepEqual(await names('cat'), ['Cat vibing']);
    assert.deepEqual(await names('party'), ['Happy dance'], 'a tag');
    assert.deepEqual(await names('DANCE happy'), ['Happy dance'], 'every word, any case');
    assert.deepEqual(await names('cat party'), [], 'every word must match');
    assert.deepEqual(await names('100%'), [], 'LIKE wildcards are matched literally');
  });

  test('pages: limit and before', async () => {
    const first = (await call('GET', '/gifs?limit=2', undefined, tok.ann)).data;
    assert.deepEqual(first.gifs.map((g) => g.id), [ids.png, ids.cat]);
    assert.equal(first.next, ids.cat);
    const second = (await call('GET', `/gifs?limit=2&before=${first.next}`, undefined, tok.ann)).data;
    assert.deepEqual(second.gifs.map((g) => g.id), [ids.dance]);
    assert.equal(second.next, null);
  });

  test('saving a GIF from chat copies it out of /uploads, which is swept after 7 days', async () => {
    const up = await call('POST', '/files/upload', form(gifBytes(3), 'party parrot.gif'), tok.ann);
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const res = await call('POST', '/gifs/from-upload', { url: up.data.attachment.url }, tok.ben);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.gif.name, 'party parrot');
    assert.equal(res.data.gif.createdBy, 'ben');
    assert.match(res.data.gif.url, /^\/gifs\//);
    // The upload is still there (it is the chat message's), and the library has its own copy.
    const uploaded = path.join(server.dataDir, 'uploads', path.basename(up.data.attachment.url));
    assert.ok(fs.existsSync(uploaded));
    fs.unlinkSync(uploaded); // the sweep
    assert.equal((await fetch(server.base + res.data.gif.url)).status, 200, 'the library copy outlives it');
    ids.parrot = res.data.gif.id;
  });

  test('from-upload takes only a file this server stored', async () => {
    for (const url of ['/gifs/whatever.gif', 'https://example.com/x.gif', '/uploads/../data.sqlite', '/uploads/%2e%2e%2fdata.sqlite', '/uploads/.hidden', '/uploads/%E0%A4%A']) {
      const res = await call('POST', '/gifs/from-upload', { url }, tok.ann);
      assert.ok([400, 404].includes(res.status), `${url}: ${res.status}`);
    }
    assert.equal((await call('POST', '/gifs/from-upload', { url: '/uploads/1700000000000-gone00-x.gif' }, tok.ann)).status, 404, 'an expired upload');
    assert.equal((await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM gifs'))[0].n, 4);
  });

  test('only whoever added a GIF, or an instance owner, may rename, retag or remove it', async () => {
    assert.equal((await call('PATCH', `/gifs/${ids.dance}`, { name: 'Mine now' }, tok.ben)).status, 403);
    assert.equal((await call('DELETE', `/gifs/${ids.dance}`, undefined, tok.ben)).status, 403);

    const renamed = await call('PATCH', `/gifs/${ids.dance}`, { name: '  Happy  dance 2 ', tags: 'joy' }, tok.ann);
    assert.equal(renamed.status, 200);
    assert.equal(renamed.data.gif.name, 'Happy dance 2');
    assert.deepEqual(renamed.data.gif.tags, ['joy']);
    assert.equal((await call('PATCH', `/gifs/${ids.dance}`, { name: '   ' }, tok.ann)).status, 400, 'a name is required');

    // The instance owner can change and remove anyone's, and sees canManage on all of them.
    const all = (await call('GET', '/gifs', undefined, tok.boss)).data.gifs;
    assert.ok(all.every((g) => g.canManage));
    assert.equal((await call('PATCH', `/gifs/${ids.cat}`, { tags: 'cat' }, tok.boss)).status, 200);
    const file = path.join(server.dataDir, 'gifs', path.basename(all.find((g) => g.id === ids.cat).url));
    assert.equal((await call('DELETE', `/gifs/${ids.cat}`, undefined, tok.boss)).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.existsSync(file), false, 'and its file goes with it');

    assert.equal((await call('DELETE', `/gifs/${ids.parrot}`, undefined, tok.ben)).status, 200, 'the one who saved it');
    assert.equal((await call('DELETE', `/gifs/${ids.parrot}`, undefined, tok.ben)).status, 404);
  });

  test('the Tenor proxy is gone', async () => {
    for (const route of ['/tenor/status', '/tenor/search?q=cat', '/tenor/featured']) {
      const res = await fetch(server.base + route, { headers: { Authorization: `Bearer ${tok.ann}` } });
      assert.notEqual(res.headers.get('content-type')?.includes('application/json') && res.status === 200, true, route);
    }
  });

  test('import: a folder on the server, folders become tags, a second run adds nothing', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-import-'));
    fs.mkdirSync(path.join(folder, 'reactions', 'happy'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'reactions', 'happy', 'big_smile.gif'), gifBytes(10));
    fs.writeFileSync(path.join(folder, 'reactions', 'nope.png'), PNG_BYTES); // already in the library
    fs.writeFileSync(path.join(folder, 'top-level.gif'), gifBytes(11));
    fs.writeFileSync(path.join(folder, 'fake.gif'), 'not an image');
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'ignored');
    const run = (...extra) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(__dirname, '..', 'scripts', 'import-gifs.js'), folder, ...extra], { env: { ...process.env, DATA_DIR: server.dataDir } }, (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout))));

    const dry = await run('--dry-run', '--by', 'boss');
    assert.match(dry, /Would add 2, already there 1, refused 1\./);
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM gifs WHERE created_by = 'boss'"))[0].n, 0, 'a dry run writes nothing');

    assert.match(await run('--by', 'boss'), /Added 2, already there 1, refused 1\./);
    const smile = (await call('GET', '/gifs?q=smile', undefined, tok.ann)).data.gifs;
    assert.equal(smile.length, 1);
    assert.equal(smile[0].name, 'big smile');
    assert.deepEqual(smile[0].tags, ['reactions', 'happy']);
    assert.equal(smile[0].createdBy, 'boss');
    assert.equal((await fetch(server.base + smile[0].url)).status, 200, 'the running server serves it');
    assert.equal((await call('GET', '/gifs?q=happy', undefined, tok.ann)).data.gifs.length, 2, 'found by its folder too');

    assert.match(await run(), /Added 0, already there 3, refused 1\./);
    assert.ok(fs.existsSync(path.join(folder, 'top-level.gif')), 'the folder is left as it was');
    fs.rmSync(folder, { recursive: true, force: true });
  });
});
