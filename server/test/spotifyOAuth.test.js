// LAN Party's Spotify sign-in: the OAuth state is signed and short-lived, and is redeemable only in
// the browser that asked for it (a nonce cookie set on the authenticated request for the login url).
// The tokens go to the user the state names and to nobody else, and the popup posts them only to
// one of LAN Party's own origins.
//
// The real server runs against a stand-in for Spotify's token endpoint (SPOTIFY_TOKEN_URL, a test
// seam), so a code exchange can be seen happening, or not happening.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');
const { deriveKey } = require('../services/hostedApps');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COOKIE = 'lp_spotify_oauth';
const FAILED = /Spotify connection failed/;

describe('Spotify OAuth state and callback', () => {
  let server, base, call, tokens, tokenServer;
  /** @type {URLSearchParams[]} every code exchange the stand-in was asked for */
  const exchanges = [];
  const sockets = [];

  before(async () => {
    tokenServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        exchanges.push(params);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: `AT-${params.get('code')}`, refresh_token: 'RT', expires_in: 3600 }));
      });
    });
    await new Promise((resolve) => tokenServer.listen(0, '127.0.0.1', resolve));
    server = await startServer({
      env: {
        SPOTIFY_CLIENT_ID: 'test-client-id',
        SPOTIFY_CLIENT_SECRET: 'test-client-secret',
        SPOTIFY_TOKEN_URL: `http://127.0.0.1:${tokenServer.address().port}/api/token`,
        SPOTIFY_REDIRECT_URI: '',
        CLIENT_ORIGIN: 'https://lanparty.example.test',
      },
    });
    base = server.base;
    call = apiFor(base);
    tokens = {};
    for (const name of ['ann', 'ben']) tokens[name] = await makeUser(call, name);
  });
  after(async () => {
    for (const s of sockets) { try { s.close(); } catch (_) { /* closed */ } }
    await server.stop();
    await new Promise((resolve) => tokenServer.close(resolve));
  });

  // Ask for a login url as `who`, the way the client does. Returns the state and the cookie it set.
  async function startLogin(who, clientOrigin = base, headers = {}) {
    const res = await fetch(`${base}/music/spotify/login-url?client_origin=${encodeURIComponent(clientOrigin)}`, { headers: { Authorization: `Bearer ${tokens[who]}`, ...headers } });
    assert.equal(res.status, 200);
    const data = await res.json();
    const state = new URL(data.url).searchParams.get('state');
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${COOKIE}=`)) || '';
    const nonce = setCookie.slice(COOKIE.length + 1).split(';')[0];
    return { state, setCookie, cookie: `${COOKIE}=${nonce}`, nonce };
  }
  // Spotify's redirect back, with whatever cookie the browser has.
  async function callback({ state, code = 'the-code', cookie, error } = {}) {
    const q = new URLSearchParams();
    if (code) q.set('code', code);
    if (state !== undefined) q.set('state', state);
    if (error) q.set('error', error);
    const res = await fetch(`${base}/callback?${q}`, { headers: cookie ? { Cookie: cookie } : {} });
    return { status: res.status, text: await res.text(), setCookie: res.headers.getSetCookie() };
  }
  async function listen(who) {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token: tokens[who] } });
    sockets.push(socket);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.auths = [];
    socket.on('spotify:auth', (p) => socket.auths.push(p));
    await sleep(150); // the server puts the socket in its user room as it connects
    return socket;
  }
  // A state as the server would sign it, for the cases the server would never mint itself.
  const stateKey = deriveKey('test-secret', 'lanparty:spotify-oauth-state:v1');
  const forge = (payload, key = stateKey) => {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', key).update(body).digest('base64url')}`;
  };

  test('the login url sets a nonce cookie bound to the callback: HttpOnly, Lax, ten minutes, Secure behind https', async () => {
    const plain = await startLogin('ann');
    assert.match(plain.nonce, /^[A-Za-z0-9_-]{20,}$/);
    const attrs = plain.setCookie.split(';').map((s) => s.trim().toLowerCase());
    for (const want of ['httponly', 'samesite=lax', 'path=/callback', 'max-age=600']) assert.ok(attrs.includes(want), `${want} in ${plain.setCookie}`);
    assert.ok(!attrs.includes('secure'), 'plain http here, so not Secure');
    // The state is signed and carries the nonce; nothing in it is a token.
    const [body, sig] = plain.state.split('.');
    assert.ok(body && sig);
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    assert.equal(parsed.u, 'ann');
    assert.equal(parsed.o, base);
    assert.equal(parsed.n, plain.nonce);
    assert.ok(parsed.exp > Date.now() && parsed.exp <= Date.now() + 10 * 60 * 1000);
    // Behind the https proxy (trust proxy: the first hop's X-Forwarded-Proto counts).
    const behind = await startLogin('ann', base, { 'X-Forwarded-Proto': 'https' });
    assert.ok(behind.setCookie.split(';').map((s) => s.trim().toLowerCase()).includes('secure'), behind.setCookie);
  });

  test('the happy path: the code is exchanged once, the tokens go to the state\'s user only, and the popup posts to our own origin', async () => {
    const ann = await listen('ann');
    const ben = await listen('ben');
    const { state, cookie } = await startLogin('ann');
    const before = exchanges.length;
    const res = await callback({ state, cookie, code: 'happy' });
    assert.equal(res.status, 200);
    assert.match(res.text, /Connected to Spotify/);
    assert.equal(exchanges.length, before + 1);
    assert.equal(exchanges.at(-1).get('code'), 'happy');
    assert.equal(exchanges.at(-1).get('grant_type'), 'authorization_code');
    // Posted to the origin the client named, which is this server's own, and never to '*'.
    assert.ok(res.text.includes(`postMessage(`), 'the opener is told');
    assert.ok(res.text.includes(JSON.stringify(base)), 'to this origin');
    assert.ok(!res.text.includes('"*"'));
    // The nonce is spent.
    assert.ok(res.setCookie.some((c) => c.startsWith(`${COOKIE}=;`) && /expires=thu, 01 jan 1970/i.test(c) && /path=\/callback/i.test(c)), res.setCookie.join(' | '));
    await sleep(200);
    assert.deepEqual(ann.auths.map((a) => a.access_token), ['AT-happy']);
    assert.deepEqual(ben.auths, []);
    // A configured CLIENT_ORIGIN is one of our own origins too.
    const second = await startLogin('ann', 'https://lanparty.example.test');
    const posted = await callback({ state: second.state, cookie: second.cookie, code: 'configured' });
    assert.ok(posted.text.includes(JSON.stringify('https://lanparty.example.test')));
  });

  test('a foreign origin in the state is never posted to; the tokens still reach the user over their socket', async () => {
    const ann = await listen('ann');
    for (const origin of ['https://evil.example', '*', 'null', 'https://lanparty.example.test.evil.example', `${base}/path`, 'javascript:alert(1)', '']) {
      const { state, cookie } = await startLogin('ann', origin);
      const res = await callback({ state, cookie, code: `foreign-${origin.length}` });
      assert.equal(res.status, 200, origin);
      assert.match(res.text, /Connected to Spotify/, origin);
      assert.ok(!res.text.includes('postMessage'), `${origin}: no message at all`);
      assert.ok(!res.text.includes('access_token'), `${origin}: the tokens are not in the page`);
    }
    await sleep(200);
    assert.equal(ann.auths.length, 7);
  });

  test('a forged, tampered, unsigned or expired state is refused before any code is exchanged', async () => {
    const ann = await listen('ann');
    const ben = await listen('ben');
    // Ben starts a flow of his own, so he holds a real cookie, and tries to point it at Ann.
    const { state, cookie, nonce } = await startLogin('ben');
    const [body, sig] = state.split('.');
    const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), u: 'ann' })).toString('base64url');
    const before = exchanges.length;
    const refused = {
      'the old unsigned shape': Buffer.from(JSON.stringify({ u: 'ann', o: base })).toString('base64url'),
      'unsigned, with a nonce': Buffer.from(JSON.stringify({ u: 'ann', o: base, n: nonce, exp: Date.now() + 60000 })).toString('base64url'),
      'the user swapped, signature kept': `${swapped}.${sig}`,
      'a signature from another secret': forge({ u: 'ann', o: base, n: nonce, exp: Date.now() + 60000 }, deriveKey('not-the-secret', 'lanparty:spotify-oauth-state:v1')),
      'signed with the base secret itself': forge({ u: 'ann', o: base, n: nonce, exp: Date.now() + 60000 }, Buffer.from('test-secret')),
      'expired': forge({ u: 'ben', o: base, n: nonce, exp: Date.now() - 1000 }),
      'no expiry': forge({ u: 'ben', o: base, n: nonce }),
      'no user': forge({ o: base, n: nonce, exp: Date.now() + 60000 }),
      'three parts': `${state}.x`,
      'empty': '',
      'garbage': 'not.a.state',
    };
    for (const [label, forged] of Object.entries(refused)) {
      const res = await callback({ state: forged, cookie, code: `forged-${label}` });
      assert.match(res.text, FAILED, label);
      assert.ok(!res.text.includes('postMessage'), label);
    }
    // No state at all, an error from Spotify, or no code.
    assert.match((await callback({ cookie })).text, FAILED);
    assert.match((await callback({ state, cookie, error: 'access_denied' })).text, FAILED);
    assert.match((await callback({ state, cookie, code: '' })).text, FAILED);
    assert.equal(exchanges.length, before, 'Spotify was never asked');
    // A state the server did sign, in date, with the right nonce, is accepted — the forge helper is
    // not wrong about the format.
    const fresh = await startLogin('ben');
    const good = forge({ u: 'ben', o: base, n: fresh.nonce, exp: Date.now() + 60000 });
    assert.match((await callback({ state: good, cookie: fresh.cookie, code: 'forged-but-right' })).text, /Connected/);
    await sleep(200);
    assert.deepEqual(ann.auths, [], 'Ann was never sent anyone\'s tokens');
    assert.deepEqual(ben.auths.map((a) => a.access_token), ['AT-forged-but-right']);
  });

  test('a valid state is refused without the cookie of the browser that asked for it', async () => {
    const ann = await listen('ann');
    const mine = await startLogin('ann');
    const theirs = await startLogin('ben');
    const before = exchanges.length;
    for (const [label, cookie] of Object.entries({
      'no cookie': undefined,
      'an empty cookie': `${COOKIE}=`,
      'someone else\'s nonce': theirs.cookie,
      'a nonce one character off': `${COOKIE}=${mine.nonce.slice(0, -1)}${mine.nonce.endsWith('A') ? 'B' : 'A'}`,
      'the nonce under another name': `other=${mine.nonce}`,
    })) {
      const res = await callback({ state: mine.state, cookie, code: `nocookie-${label}` });
      assert.match(res.text, FAILED, label);
    }
    assert.equal(exchanges.length, before);
    await sleep(150);
    assert.deepEqual(ann.auths, []);
    // With it, among other cookies, it goes through.
    const ok = await callback({ state: mine.state, cookie: `a=1; ${mine.cookie}; b=2`, code: 'with-cookie' });
    assert.match(ok.text, /Connected/);
  });
});
