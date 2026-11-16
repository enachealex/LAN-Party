// The shared GIF library: LAN Party's own, kept on this server, searched here. No third-party GIF
// service is involved: every GIF is a file in DATA_DIR/gifs (outside /uploads, so the 7-day upload
// sweep never touches it) and a row in `gifs`.
//
// A GIF arrives one of three ways, all through addGifFile():
//   - uploaded in the picker (POST /gifs),
//   - saved from a chat message (POST /gifs/from-upload: a copy of the /uploads/ file, which would
//     otherwise be deleted with the rest of the uploads after 7 days),
//   - imported in bulk from a folder on the server (scripts/import-gifs.js).
//
// What is stored is decided from the file's own first bytes, never from its name or a client's
// say-so: a GIF, PNG, JPEG, WebP or AVIF image, kept under a generated name with the extension of
// what it really is. The same picture twice is kept once (sha256 of the bytes).
//
// Tags are lowercase words, stored space-separated. A search matches every word of the query
// against the name or the tags.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TAGS = 12;
const MAX_TAG_LENGTH = 24;
const NAME_MAX = 80;
const PAGE_DEFAULT = 60;
const PAGE_MAX = 200;

/**
 * The image type of a file's first bytes, or null for anything that is not one of the library's
 * types. @param {Buffer} head at least 16 bytes when the file has them
 * @returns {{ type: string, ext: string } | null}
 */
function sniffImage(head) {
  if (!head || head.length < 4) return null;
  const ascii = (from, to) => head.subarray(from, to).toString('latin1');
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return { type: 'image/gif', ext: '.gif' };
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return { type: 'image/png', ext: '.png' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { type: 'image/jpeg', ext: '.jpg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image/webp', ext: '.webp' };
  if (ascii(4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 12))) return { type: 'image/avif', ext: '.avif' };
  return null;
}

/** @param {string} file @returns {Promise<Buffer>} */
async function readHead(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** @param {string} file @returns {Promise<string>} */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Tags from what a person typed ("funny, cat  Reaction") or a list: lowercase words of letters,
 * digits, - and _, deduplicated, at most MAX_TAGS. Anything else is a separator.
 * @param {unknown} input @returns {string[]}
 */
function normalizeTags(input) {
  const raw = Array.isArray(input) ? input.join(' ') : typeof input === 'string' ? input : '';
  const out = [];
  for (const word of raw.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const tag = word.replace(/^[-_]+|[-_]+$/g, '').slice(0, MAX_TAG_LENGTH);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** A display name from a filename: no extension, separators as spaces. @param {string} file */
function nameFromFilename(file) {
  // An /uploads/ file is stored as "<time>-<random>-<original name>": only the original is a name.
  const stem = path.basename(String(file || '')).replace(/\.[^.]+$/, '').replace(/^\d{10,}-[a-z0-9]{6}-/i, '');
  return cleanName(stem.replace(/[_.]+/g, ' '));
}

/** @param {unknown} name */
function cleanName(name) {
  return (typeof name === 'string' ? name : '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** The row as the client sees it. @param {any} row @param {boolean} canManage */
function present(row, canManage) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    type: row.type,
    tags: row.tags ? row.tags.split(' ').filter(Boolean) : [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    canManage,
  };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * One page of the library, newest first. `before` is the id the previous page ended at.
 * @param {any} db @param {{ q?: unknown, before?: unknown, limit?: unknown }} opts
 * @returns {Promise<{ rows: any[], next: number | null }>}
 */
async function searchGifs(db, { q, before, limit } = {}) {
  const terms = normalizeTags(typeof q === 'string' ? q : '').slice(0, 6);
  const size = Math.min(PAGE_MAX, Math.max(1, parseInt(String(limit ?? PAGE_DEFAULT), 10) || PAGE_DEFAULT));
  const where = [];
  const params = [];
  for (const term of terms) {
    where.push("(lower(name) LIKE ? ESCAPE '\\' OR (' ' || tags) LIKE ? ESCAPE '\\')");
    params.push(`%${escapeLike(term)}%`, `% ${escapeLike(term)}%`);
  }
  const beforeId = parseInt(String(before ?? ''), 10);
  if (beforeId > 0) { where.push('id < ?'); params.push(beforeId); }
  const rows = await db.all(
    `SELECT id, name, url, type, tags, created_by, created_at FROM gifs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    ...params, size + 1
  );
  const more = rows.length > size;
  if (more) rows.length = size;
  return { rows, next: more ? rows[rows.length - 1].id : null };
}

/**
 * Put an image file into the library. The source is read, never moved, unless `move` (the picker's
 * upload, already written into gifsDir by multer, is moved into its final name).
 * @param {any} db
 * @param {{ gifsDir: string, source: string, name?: string, tags?: unknown, createdBy: string, move?: boolean }} opts
 * @returns {Promise<{ row: any, duplicate: boolean } | { error: string }>}
 */
async function addGifFile(db, { gifsDir, source, name, tags, createdBy, move = false }) {
  const kind = sniffImage(await readHead(source));
  if (!kind) {
    if (move) await fs.promises.unlink(source).catch(() => {});
    return { error: 'Only GIF, PNG, JPEG, WebP or AVIF images can be added to the GIF library' };
  }
  const sha256 = await hashFile(source);
  const existing = await db.get('SELECT id, name, url, type, tags, created_by, created_at FROM gifs WHERE sha256 = ?', sha256);
  if (existing) {
    if (move) await fs.promises.unlink(source).catch(() => {});
    return { row: existing, duplicate: true };
  }
  const filename = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${kind.ext}`;
  const target = path.join(gifsDir, filename);
  if (move) await fs.promises.rename(source, target);
  else await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  const finalName = cleanName(name) || nameFromFilename(source) || 'GIF';
  const result = await db.run(
    'INSERT INTO gifs (name, url, type, tags, sha256, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    finalName, `/gifs/${filename}`, kind.type, normalizeTags(tags).join(' '), sha256, createdBy, Date.now()
  );
  const row = await db.get('SELECT id, name, url, type, tags, created_by, created_at FROM gifs WHERE id = ?', result.lastID);
  return { row, duplicate: false };
}

/**
 * Fill in the hash of GIFs added before hashes were kept, so a re-upload of one of them is caught
 * as a duplicate. A file that is gone is left alone. @param {any} db @param {string} gifsDir
 * @returns {Promise<number>} how many were filled in
 */
async function backfillHashes(db, gifsDir) {
  const rows = await db.all("SELECT id, url FROM gifs WHERE sha256 IS NULL AND url LIKE '/gifs/%'");
  let done = 0;
  for (const row of rows) {
    const file = path.join(gifsDir, path.basename(row.url));
    try {
      await db.run('UPDATE gifs SET sha256 = ? WHERE id = ?', await hashFile(file), row.id);
      done += 1;
    } catch { /* missing file: nothing to compare against */ }
  }
  return done;
}

module.exports = {
  sniffImage, readHead, hashFile, normalizeTags, nameFromFilename, cleanName, present,
  searchGifs, addGifFile, backfillHashes, MAX_TAGS, NAME_MAX, PAGE_DEFAULT, PAGE_MAX,
};
