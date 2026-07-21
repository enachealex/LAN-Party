// @ts-check
// A tiny, dependency-free migration runner for the SQLite database.
//
// Replaces the old `try { ALTER TABLE ... } catch {}` pattern, which had three problems: it swallowed
// *every* error (not just "column already exists"), it had no ordering, and it left no record of what
// had run. Here each migration is named and applied exactly once, recorded in `schema_migrations`, and
// any failure propagates — a broken migration aborts boot instead of being silently ignored.

/**
 * @typedef {{
 *   exec: (sql: string) => Promise<any>,
 *   run: (sql: string, ...params: any[]) => Promise<any>,
 *   get: (sql: string, ...params: any[]) => Promise<any>,
 *   all: (sql: string, ...params: any[]) => Promise<any[]>,
 * }} Db
 * @typedef {{ name: string, up: (db: Db) => Promise<void> }} Migration
 */

/**
 * Add a column only if it's missing, checked via PRAGMA rather than by catching an error — so a
 * genuine failure (missing table, bad definition) still surfaces. SQLite has no ADD COLUMN IF NOT
 * EXISTS, which is why the old code used try/catch. Column/table names are code-controlled, never
 * user input.
 * @param {Db} db @param {string} table @param {string} column @param {string} definition
 * @returns {Promise<boolean>} true if the column was added, false if it already existed
 */
async function addColumn(db, table, column, definition) {
  const cols = await db.all(`PRAGMA table_info(${table})`);
  if (cols.some((c) => c.name === column)) return false;
  await db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  return true;
}

/**
 * Run every not-yet-applied migration in order, recording each as it completes.
 * @param {Db} db @param {Migration[]} migrations
 * @returns {Promise<string[]>} names of the migrations that ran this time
 */
async function runMigrations(db, migrations) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const done = new Set((await db.all(`SELECT name FROM schema_migrations`)).map((r) => r.name));
  const ran = [];
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    await m.up(db); // no try/catch: a failure here must stop boot, not be swallowed
    await db.run(`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`, m.name, Date.now());
    ran.push(m.name);
  }
  return ran;
}

module.exports = { addColumn, runMigrations };
