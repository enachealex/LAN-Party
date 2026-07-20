// Test harness: boots the real server as a child process against a throwaway DATA_DIR, so tests
// exercise the actual HTTP surface (routes, middleware, validation, SQLite) with no mocking and no
// changes to index.js. Each test file gets its own server + database, so they're fully isolated.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Spread test files across ports so parallel files never collide.
let nextPort = 3400 + Math.floor(Math.random() * 300);

// A survivng child keeps the runner's stdio pipes open, which hangs the whole test command. Track
// every spawned server and make sure they're gone when this process exits, however it exits.
/** @type {Set<import('node:child_process').ChildProcess>} */
const running = new Set();
let cleanupHooked = false;
function hookCleanup() {
  if (cleanupHooked) return;
  cleanupHooked = true;
  const killAll = () => { for (const c of running) { try { c.kill('SIGKILL'); } catch (_) { /* already gone */ } } running.clear(); };
  process.on('exit', killAll);
  process.on('SIGINT', () => { killAll(); process.exit(130); });
  process.on('uncaughtException', (err) => { killAll(); throw err; });
}

async function startServer() {
  hookCleanup();
  const port = nextPort++;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanparty-test-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, JWT_SECRET: 'test-secret' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.on('exit', () => running.delete(child));

  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}):\n${log}`);
    // Any HTTP response (even 401) means it's listening.
    try { await fetch(`${base}/servers`); break } catch (_) { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`server did not start within 20s:\n${log}`);
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    base,
    dataDir,
    log: () => log,
    async stop() {
      if (child.exitCode === null) {
        // SIGKILL: a lingering server holds the runner's pipes open and hangs the test command.
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGKILL');
        await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      }
      running.delete(child);
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    },
  };
}

// Minimal API client: returns { status, data } and never throws on non-2xx.
function apiFor(base) {
  return async function call(method, route, body, token) {
    /** @type {Record<string,string>} */
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (body instanceof FormData) {
      payload = body; // let fetch set the multipart boundary
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + route, { method, headers, body: payload });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty or non-JSON body */ }
    return { status: res.status, data };
  };
}

const PASSWORD = 'Test123!pw';

// Register + log in, returning the auth token.
async function makeUser(call, username) {
  await call('POST', '/auth/register', {
    username, email: `${username}@example.com`, password: PASSWORD, passwordConfirm: PASSWORD,
  });
  const res = await call('POST', '/auth/login', { username, password: PASSWORD });
  if (!res.data || !res.data.token) throw new Error(`login failed for ${username}: ${JSON.stringify(res)}`);
  return res.data.token;
}

// Read straight from a test server's SQLite file, so tests can assert what was actually persisted
// (coerced types, truncated fields) rather than only what the API echoed back.
async function dbAll(dataDir, sql, params = []) {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(path.join(dataDir, 'data.sqlite'));
  try {
    return await new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  } finally {
    db.close();
  }
}

module.exports = { startServer, apiFor, makeUser, dbAll, PASSWORD };
