#!/usr/bin/env node
// Import a folder of GIFs (and PNG/JPEG/WebP/AVIF images) into LAN Party's GIF library.
//
//   DATA_DIR=/mnt/data/lan-party/data node scripts/import-gifs.js <folder> [--by <username>] [--dry-run]
//
// Every image under <folder> is copied into DATA_DIR/gifs and listed in the library; the folder is
// left as it was, so it can be run again after adding more: anything already in the library (the
// same bytes, wherever it came from) is skipped.
//
//   name   the file's name, without its extension ("happy_dance.gif" -> "happy dance")
//   tags   the folders it sits in, below <folder> ("reactions/happy/x.gif" -> reactions, happy)
//   by     who it is listed as added by (default "library"); that account, and the instance
//          owners, may rename or remove it in the picker
//
// Safe to run while the server is up: it only adds rows and files, and waits for the database if
// the server is writing at that moment. Run from the server/ folder, with the server's DATA_DIR.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { migrate } = require('../db/schema');
const gifLibrary = require('../services/gifLibrary');

const IMAGE_EXT = new Set(['.gif', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.apng']);

function usage(message) {
  if (message) console.error(message);
  console.error('Usage: DATA_DIR=<data dir> node scripts/import-gifs.js <folder> [--by <username>] [--dry-run]');
  process.exit(2);
}

/** Every image file under dir, as paths relative to it. @param {string} root */
function listImages(root) {
  const out = [];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) out.push(child);
    }
  };
  walk('');
  return out.sort();
}

async function main(argv) {
  const args = [...argv];
  const dryRun = args.includes('--dry-run');
  const byAt = args.indexOf('--by');
  const by = byAt >= 0 ? args[byAt + 1] : 'library';
  if (byAt >= 0 && (!by || by.startsWith('--'))) usage('--by needs a username');
  const positional = args.filter((a, i) => !a.startsWith('--') && (byAt < 0 || i !== byAt + 1));
  if (positional.length !== 1) usage();
  const folder = path.resolve(positional[0]);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) usage(`Not a folder: ${folder}`);

  const dataDir = process.env.DATA_DIR || path.join(__dirname, '..');
  const dbFile = path.join(dataDir, 'data.sqlite');
  if (!fs.existsSync(dbFile)) usage(`No database at ${dbFile}. Set DATA_DIR to the server's data folder.`);
  const gifsDir = path.join(dataDir, 'gifs');
  fs.mkdirSync(gifsDir, { recursive: true });

  const files = listImages(folder);
  console.log(`${files.length} image${files.length === 1 ? '' : 's'} under ${folder}${dryRun ? ' (dry run: nothing is written)' : ''}`);
  const db = await open({ filename: dbFile, driver: sqlite3.Database });
  await db.exec('PRAGMA busy_timeout = 10000');
  await migrate(db); // a no-op on a server that is up to date
  await gifLibrary.backfillHashes(db, gifsDir);

  const counts = { added: 0, duplicate: 0, refused: 0 };
  for (const rel of files) {
    const source = path.join(folder, rel);
    const tags = path.dirname(rel) === '.' ? [] : path.dirname(rel).split(path.sep);
    const name = gifLibrary.nameFromFilename(rel);
    if (dryRun) {
      const kind = gifLibrary.sniffImage(await gifLibrary.readHead(source));
      const dupe = kind && (await db.get('SELECT id FROM gifs WHERE sha256 = ?', await gifLibrary.hashFile(source)));
      const verdict = !kind ? 'refused (not an image)' : dupe ? 'already in the library' : 'would add';
      console.log(`  ${verdict}: ${rel}  name="${name}" tags=[${gifLibrary.normalizeTags(tags).join(', ')}]`);
      counts[!kind ? 'refused' : dupe ? 'duplicate' : 'added'] += 1;
      continue;
    }
    const result = await gifLibrary.addGifFile(db, { gifsDir, source, name, tags, createdBy: by });
    if ('error' in result) { counts.refused += 1; console.log(`  refused (not an image): ${rel}`); }
    else if (result.duplicate) counts.duplicate += 1;
    else counts.added += 1;
  }
  await db.close();
  console.log(`${dryRun ? 'Would add' : 'Added'} ${counts.added}, already there ${counts.duplicate}, refused ${counts.refused}.`);
}

main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
