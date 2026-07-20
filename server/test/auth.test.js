// Baseline for the auth surface — registration rules, login, and token-gated access.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, apiFor, makeUser, PASSWORD } = require('./helpers');

describe('auth', () => {
  let server, call;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
  });
  after(async () => { await server.stop(); });

  const register = (fields) =>
    call('POST', '/auth/register', { password: PASSWORD, passwordConfirm: PASSWORD, ...fields });

  test('registers a new user', async () => {
    const res = await register({ username: 'alice', email: 'alice@example.com' });
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
  });

  test('rejects a duplicate username', async () => {
    const res = await register({ username: 'alice', email: 'other@example.com' });
    assert.equal(res.status, 409);
    assert.equal(res.data.field, 'username');
  });

  test('rejects mismatched password confirmation', async () => {
    const res = await call('POST', '/auth/register', {
      username: 'mismatch', email: 'mismatch@example.com', password: PASSWORD, passwordConfirm: 'Different1!',
    });
    assert.equal(res.status, 400);
  });

  test('rejects a weak password', async () => {
    const res = await call('POST', '/auth/register', {
      username: 'weak', email: 'weak@example.com', password: 'password', passwordConfirm: 'password',
    });
    assert.equal(res.status, 400);
  });

  test('rejects an invalid email', async () => {
    const res = await register({ username: 'bademail', email: 'not-an-email' });
    assert.equal(res.status, 400);
  });

  test('logs in with the right password and returns a token', async () => {
    const res = await call('POST', '/auth/login', { username: 'alice', password: PASSWORD });
    assert.equal(res.status, 200);
    assert.ok(res.data.token, 'expected a token');
  });

  test('refuses the wrong password', async () => {
    const res = await call('POST', '/auth/login', { username: 'alice', password: 'WrongPass1!' });
    assert.notEqual(res.status, 200);
    assert.ok(!res.data?.token);
  });

  test('/auth/me requires a token', async () => {
    const res = await call('GET', '/auth/me');
    assert.equal(res.status, 401);
  });

  test('/auth/me returns the signed-in user', async () => {
    const token = await makeUser(call, 'bob');
    const res = await call('GET', '/auth/me', undefined, token);
    assert.equal(res.status, 200);
    assert.equal(res.data.user.username, 'bob');
  });

  test('rejects a garbage token', async () => {
    const res = await call('GET', '/auth/me', undefined, 'not-a-real-token');
    assert.equal(res.status, 401);
  });
});
