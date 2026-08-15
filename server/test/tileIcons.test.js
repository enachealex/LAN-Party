// Custom rail tile images: the per-user Home tile and the shared per-server icon. Covers storage
// outside the swept /uploads tree, the magic-byte check, replace-deletes-the-old-file, permissions,
// and the terminal 404 that a reset tile depends on.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, apiFor, makeUser } = require('./helpers');

// A real 1x1 PNG. The endpoint sniffs the leading bytes, so the file has to actually be one.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
);

const imagePart = (bytes, type) => new Blob([bytes], { type });

describe('rail tile images', () => {
  let server, call, base, owner, member, serverId;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    owner = await makeUser(call, 'tileowner');
    member = await makeUser(call, 'tilemate');
    const made = await call('POST', '/servers', { name: 'Tiles' }, owner);
    serverId = made.data.server.id;
    await call('POST', `/servers/${serverId}/invite`, { username: 'tilemate' }, owner);
  });
  after(async () => { await server.stop(); });

  const postIcon = (route, token, bytes = PNG_BYTES, type = 'image/png', filename = 'tile.png') => {
    const fd = new FormData();
    fd.append('image', imagePart(bytes, type), filename);
    return call('POST', route, fd, token);
  };

  test('sets the Home tile, serves it, and stores it in settings', async () => {
    const res = await postIcon('/profile/home-tile', owner);
    assert.equal(res.status, 200);
    assert.match(res.data.url, /^\/tile-icons\//);

    const served = await fetch(base + res.data.url);
    assert.equal(served.status, 200, 'tile image is served back');
    await served.arrayBuffer();

    const settings = await call('GET', '/user/settings', undefined, owner);
    assert.equal(settings.data.settings.homeTileUrl, res.data.url);
  });

  test('stores tile images outside the swept uploads folder', async () => {
    // Anything under DATA_DIR/uploads is deleted after 7 days, which would make a tile silently
    // vanish. This is the guard that keeps them in their own directory.
    const res = await postIcon('/profile/home-tile', owner);
    const name = path.basename(res.data.url);
    assert.ok(fs.existsSync(path.join(server.dataDir, 'tile-icons', name)), 'saved under tile-icons/');
    assert.ok(!fs.existsSync(path.join(server.dataDir, 'uploads', name)), 'not under uploads/');
  });

  test('replacing the Home tile deletes the file it replaced', async () => {
    const first = await postIcon('/profile/home-tile', owner);
    const firstPath = path.join(server.dataDir, 'tile-icons', path.basename(first.data.url));
    assert.ok(fs.existsSync(firstPath));

    const second = await postIcon('/profile/home-tile', owner);
    assert.notEqual(second.data.url, first.data.url);
    assert.ok(!fs.existsSync(firstPath), 'old tile image is cleaned up rather than piling up');
  });

  test('resetting the Home tile clears settings and 404s the file', async () => {
    const set = await postIcon('/profile/home-tile', owner);
    const reset = await call('DELETE', '/profile/home-tile', undefined, owner);
    assert.equal(reset.status, 200);

    const settings = await call('GET', '/user/settings', undefined, owner);
    assert.equal(settings.data.settings.homeTileUrl, undefined);

    // Terminal 404: without it the static mount falls through to the SPA catch-all and an <img> gets
    // the client's HTML with a 200, so a removed tile would look present but broken.
    const gone = await fetch(base + set.data.url);
    assert.equal(gone.status, 404);
    assert.ok(!(gone.headers.get('content-type') || '').includes('html'));
  });

  test('refuses a file that is not really an image', async () => {
    // Correct mime type on the envelope, HTML in the payload.
    const res = await postIcon('/profile/home-tile', owner, Buffer.from('<html>not an image</html>'), 'image/png');
    assert.equal(res.status, 400);
    assert.match(res.data.error, /not a valid image/i);
  });

  test('refuses SVG outright', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await postIcon('/profile/home-tile', owner, svg, 'image/svg+xml', 'tile.svg');
    assert.equal(res.status, 400);
  });

  test('requires auth', async () => {
    const fd = new FormData();
    fd.append('image', imagePart(PNG_BYTES, 'image/png'), 'tile.png');
    const res = await call('POST', '/profile/home-tile', fd);
    assert.equal(res.status, 401);
  });

  test('server icon: staff can set it and every member sees it in the rail', async () => {
    const res = await postIcon(`/servers/${serverId}/icon`, owner);
    assert.equal(res.status, 200);
    assert.match(res.data.url, /^\/tile-icons\//);

    // Shared, not per-viewer: the plain member gets the same url from their own rail listing.
    const mine = await call('GET', '/servers', undefined, member);
    const row = mine.data.servers.find((s) => s.id === serverId);
    assert.equal(row.iconUrl, res.data.url);
  });

  test('server icon: a plain member cannot change it', async () => {
    const res = await postIcon(`/servers/${serverId}/icon`, member);
    assert.equal(res.status, 403);
    // The icon that was already set must be untouched.
    const mine = await call('GET', '/servers', undefined, owner);
    assert.ok(mine.data.servers.find((s) => s.id === serverId).iconUrl);
  });

  test('server icon: clearing it falls back to no icon', async () => {
    const set = await postIcon(`/servers/${serverId}/icon`, owner);
    const cleared = await call('DELETE', `/servers/${serverId}/icon`, undefined, owner);
    assert.equal(cleared.status, 200);

    const mine = await call('GET', '/servers', undefined, owner);
    assert.equal(mine.data.servers.find((s) => s.id === serverId).iconUrl, null);
    assert.equal((await fetch(base + set.data.url)).status, 404);
  });

  test('server icon: the public commons is protected', async () => {
    const res = await postIcon('/servers/demo/icon', owner);
    assert.equal(res.status, 400);
  });

  test('deleting a server removes its icon file', async () => {
    const made = await call('POST', '/servers', { name: 'Throwaway' }, owner);
    const id = made.data.server.id;
    const icon = await postIcon(`/servers/${id}/icon`, owner);
    const iconPath = path.join(server.dataDir, 'tile-icons', path.basename(icon.data.url));
    assert.ok(fs.existsSync(iconPath));

    await call('DELETE', `/servers/${id}`, undefined, owner);
    assert.ok(!fs.existsSync(iconPath), 'the icon does not outlive its server');
  });
});
