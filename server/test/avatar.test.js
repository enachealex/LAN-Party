// Profile pictures. The bug these cover: avatars used to be uploaded through /files/upload into
// uploads/, which the 7-day sweep empties — so a picture disappeared about a week after it was set.
// They now live in their own folder, with the same guarantees the entrance clips have.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, apiFor, makeUser } = require('./helpers');

// Real files — the endpoint identifies uploads by their leading bytes, not the declared type.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);
const GIF_BYTES = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

describe('profile pictures', () => {
  let server, call, base, token;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    token = await makeUser(call, 'facepic');
  });
  after(async () => { await server.stop(); });

  const upload = (bytes = PNG_BYTES, type = 'image/png', filename = 'me.png', as = token) => {
    const fd = new FormData();
    fd.append('image', new Blob([bytes], { type }), filename);
    return call('POST', '/profile/avatar', fd, as);
  };

  const storedAvatar = async (as = token) => {
    const res = await call('GET', '/user/settings', undefined, as);
    return res.data.settings.profile?.avatarUrl;
  };

  test('uploads a picture, serves it, and stores it on the profile', async () => {
    const res = await upload();
    assert.equal(res.status, 200);
    assert.match(res.data.url, /^\/avatars\//);

    const served = await fetch(base + res.data.url);
    assert.equal(served.status, 200, 'picture is served back');
    assert.match(served.headers.get('content-type') || '', /^image\//);
    await served.arrayBuffer();

    // Persisted immediately, so closing the editor without saving can't lose it.
    assert.equal(await storedAvatar(), res.data.url);
  });

  test('stores pictures OUTSIDE the swept uploads folder', async () => {
    // The whole point of the fix: uploads/ is emptied after 7 days.
    const res = await upload();
    const name = path.basename(res.data.url);
    assert.ok(fs.existsSync(path.join(server.dataDir, 'avatars', name)), 'saved under avatars/');
    assert.ok(!fs.existsSync(path.join(server.dataDir, 'uploads', name)), 'not under uploads/');
  });

  test('replacing a picture deletes the file it replaced', async () => {
    const first = await upload();
    const firstPath = path.join(server.dataDir, 'avatars', path.basename(first.data.url));
    assert.ok(fs.existsSync(firstPath));

    const second = await upload();
    assert.notEqual(second.data.url, first.data.url);
    assert.ok(!fs.existsSync(firstPath), 'old picture is cleaned up rather than piling up');
    assert.equal(await storedAvatar(), second.data.url);
  });

  test('a removed picture 404s instead of returning the SPA shell', async () => {
    const set = await upload();
    // Clearing the avatar through a normal profile save should release the file.
    const settings = (await call('GET', '/user/settings', undefined, token)).data.settings;
    settings.profile = { ...(settings.profile || {}), avatarUrl: '' };
    const saved = await call('POST', '/user/settings', { settings }, token);
    assert.equal(saved.status, 200);

    const gone = await fetch(base + set.data.url);
    // Without a terminal handler on the static mount this falls through to the catch-all and an
    // <img> receives the client's HTML with a 200 — present but broken, and much harder to diagnose.
    assert.equal(gone.status, 404);
    assert.ok(!(gone.headers.get('content-type') || '').includes('html'));
  });

  test('a settings save that keeps the same picture does NOT delete it', async () => {
    const set = await upload();
    const settings = (await call('GET', '/user/settings', undefined, token)).data.settings;
    // e.g. the user only changed a theme colour.
    settings.railColor = '#123456';
    await call('POST', '/user/settings', { settings }, token);

    assert.equal((await fetch(base + set.data.url)).status, 200, 'picture survives an unrelated save');
    assert.equal(await storedAvatar(), set.data.url);
  });

  test('accepts an animated GIF', async () => {
    // The old /files/upload path took GIFs, so refusing one here would be a regression.
    const res = await upload(GIF_BYTES, 'image/gif', 'wave.gif');
    assert.equal(res.status, 200);
    assert.match(res.data.url, /\.gif$/);
    assert.equal((await fetch(base + res.data.url)).status, 200);
  });

  test('stores the extension the BYTES say, not the one the client claimed', async () => {
    // A lying Content-Type must not decide what this file is served as later.
    const res = await upload(GIF_BYTES, 'image/png', 'sneaky.png');
    assert.equal(res.status, 200);
    assert.match(res.data.url, /\.gif$/, 'renamed to match the real format');
    const served = await fetch(base + res.data.url);
    assert.equal(served.headers.get('content-type'), 'image/gif');
  });

  test('refuses a file that is not really an image', async () => {
    const res = await upload(Buffer.from('<html>not an image</html>'), 'image/png');
    assert.equal(res.status, 400);
    assert.match(res.data.error, /not a valid image/i);
  });

  test('refuses SVG outright', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await upload(svg, 'image/svg+xml', 'x.svg');
    assert.equal(res.status, 400);
  });

  test('a stale client cannot revert a migrated picture to the legacy uploads url', async () => {
    // A session open across the restart that ran the migration still holds /uploads/... in memory and
    // posts it back on the next profile save. Accepting that would undo the migration and leave the
    // profile pointing at a file the 7-day sweep deletes — the exact bug this change fixes.
    const current = await upload();
    const settings = (await call('GET', '/user/settings', undefined, token)).data.settings;
    settings.profile = { ...(settings.profile || {}), avatarUrl: '/uploads/1234-stale.png' };
    const saved = await call('POST', '/user/settings', { settings }, token);
    assert.equal(saved.status, 200);

    assert.equal(await storedAvatar(), current.data.url, 'stored picture wins over the stale url');
    assert.equal((await fetch(base + current.data.url)).status, 200, 'and its file was not released');
  });

  test('a deliberate change to an external url is still honoured', async () => {
    // The guard above must not freeze the avatar: an https url is a legitimate choice.
    const current = await upload();
    const settings = (await call('GET', '/user/settings', undefined, token)).data.settings;
    settings.profile = { ...(settings.profile || {}), avatarUrl: 'https://example.invalid/me.png' };
    await call('POST', '/user/settings', { settings }, token);

    assert.equal(await storedAvatar(), 'https://example.invalid/me.png');
    assert.equal((await fetch(base + current.data.url)).status, 404, 'the file it replaced is released');
  });

  test('a stale /avatars url from a second session destroys nothing', async () => {
    // Two sessions, both holding /avatars/A. One uploads /avatars/B (releasing A); the other then
    // saves its stale draft. Writing that pointer would aim the profile at the deleted A AND release
    // B on the way past — losing both files and leaving every avatar render a hard 404.
    const first = await upload();
    const stale = first.data.url;
    const second = await upload(); // releases `stale`
    assert.equal((await fetch(base + stale)).status, 404, 'precondition: the old file is gone');

    const settings = (await call('GET', '/user/settings', undefined, token)).data.settings;
    settings.profile = { ...(settings.profile || {}), avatarUrl: stale };
    assert.equal((await call('POST', '/user/settings', { settings }, token)).status, 200);

    assert.equal(await storedAvatar(), second.data.url, 'the live picture is kept');
    assert.equal((await fetch(base + second.data.url)).status, 200, 'and its file was not released');
  });

  test('refuses a file that is nothing but a signature', async () => {
    // A truncated download: the right magic bytes and nothing else. Storing it would report success
    // while rendering broken everywhere, and would release the working picture it replaced.
    const current = await upload();
    const truncated = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await upload(truncated, 'image/png', 'cut.png');
    assert.equal(res.status, 400);
    assert.equal(await storedAvatar(), current.data.url, 'the real picture is untouched');
    assert.equal((await fetch(base + current.data.url)).status, 200);
  });

  test('requires auth', async () => {
    const fd = new FormData();
    fd.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'me.png');
    assert.equal((await call('POST', '/profile/avatar', fd)).status, 401);
  });

  test('one user cannot delete another user\'s picture by copying its url', async () => {
    // Avatar urls are visible to everyone (they appear in member lists), so this is reachable: point
    // a second account at someone else's file, then change it again. Deleting on the way out would
    // wipe a picture that is still in use.
    const mine = await upload();
    const other = await makeUser(call, 'facepic2');
    const theirs = (await call('GET', '/user/settings', undefined, other)).data.settings;
    theirs.profile = { avatarUrl: mine.data.url };
    await call('POST', '/user/settings', { settings: theirs }, other);
    theirs.profile = { avatarUrl: '' };
    await call('POST', '/user/settings', { settings: theirs }, other);

    assert.equal(await storedAvatar(), mine.data.url, 'owner still points at it');
    assert.equal((await fetch(base + mine.data.url)).status, 200, 'and the file is still there');
  });

  test('releases a picture only once nobody references it', async () => {
    const mine = await upload();
    const other = await makeUser(call, 'facepic3');
    const theirs = (await call('GET', '/user/settings', undefined, other)).data.settings;
    theirs.profile = { avatarUrl: mine.data.url };
    await call('POST', '/user/settings', { settings: theirs }, other);

    // Owner moves on while the other account still uses the file: it must survive.
    await upload();
    assert.equal((await fetch(base + mine.data.url)).status, 200, 'kept while still referenced');

    // Last reference goes away: now it may be collected.
    theirs.profile = { avatarUrl: '' };
    await call('POST', '/user/settings', { settings: theirs }, other);
    assert.equal((await fetch(base + mine.data.url)).status, 404, 'collected once unreferenced');
  });
});

describe('orphaned avatar files', () => {
  let server, call, base, token, dataDir;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    dataDir = server.dataDir;
    token = await makeUser(call, 'orphanpic');
  });
  after(async () => { await server.stop(); });

  test('an unreferenced file is collected, and a referenced one is not', async () => {
    // avatars/ is exempt from the 7-day sweep on purpose, so files nothing points at would otherwise
    // accumulate forever — a settings write that drops the reference without going through the release
    // path is enough to strand one, which is an unbounded disk-fill lever for any account.
    const fd = new FormData();
    fd.append('image', new Blob([PNG_BYTES], { type: 'image/png' }), 'me.png');
    const live = await call('POST', '/profile/avatar', fd, token);
    const liveName = path.basename(live.data.url);

    // An orphan old enough to be past the grace period (a fresh upload must NOT be swept).
    const orphan = path.join(dataDir, 'avatars', 'orphan-old.png');
    fs.writeFileSync(orphan, PNG_BYTES);
    const old = Date.now() - (48 * 60 * 60 * 1000);
    fs.utimesSync(orphan, new Date(old), new Date(old));
    const fresh = path.join(dataDir, 'avatars', 'orphan-fresh.png');
    fs.writeFileSync(fresh, PNG_BYTES);

    // The sweep runs at boot, so a second server against the same data dir triggers it.
    const second = await startServer({ env: { DATA_DIR: dataDir } });
    try {
      assert.ok(!fs.existsSync(orphan), 'the unreferenced file is gone');
      assert.ok(fs.existsSync(fresh), 'a recent file is left alone (it may be mid-upload)');
      assert.ok(fs.existsSync(path.join(dataDir, 'avatars', liveName)), 'the referenced picture survives');
    } finally {
      await second.stop();
    }
  });
});

describe('legacy avatars in uploads/', () => {
  let server, call, base, token, dataDir;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    dataDir = server.dataDir;
    token = await makeUser(call, 'oldpic');
  });
  after(async () => { await server.stop(); });

  test('a picture already in uploads/ is moved out on the next boot', async () => {
    // Recreate the pre-fix state: the image sits in uploads/ and the profile points at it.
    const legacyName = `${Date.now()}-legacy-me.png`;
    fs.writeFileSync(path.join(dataDir, 'uploads', legacyName), PNG_BYTES);
    const settings = (await call('GET', '/user/settings', undefined, token)).data.settings;
    settings.profile = { ...(settings.profile || {}), avatarUrl: `/uploads/${legacyName}` };
    await call('POST', '/user/settings', { settings }, token);

    // Boot a second server against the SAME data directory to run the rescue step.
    const second = await startServer({ env: { DATA_DIR: dataDir } });
    try {
      const call2 = apiFor(second.base);
      const login = await call2('POST', '/auth/login', { username: 'oldpic', password: 'Test123!pw' });
      const after = (await call2('GET', '/user/settings', undefined, login.data.token)).data.settings;

      assert.match(after.profile.avatarUrl, /^\/avatars\//, 'profile now points at the safe folder');
      assert.equal((await fetch(second.base + after.profile.avatarUrl)).status, 200, 'and it is served');
      // The original is left alone: the same file may also be attached to a chat message.
      assert.ok(fs.existsSync(path.join(dataDir, 'uploads', legacyName)), 'copied, not moved');
    } finally {
      await second.stop();
    }
  });

  test('an external avatar url is left untouched', async () => {
    const other = await makeUser(call, 'linkedpic');
    const settings = (await call('GET', '/user/settings', undefined, other)).data.settings;
    settings.profile = { avatarUrl: 'https://example.invalid/me.png' };
    await call('POST', '/user/settings', { settings }, other);

    const second = await startServer({ env: { DATA_DIR: dataDir } });
    try {
      const call2 = apiFor(second.base);
      const login = await call2('POST', '/auth/login', { username: 'linkedpic', password: 'Test123!pw' });
      const after = (await call2('GET', '/user/settings', undefined, login.data.token)).data.settings;
      assert.equal(after.profile.avatarUrl, 'https://example.invalid/me.png');
    } finally {
      await second.stop();
    }
  });
});
