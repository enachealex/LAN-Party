// The desktop installer / updater feed. It must stay cacheable by Cloudflare: marked private, every
// request (a partial or abandoned one included) pulled the full 111 MB installer through the home
// uplink, instead of the edge serving it from cache after a cheap 304 revalidation.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer } = require('./helpers');

describe('/downloads', () => {
  let server;

  before(async () => {
    server = await startServer();
    const dir = path.join(server.dataDir, 'downloads');
    fs.writeFileSync(path.join(dir, 'LAN-Party-Setup.exe'), Buffer.alloc(4096, 7));
    fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 9.9.9\n');
  });
  after(() => server?.stop());

  test('installer and feed stay cacheable, with an ETag so the CDN can revalidate cheaply', async () => {
    for (const file of ['LAN-Party-Setup.exe', 'latest.yml']) {
      const res = await fetch(`${server.base}/downloads/${file}`);
      assert.equal(res.status, 200, file);
      assert.doesNotMatch(res.headers.get('cache-control') || '', /\b(private|no-store)\b/, `${file} Cache-Control`);
      const etag = res.headers.get('etag');
      assert.ok(etag, `${file} has an ETag`);
      await res.arrayBuffer();
      // An explicit Cache-Control, or fetch adds "no-cache" to any conditional request (per the Fetch
      // spec), and the server rightly answers that with a full 200. The CDN's revalidation sends none.
      const again = await fetch(`${server.base}/downloads/${file}`, { headers: { 'If-None-Match': etag, 'Cache-Control': 'max-age=0' } });
      assert.equal(again.status, 304, `${file} revalidates to a 304`);
      await again.arrayBuffer();
    }
  });

  test('range requests still work (the updater downloads differential blocks)', async () => {
    const res = await fetch(`${server.base}/downloads/LAN-Party-Setup.exe`, { headers: { Range: 'bytes=100-199' } });
    assert.equal(res.status, 206);
    assert.equal((await res.arrayBuffer()).byteLength, 100);
  });

  test('a missing file is a 404, not the app shell', async () => {
    const res = await fetch(`${server.base}/downloads/nope.exe`);
    assert.notEqual(res.status, 200);
    await res.arrayBuffer();
  });
});
