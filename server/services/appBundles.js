// @ts-check
// Extracts an uploaded mini-app (a single .html file, or a .zip of html/js/css/assets) into a
// per-app directory that the server then serves — sandboxed — as an embeddable app.
//
// Security: these files are served to browsers and their JS runs, so extraction is hardened against
// the two classic archive attacks — zip-slip (entry paths like ../../etc that escape the target dir)
// and zip-bombs (tiny archive, enormous output). The runtime isolation (opaque-origin CSP sandbox)
// is applied where the files are SERVED, not here.
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024; // 60 MB uncompressed across the whole bundle
const MAX_ENTRY_BYTES = 25 * 1024 * 1024; // 25 MB for any single file

/**
 * Reject absolute paths, drive letters, and any traversal that escapes the bundle root.
 * @param {string} entryName
 * @returns {string | null} the normalized relative path, or null if unsafe
 */
function safeRelativePath(entryName) {
  const cleaned = String(entryName).replace(/\\/g, '/').replace(/^\/+/, '');
  if (!cleaned || cleaned.endsWith('/')) return null; // empty or a directory entry
  if (/^[a-zA-Z]:/.test(cleaned)) return null; // windows drive
  const norm = path.posix.normalize(cleaned);
  if (norm.startsWith('../') || norm === '..' || norm.includes('/../')) return null;
  return norm;
}

/**
 * Write a validated {relPath -> bytes} map under destDir, creating parent dirs. Re-checks each
 * resolved path stays within destDir (defence in depth against normalize edge cases).
 * @param {string} destDir @param {Record<string, Uint8Array>} files
 */
function writeFiles(destDir, files) {
  for (const [rel, bytes] of Object.entries(files)) {
    const target = path.resolve(destDir, rel);
    if (target !== destDir && !target.startsWith(destDir + path.sep)) {
      throw new Error(`unsafe path in archive: ${rel}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(bytes));
  }
}

/**
 * Pick the entry point: prefer a root index.html, else the shallowest index.html in the archive.
 * @param {string[]} relPaths
 * @returns {string | null}
 */
function findEntry(relPaths) {
  if (relPaths.includes('index.html')) return 'index.html';
  const indexes = relPaths.filter((p) => p.endsWith('/index.html') || p === 'index.html');
  indexes.sort((a, b) => a.split('/').length - b.split('/').length || a.length - b.length);
  return indexes[0] || null;
}

/**
 * Extract an uploaded bundle into destDir.
 * @param {{ buffer: Buffer, originalname: string, mimetype?: string }} file
 * @param {string} destDir  must not exist yet (created here)
 * @returns {{ entry: string }} the entry path relative to destDir (usually 'index.html')
 */
function extractBundle(file, destDir) {
  const name = (file.originalname || '').toLowerCase();
  const isZip = name.endsWith('.zip') || file.mimetype === 'application/zip' || file.mimetype === 'application/x-zip-compressed';
  const isHtml = name.endsWith('.html') || name.endsWith('.htm');

  fs.mkdirSync(destDir, { recursive: true });

  if (!isZip) {
    if (!isHtml) throw new Error('Upload a single .html file or a .zip bundle');
    if (file.buffer.length > MAX_ENTRY_BYTES) throw new Error('File is too large');
    fs.writeFileSync(path.join(destDir, 'index.html'), file.buffer);
    return { entry: 'index.html' };
  }

  let unzipped;
  try { unzipped = unzipSync(new Uint8Array(file.buffer)); }
  catch (_) { throw new Error('Could not read the .zip archive'); }

  /** @type {Record<string, Uint8Array>} */
  const safe = {};
  let count = 0;
  let total = 0;
  for (const [entryName, bytes] of Object.entries(unzipped)) {
    if (bytes.length === 0 && entryName.endsWith('/')) continue; // directory marker
    const rel = safeRelativePath(entryName);
    if (!rel) throw new Error(`Rejected unsafe path in zip: ${entryName}`);
    if (bytes.length > MAX_ENTRY_BYTES) throw new Error(`File too large in zip: ${rel}`);
    count += 1;
    total += bytes.length;
    if (count > MAX_FILES) throw new Error('Zip has too many files (max 300)');
    if (total > MAX_TOTAL_BYTES) throw new Error('Zip contents are too large (max 60 MB uncompressed)');
    safe[rel] = bytes;
  }

  const entry = findEntry(Object.keys(safe));
  if (!entry) throw new Error('Zip must contain an index.html');
  writeFiles(destDir, safe);
  return { entry };
}

module.exports = { extractBundle, safeRelativePath, findEntry, MAX_FILES, MAX_TOTAL_BYTES };
