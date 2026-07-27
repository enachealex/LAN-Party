// End-to-end HTTP tests for the mini-app bundle lifecycle: upload → hosted + sandboxed → delete.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const { startServer, apiFor, makeUser } = require('./helpers');

describe('app bundles (HTTP)', () => {
  let server, call, token, base;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    token = await makeUser(call, 'appdev');
  });
  after(async () => { await server.stop(); });

  const uploadBundle = async (name, file) => {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('bundle', new Blob([file.bytes], { type: file.type }), file.filename);
    return call('POST', '/apps/bundle', fd, token);
  };

  test('uploads a single-file HTML app and hosts it, sandboxed', async () => {
    const res = await uploadBundle('Solo App', { bytes: strToU8('<h1 id="x">hello</h1>'), type: 'text/html', filename: 'solo.html' });
    assert.equal(res.status, 200);
    const app = res.data.apps.find((a) => a.name === 'Solo App');
    assert.ok(app, 'app created');
    assert.equal(app.kind, 'bundle');
    assert.equal(app.embeddable, true);
    assert.match(app.url, /^\/app-bundles\/[^/]+\/$/, 'internal hosted path');

    // The hosted file is served AND carries the isolating sandbox CSP.
    const page = await fetch(base + app.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /hello/);
    const csp = page.headers.get('content-security-policy') || '';
    assert.match(csp, /sandbox/, 'served with a CSP sandbox');
    assert.ok(!/allow-same-origin/.test(csp), 'sandbox must NOT grant same-origin (opaque origin)');
  });

  test('uploads a multi-file zip and serves a nested asset', async () => {
    const zip = Buffer.from(zipSync({ 'index.html': strToU8('<script src="app.js"></script>'), 'app.js': strToU8('window.OK=1') }));
    const res = await uploadBundle('Zip App', { bytes: zip, type: 'application/zip', filename: 'app.zip' });
    assert.equal(res.status, 200);
    const app = res.data.apps.find((a) => a.name === 'Zip App');
    const asset = await fetch(base + app.url + 'app.js');
    assert.equal(asset.status, 200);
    assert.match(await asset.text(), /window\.OK/);
  });

  test('rejects a zip with no index.html', async () => {
    const zip = Buffer.from(zipSync({ 'main.js': strToU8('x') }));
    const res = await uploadBundle('No Index', { bytes: zip, type: 'application/zip', filename: 'app.zip' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /index\.html/);
  });

  test('requires a name', async () => {
    const fd = new FormData();
    fd.append('bundle', new Blob([strToU8('<h1>x</h1>')], { type: 'text/html' }), 'a.html');
    const res = await call('POST', '/apps/bundle', fd, token);
    assert.equal(res.status, 400);
  });

  test('a missing bundle path 404s instead of leaking the SPA shell', async () => {
    // The /app-bundles mount is terminal — an unknown path must not fall through to the client shell.
    const miss = await fetch(base + '/app-bundles/does-not-exist/index.html');
    assert.equal(miss.status, 404);
    assert.doesNotMatch(await miss.text(), /<!doctype html>/i, 'must not be the SPA HTML');
  });

  test('deleting a bundle app removes its hosted files', async () => {
    const up = await uploadBundle('Doomed', { bytes: strToU8('<h1>bye</h1>'), type: 'text/html', filename: 'd.html' });
    const app = up.data.apps.find((a) => a.name === 'Doomed');
    const before = await fetch(base + app.url);
    assert.equal(before.status, 200, 'served before delete');
    await before.text();
    const del = await call('DELETE', `/apps/${app.id}`, undefined, token);
    assert.equal(del.status, 200);
    const gone = await fetch(base + app.url);
    assert.equal(gone.status, 404, 'gone after delete');
    await gone.text();
  });
});
