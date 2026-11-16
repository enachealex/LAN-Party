// TURN relay credentials (services/turnCredentials.js and GET /webrtc/ice). A relay spends the home
// connection's bandwidth on whoever holds a credential, so only a signed-in person may get one, it is
// minted for them, and it expires on its own.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startServer, apiFor, makeUser } = require('./helpers');
const { turnServerFor, turnConfigured, DEFAULT_TTL } = require('../services/turnCredentials');

const SECRET = 'test-turn-secret-not-real';
const URLS = 'turn:turn.example.test:3478?transport=udp,turn:turn.example.test:3478?transport=tcp';

describe('turnServerFor', () => {
  const env = { TURN_URLS: URLS, TURN_SECRET: SECRET };
  const now = () => 1_800_000_000_000;

  test('the coturn shared-secret scheme: <expiry>:<who>, HMAC-SHA1 of that in base64', () => {
    const t = turnServerFor('ann', { env, now });
    assert.deepEqual(t.urls, URLS.split(','));
    assert.equal(t.username, `${1_800_000_000 + DEFAULT_TTL}:ann`);
    assert.equal(t.credential, crypto.createHmac('sha1', SECRET).update(t.username).digest('base64'));
    assert.equal(t.expiresAt, 1_800_000_000 + DEFAULT_TTL);
  });

  test('a colon in a name cannot add a field to the username', () => {
    assert.match(turnServerFor('a:b', { env, now }).username, /^\d+:a_b$/);
  });

  test('the lifetime is configurable but never below ten minutes', () => {
    assert.equal(turnServerFor('ann', { env: { ...env, TURN_TTL_SECONDS: '3600' }, now }).expiresAt, 1_800_000_000 + 3600);
    assert.equal(turnServerFor('ann', { env: { ...env, TURN_TTL_SECONDS: '5' }, now }).expiresAt, 1_800_000_000 + DEFAULT_TTL);
  });

  test('nothing without URLs; the old fixed credential only when there is no secret', () => {
    assert.equal(turnServerFor('ann', { env: { TURN_SECRET: SECRET } }), null);
    assert.equal(turnConfigured({ TURN_SECRET: SECRET }), false);
    const fixed = turnServerFor('ann', { env: { TURN_URLS: URLS, TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' } });
    assert.deepEqual([fixed.username, fixed.credential], ['u', 'p']);
    assert.equal(turnServerFor('ann', { env: { TURN_URLS: URLS } }), null, 'URLs alone are not a relay anyone can use');
    assert.equal(turnConfigured({ TURN_URLS: URLS }), false);
    assert.equal(turnConfigured(env), true);
  });

  test('only turn: and turns: URLs are passed on', () => {
    assert.deepEqual(turnServerFor('ann', { env: { ...env, TURN_URLS: 'stun:x.test, turn:y.test:3478 ,http://z.test' } }).urls, ['turn:y.test:3478']);
  });
});

describe('GET /webrtc/ice', () => {
  let server, call, token;
  before(async () => {
    server = await startServer({ env: { TURN_URLS: URLS, TURN_SECRET: SECRET } });
    call = apiFor(server.base);
    token = await makeUser(call, 'icy');
  });
  after(async () => { await server.stop(); });

  const ice = async (auth) => {
    const res = await fetch(server.base + '/webrtc/ice', { headers: auth ? { Authorization: auth } : {} });
    return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
  };

  test('without a session: STUN only, still a 200', async () => {
    const r = await ice();
    assert.equal(r.status, 200);
    assert.equal(r.body.iceServers.length, 1);
    assert.match(String(r.body.iceServers[0].urls), /^stun:/);
    assert.equal(r.body.ttl, undefined);
  });

  test('a bad or foreign token is the same as none', async () => {
    for (const auth of ['Bearer nonsense', 'Bearer ' + require('jsonwebtoken').sign({ username: 'icy' }, 'some-other-secret'), 'Basic aWN5OnB3']) {
      const r = await ice(auth);
      assert.equal(r.body.iceServers.length, 1, auth);
    }
  });

  test('a signed-in person gets a relay credential made for them, which the relay can check', async () => {
    const r = await ice('Bearer ' + token);
    assert.equal(r.status, 200);
    assert.equal(r.cache, 'no-store');
    const turn = r.body.iceServers.find((s) => [].concat(s.urls).some((u) => u.startsWith('turn:')));
    assert.ok(turn, 'a TURN entry');
    assert.match(turn.username, /^\d+:icy$/);
    const expiry = Number(turn.username.split(':')[0]);
    assert.ok(expiry > Date.now() / 1000 + 3600, 'expires in the future');
    assert.equal(turn.credential, crypto.createHmac('sha1', SECRET).update(turn.username).digest('base64'));
    assert.ok(r.body.ttl > 3600 && r.body.ttl <= DEFAULT_TTL);
    assert.ok(!JSON.stringify(r.body).includes(SECRET), 'the secret itself never leaves the server');
  });

  test('the diagnostics say a relay is set up', async () => {
    const res = await call('GET', '/webrtc/diagnostics', undefined, token);
    assert.equal(res.data.turnConfigured, true);
  });
});
