// Vault Player SSO handoff. The security properties are the point of these tests: the assertion must
// be scoped to Vault, must NOT be verifiable with the LAN Party session secret, and userinfo must
// refuse anything that isn't a valid, unexpired, correctly-addressed assertion.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { startServer, apiFor, makeUser } = require('./helpers');

const SSO_SECRET = 'test-vault-sso-secret';
const JWT_SECRET = 'test-secret'; // what helpers.js boots the server with

describe('vault player SSO', () => {
  let server, call, base, token;

  before(async () => {
    server = await startServer({ env: { VAULT_SSO_SECRET: SSO_SECRET } });
    call = apiFor(server.base);
    base = server.base;
    token = await makeUser(call, 'watcher');
  });
  after(async () => { await server.stop(); });

  const mint = () => call('POST', '/integrations/vault/sso-token', undefined, token);

  test('mints a short-lived assertion scoped to vault-player', async () => {
    const res = await mint();
    assert.equal(res.status, 200);
    assert.equal(res.data.audience, 'vault-player');
    assert.equal(res.data.expiresIn, 300);

    const claims = jwt.verify(res.data.token, SSO_SECRET, { algorithms: ['HS256'] });
    assert.equal(claims.iss, 'lanparty');
    assert.equal(claims.aud, 'vault-player');
    assert.equal(claims.sub, 'watcher');
    assert.equal(claims.name, 'watcher');
    assert.equal(claims.email, 'watcher@example.com', 'email claim is populated, not undefined');
    assert.ok(claims.jti, 'carries a jti so Vault can dedupe a consumed login');
    assert.ok(claims.exp - claims.iat <= 300, 'lifetime is at most 5 minutes');
  });

  test('the assertion is NOT signed with the LAN Party session secret', async () => {
    // The whole point of a separate secret: a leak on the Vault side must not forge LAN Party
    // sessions, and a LAN Party token must not be accepted as a Vault assertion.
    const res = await mint();
    assert.throws(() => jwt.verify(res.data.token, JWT_SECRET), /invalid signature/i);
  });

  test('minting requires a logged-in LAN Party user', async () => {
    const res = await call('POST', '/integrations/vault/sso-token');
    assert.equal(res.status, 401);
  });

  test('userinfo returns the user plus the friends graph', async () => {
    // Give the user one accepted friend so the list isn't trivially empty.
    const friendToken = await makeUser(call, 'buddy');
    await call('POST', '/friends/request', { username: 'buddy' }, token);
    const incoming = await call('GET', '/friends/requests/incoming', undefined, friendToken);
    await call('POST', `/friends/requests/${incoming.data.requests[0].id}/accept`, undefined, friendToken);

    const { data } = await mint();
    const res = await fetch(base + '/integrations/vault/userinfo', {
      headers: { Authorization: `Bearer ${data.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.issuer, 'lanparty');
    assert.equal(body.user.username, 'watcher');
    assert.equal(body.user.displayName, 'watcher');
    // Assert real VALUES, not just key presence — the original test only checked `'avatarUrl' in
    // body.user`, which passed happily while the endpoint returned null for the caller's own avatar
    // and email (getUserByUsername doesn't select settings/email).
    assert.equal(body.user.email, 'watcher@example.com', 'the caller gets their own email, not null');
    assert.match(body.user.avatarColor, /^#[0-9a-f]{6}$/i, 'avatarColor is a real colour');
    assert.ok('avatarUrl' in body.user, 'avatarUrl key is present (null until they upload one)');
    assert.ok(['available', 'idle', 'dnd', 'offline'].includes(body.user.status));

    assert.equal(body.friends.length, 1);
    assert.equal(body.friends[0].username, 'buddy');
    // Friends must never leak another user's email.
    assert.ok(!('email' in body.friends[0]), 'friend entries carry no email');
  });

  test('userinfo rejects a missing, malformed or wrong-secret assertion', async () => {
    const none = await fetch(base + '/integrations/vault/userinfo');
    assert.equal(none.status, 401);

    const junk = await fetch(base + '/integrations/vault/userinfo', { headers: { Authorization: 'Bearer not-a-jwt' } });
    assert.equal(junk.status, 401);

    // Correct claims, wrong signing key.
    const forged = jwt.sign({ iss: 'lanparty', aud: 'vault-player', sub: 'watcher' }, 'wrong-secret', { expiresIn: 60 });
    const bad = await fetch(base + '/integrations/vault/userinfo', { headers: { Authorization: `Bearer ${forged}` } });
    assert.equal(bad.status, 401);
  });

  test('userinfo rejects an expired assertion and one aimed at another audience', async () => {
    const expired = jwt.sign({ iss: 'lanparty', aud: 'vault-player', sub: 'watcher' }, SSO_SECRET, { expiresIn: -5 });
    const r1 = await fetch(base + '/integrations/vault/userinfo', { headers: { Authorization: `Bearer ${expired}` } });
    assert.equal(r1.status, 401);
    assert.match((await r1.json()).error, /expired/i);

    // Signed with the right key but minted for a different service — must not be usable here.
    const wrongAud = jwt.sign({ iss: 'lanparty', aud: 'some-other-app', sub: 'watcher' }, SSO_SECRET, { expiresIn: 60 });
    const r2 = await fetch(base + '/integrations/vault/userinfo', { headers: { Authorization: `Bearer ${wrongAud}` } });
    assert.equal(r2.status, 401);
  });
});

describe('vault player SSO when unconfigured', () => {
  let server, call, token;

  before(async () => {
    server = await startServer(); // no VAULT_SSO_SECRET
    call = apiFor(server.base);
    token = await makeUser(call, 'nosso');
  });
  after(async () => { await server.stop(); });

  test('both endpoints report unavailable rather than signing with a default key', async () => {
    const mintRes = await call('POST', '/integrations/vault/sso-token', undefined, token);
    assert.equal(mintRes.status, 503);
    const info = await fetch(server.base + '/integrations/vault/userinfo', { headers: { Authorization: 'Bearer x' } });
    assert.equal(info.status, 503);
  });
});
