// Unit tests for mini-app bundle extraction — the security-sensitive part. Focus on the guards:
// zip-slip (paths escaping the target), the index.html requirement, and single-file handling.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { extractBundle, safeRelativePath, findEntry } = require('../services/appBundles');

const tmpDirs = [];
const freshDest = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-')); fs.rmSync(d, { recursive: true, force: true }); tmpDirs.push(d); return d; };
afterEach(() => { for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });

const zipFile = (files) => ({ originalname: 'app.zip', mimetype: 'application/zip', buffer: Buffer.from(zipSync(files)) });

describe('safeRelativePath', () => {
  test('accepts normal nested paths', () => {
    assert.equal(safeRelativePath('index.html'), 'index.html');
    assert.equal(safeRelativePath('js/app.js'), 'js/app.js');
    assert.equal(safeRelativePath('a/b/c.css'), 'a/b/c.css');
  });
  test('rejects traversal and drive paths', () => {
    assert.equal(safeRelativePath('../secret'), null);
    assert.equal(safeRelativePath('a/../../b'), null);
    assert.equal(safeRelativePath('C:/Windows/x'), null);
  });
  test('strips a leading slash to keep the entry contained (not an escape)', () => {
    // A leading "/" is normalized away, so "/etc/passwd" lands at <bundle>/etc/passwd — safe.
    assert.equal(safeRelativePath('/etc/passwd'), 'etc/passwd');
  });
});

describe('findEntry', () => {
  test('prefers a root index.html', () => {
    assert.equal(findEntry(['sub/index.html', 'index.html']), 'index.html');
  });
  test('falls back to the shallowest index.html', () => {
    assert.equal(findEntry(['deep/a/index.html', 'sub/index.html']), 'sub/index.html');
  });
  test('null when there is none', () => {
    assert.equal(findEntry(['app.js', 'style.css']), null);
  });
});

describe('extractBundle', () => {
  test('stores a single .html as index.html', () => {
    const dest = freshDest();
    const { entry } = extractBundle({ originalname: 'game.html', buffer: Buffer.from('<h1>hi</h1>') }, dest);
    assert.equal(entry, 'index.html');
    assert.equal(fs.readFileSync(path.join(dest, 'index.html'), 'utf8'), '<h1>hi</h1>');
  });

  test('rejects a non-html, non-zip file', () => {
    assert.throws(() => extractBundle({ originalname: 'evil.js', buffer: Buffer.from('x') }, freshDest()), /single \.html/);
  });

  test('extracts a valid multi-file zip and finds the entry', () => {
    const dest = freshDest();
    const { entry } = extractBundle(zipFile({
      'index.html': strToU8('<script src="app.js"></script>'),
      'app.js': strToU8('console.log(1)'),
      'css/style.css': strToU8('body{}'),
    }), dest);
    assert.equal(entry, 'index.html');
    assert.ok(fs.existsSync(path.join(dest, 'app.js')));
    assert.ok(fs.existsSync(path.join(dest, 'css', 'style.css')));
  });

  test('rejects a zip with no index.html', () => {
    assert.throws(() => extractBundle(zipFile({ 'app.js': strToU8('x') }), freshDest()), /index\.html/);
  });

  test('refuses a zip-slip entry and writes nothing outside the dir', () => {
    const dest = freshDest();
    assert.throws(
      () => extractBundle(zipFile({ 'index.html': strToU8('ok'), '../escape.txt': strToU8('pwned') }), dest),
      /unsafe path/i,
    );
    // The traversal target must not exist.
    assert.equal(fs.existsSync(path.join(path.dirname(dest), 'escape.txt')), false);
  });
});
