// The desktop installer / updater feed must not be cacheable by Cloudflare: a cached 111 MB installer
// was served from the edge at a few KB/s, so /downloads has to go straight through the tunnel.
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

  test('installer and feed are marked private so the CDN streams them instead of caching', async () => {
    for (const file of ['LAN-Party-Setup.exe', 'latest.yml']) {
      const res = await fetch(`${server.base}/downloads/${file}`);
      assert.equal(res.status, 200, file);
      assert.match(res.headers.get('cache-control') || '', /\bprivate\b/, `${file} Cache-Control`);
      await res.arrayBuffer();
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
