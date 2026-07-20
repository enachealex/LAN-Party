// Locks in the POST /feedback contract: what's accepted, what's rejected, the exact error strings
// the client renders, and what actually lands in the database after coercion.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');

describe('POST /feedback', () => {
  let server, call, token;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    token = await makeUser(call, 'fbuser');
  });
  after(async () => { await server.stop(); });

  // The real client submits multipart (it may carry a screenshot), so tests do too.
  const form = (fields) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };

  test('accepts a valid submission', async () => {
    const res = await call('POST', '/feedback', form({ type: 'feedback', message: 'Love the app' }), token);
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  });

  test('requires authentication', async () => {
    const res = await call('POST', '/feedback', form({ type: 'feedback', message: 'anon' }));
    assert.equal(res.status, 401);
  });

  test('defaults a missing type to feedback', async () => {
    const res = await call('POST', '/feedback', form({ message: 'no type supplied' }), token);
    assert.equal(res.status, 200);
    const [row] = await dbAll(server.dataDir, 'SELECT type FROM feedback WHERE message = ?', ['no type supplied']);
    assert.equal(row.type, 'feedback');
  });

  test('matches the type case-insensitively and stores it lowercased', async () => {
    const res = await call('POST', '/feedback', form({ type: 'BUG', message: 'shouty type' }), token);
    assert.equal(res.status, 200);
    const [row] = await dbAll(server.dataDir, 'SELECT type FROM feedback WHERE message = ?', ['shouty type']);
    assert.equal(row.type, 'bug');
  });

  test('truncates an over-long subject instead of rejecting it', async () => {
    const res = await call('POST', '/feedback', form({ type: 'feedback', title: 'T'.repeat(300), message: 'long subject' }), token);
    assert.equal(res.status, 200);
    const [row] = await dbAll(server.dataDir, 'SELECT title FROM feedback WHERE message = ?', ['long subject']);
    assert.equal(row.title.length, 160);
  });

  test('rejects an unknown type', async () => {
    const res = await call('POST', '/feedback', form({ type: 'spam', message: 'x' }), token);
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Invalid feedback type');
  });

  test('rejects a missing message', async () => {
    const res = await call('POST', '/feedback', form({ type: 'feedback' }), token);
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Message is required');
  });

  test('rejects a whitespace-only message', async () => {
    const res = await call('POST', '/feedback', form({ type: 'feedback', message: '   ' }), token);
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Message is required');
  });

  test('rejects a message over 8000 characters', async () => {
    const res = await call('POST', '/feedback', form({ type: 'feedback', message: 'x'.repeat(8100) }), token);
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'Message is too long (max 8000 characters)');
  });

  test('stores the submitter identity from the account, not the request', async () => {
    await call('POST', '/feedback', form({ type: 'request', message: 'identity check', username: 'attacker' }), token);
    const [row] = await dbAll(server.dataDir, 'SELECT username, email FROM feedback WHERE message = ?', ['identity check']);
    assert.equal(row.username, 'fbuser');
    assert.equal(row.email, 'fbuser@example.com');
  });
});
