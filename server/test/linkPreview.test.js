// Link previews (services/linkPreview.js): the one place the server fetches an address a member
// chose, from a home network with private services next to it. Most of this file is about what is
// REFUSED.
//
// NOTHING HERE TOUCHES THE NETWORK. Three layers, none of which can:
//   1. the rules on their own (addresses, URLs, names, hostile HTML): pure functions;
//   2. the fetcher, built with a resolver and a requester that are plain JavaScript objects in this
//      file (fakeNet), so "DNS" and "HTTP" are lookups in a table;
//   3. the real server, booted with LINK_PREVIEW_TRANSPORT pointing at
//      test/fixtures/fakeLinkTransport.js, which does the same from a JSON file.
// The single socket opened is to a throwaway HTTP server on 127.0.0.1, to prove the real requester
// connects to the address it is handed and never resolves the name.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const { startServer, apiFor, makeUserFromOwnAddress, dbAll } = require('./helpers');
const { migrate } = require('../db/schema');
const {
  createLinkPreviews, classifyAddress, checkUrl, checkHostname, previewLinkOf, ownHostnames, extractMetadata, cleanText,
  parsePreview, sniffImage, pinnedRequest, MAX_IMAGE_STORE_BYTES,
  MAX_URL_LENGTH, MAX_REDIRECTS, MAX_HTML_BYTES, MAX_IMAGE_BYTES, MAX_CONCURRENT, MAX_QUEUED, USER_FETCHES_PER_WINDOW,
  OK_TTL_MS, FAIL_TTL_MS, IMAGE_KEEP_MS, TITLE_MAX, DESCRIPTION_MAX, SITE_NAME_MAX, USER_AGENT,
} = require('../services/linkPreview');

const FAKE_TRANSPORT = path.join(__dirname, 'fixtures', 'fakeLinkTransport.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait for something to become true rather than for a length of time: these suites run beside
// forty others, and "it will have happened within 50ms" is not something a busy machine promises.
async function waitFor(check, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

// Addresses that are public, for the fakes to "resolve" to. Nothing ever connects to them.
const PUBLIC_A = '93.184.216.34';
const PUBLIC_B = '151.101.1.69';
const PUBLIC_V6 = '2606:4700:4700::1111';

// Small stand-ins with the right leading bytes; nothing decodes them.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]), Buffer.alloc(32, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.alloc(32, 3)]);
const GIF = Buffer.concat([Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1'), Buffer.alloc(16, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([40, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(32, 9)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>');

const page = (head, body = '<p>hello</p>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const og = ({ title, description, site, image } = {}) => [
  title ? `<meta property="og:title" content="${title}">` : '',
  description ? `<meta property="og:description" content="${description}">` : '',
  site ? `<meta property="og:site_name" content="${site}">` : '',
  image ? `<meta property="og:image" content="${image}">` : '',
].join('');
const htmlPage = (head, extra = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: page(head), ...extra });

/** Was this fetch turned down for this reason? */
async function refused(promise, reason) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.name, 'Refusal', `expected a refusal, got ${err && err.stack}`);
    assert.equal(err.reason, reason);
    return true;
  });
}

// "DNS" and "HTTP" as two tables. `hosts[name]` is a list of addresses (or a function returning
// one); `pages[url]` is { status, headers, body, delayMs, gate, hang } (or a function returning
// that). Everything asked of either is kept in `log`, in order.
function fakeNet({ hosts = {}, pages = {} } = {}) {
  const log = [];
  const state = { hosts, pages, active: 0, maxActive: 0 };
  const resolve = async (hostname) => {
    const entry = { kind: 'resolve', hostname };
    log.push(entry);
    let answer = state.hosts[hostname];
    if (typeof answer === 'function') answer = await answer(log.filter((e) => e.kind === 'resolve' && e.hostname === hostname).length);
    if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    return answer.map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : a));
  };
  const request = async (req) => {
    const url = `${req.protocol}//${req.hostname}${req.path}`;
    const entry = { kind: 'request', url, hostname: req.hostname, address: req.address, family: req.family, port: req.port, headers: req.headers, bytesRead: 0 };
    log.push(entry);
    let found = state.pages[url];
    if (typeof found === 'function') found = await found(req, entry);
    if (!found) found = { status: 404, headers: { 'content-type': 'text/html' }, body: '' };
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    let finished = false;
    const finish = () => { if (!finished) { finished = true; state.active -= 1; } };
    try {
      if (found.delayMs) await sleep(found.delayMs);
      if (found.gate) await found.gate;
      if (found.hang) await new Promise(() => {});
    } catch (err) { finish(); throw err; }
    const bytes = Buffer.isBuffer(found.body) ? found.body : Buffer.from(found.body || '');
    const chunk = found.chunkSize || 16 * 1024;
    return {
      status: found.status || 200,
      headers: found.headers || {},
      body: (async function* chunks() {
        try {
          for (let i = 0; i < bytes.length; i += chunk) {
            if (found.bodyDelayMs) await sleep(found.bodyDelayMs);
            entry.bytesRead += Math.min(chunk, bytes.length - i);
            yield bytes.subarray(i, i + chunk);
          }
          if (found.hangAfterBody) await new Promise(() => {});
        } finally { finish(); }
      }()),
      destroy: finish,
    };
  };
  const requests = () => log.filter((e) => e.kind === 'request');
  const lookups = () => log.filter((e) => e.kind === 'resolve');
  return { resolve, request, log, state, requests, lookups };
}

const tmpDirs = [];
const dbs = [];
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lanparty-links-')); tmpDirs.push(d); return d; };
const freshDb = async () => {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await migrate(db);
  dbs.push(db);
  return db;
};
const quietLog = () => { const lines = []; const add = (...a) => lines.push(a.map(String).join(' ')); return { log: add, warn: add, lines }; };

/** A link preview service on a fake network, an in-memory database and a throwaway folder. */
async function service(fake, opts = {}) {
  const db = opts.db || await freshDb();
  const dataDir = opts.dataDir || tmpDir();
  const log = quietLog();
  const previews = createLinkPreviews({
    db, dataDir, env: opts.env || {}, resolve: fake.resolve, request: fake.request,
    timeoutMs: opts.timeoutMs || 2000, ...(opts.now ? { now: opts.now } : {}),
    ...(opts.maxStoreBytes ? { maxStoreBytes: opts.maxStoreBytes } : {}), log,
  });
  return { previews, db, dataDir, log };
}

after(async () => {
  for (const db of dbs) { try { await db.close(); } catch (_) { /* already closed */ } }
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* best effort */ } }
});

// Every address that is not a public unicast one, with the reason it is refused for.
const NOT_PUBLIC = [
  // IPv4
  ['0.0.0.0', 'unspecified'], ['0.1.2.3', 'unspecified'],
  ['10.0.0.1', 'private'], ['10.255.255.255', 'private'],
  ['172.16.0.1', 'private'], ['172.31.255.255', 'private'],
  ['192.168.0.1', 'private'], ['192.168.1.10', 'private'], ['192.168.255.255', 'private'],
  ['127.0.0.1', 'loopback'], ['127.0.0.53', 'loopback'], ['127.255.255.254', 'loopback'],
  ['169.254.0.1', 'link-local'], ['169.254.169.254', 'link-local'], // the second is the cloud metadata address
  ['100.64.0.1', 'cgnat'], ['100.100.100.100', 'cgnat'], ['100.101.102.103', 'cgnat'], ['100.127.255.254', 'cgnat'], // Tailscale lives here
  ['224.0.0.1', 'multicast'], ['239.255.255.250', 'multicast'],
  ['255.255.255.255', 'broadcast'],
  ['240.0.0.1', 'reserved'], ['254.254.254.254', 'reserved'],
  ['192.0.0.1', 'reserved'], ['192.0.2.1', 'reserved'], ['192.88.99.1', 'reserved'],
  ['198.18.0.1', 'reserved'], ['198.19.255.255', 'reserved'], ['198.51.100.7', 'reserved'], ['203.0.113.9', 'reserved'],
  // IPv6
  ['::', 'unspecified'], ['0:0:0:0:0:0:0:0', 'unspecified'],
  ['::1', 'loopback'], ['0:0:0:0:0:0:0:1', 'loopback'],
  ['::ffff:127.0.0.1', 'mapped'], ['::ffff:7f00:1', 'mapped'], ['::ffff:10.0.0.1', 'mapped'], ['::ffff:192.168.1.1', 'mapped'],
  ['::ffff:169.254.169.254', 'mapped'], ['::ffff:100.64.0.1', 'mapped'], ['0:0:0:0:0:ffff:c0a8:101', 'mapped'],
  ['::ffff:8.8.8.8', 'mapped'], // even a public address in this form: nothing legitimate answers with one
  ['::127.0.0.1', 'compatible'], ['::10.0.0.1', 'compatible'], ['::c0a8:101', 'compatible'],
  ['64:ff9b::7f00:1', 'nat64'], ['64:ff9b::10.0.0.1', 'nat64'], ['64:ff9b:1::1', 'nat64'],
  ['fc00::1', 'unique-local'], ['fd12:3456:789a::1', 'unique-local'], ['fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', 'unique-local'],
  ['fe80::1', 'link-local'], ['febf::1', 'link-local'],
  ['fec0::1', 'site-local'],
  ['ff02::1', 'multicast'], ['ff0e::1', 'multicast'],
  ['2001::1', 'reserved'], ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'], // Teredo
  ['2001:db8::1', 'reserved'], ['3fff::1', 'reserved'],                           // documentation
  ['2002:7f00:1::1', 'reserved'], ['2002:c0a8:101::1', 'reserved'],               // 6to4, wrapping 127.0.0.1 and 192.168.1.1
  ['100::1', 'reserved'], ['4000::1', 'reserved'], ['e000::1', 'reserved'], ['1::1', 'reserved'],
];
const PUBLIC = [
  '8.8.8.8', '1.1.1.1', PUBLIC_A, PUBLIC_B,
  // Just outside each refused range.
  '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0', '126.255.255.255', '128.0.0.1', '169.253.255.255',
  '169.255.0.0', '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255',
  PUBLIC_V6, '2a00:1450:4001:81b::200e', '2001:4860:4860::8888', '2001:200::1', '2003::1', '3ffe::1',
];

// ---------------------------------------------------------------------------------------------
describe('link previews: which addresses may be fetched from', () => {
  test('every range that is not public unicast is refused, by name', () => {
    for (const [address, reason] of NOT_PUBLIC) {
      assert.deepEqual(classifyAddress(address), { ok: false, reason }, address);
      assert.deepEqual(classifyAddress(address.toUpperCase()), { ok: false, reason }, `${address} in capitals`);
    }
  });

  test('public addresses pass, right up to the edge of each refused range', () => {
    for (const address of PUBLIC) assert.deepEqual(classifyAddress(address), { ok: true, family: net.isIP(address) }, address);
  });

  test('anything that is not plainly an address is refused rather than guessed at', () => {
    for (const value of ['', ' ', 'example.com', 'localhost', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.-4', '0x7f.0.0.1', '0177.0.0.1',
      '017700000001', '2130706433', '127.1', '1.2.3.4 ', ' 1.2.3.4', '1.2.3.4/8', '[::1]', '::1%lo', 'fe80::1%eth0', ':::', '1::2::3', 'gggg::1',
      null, undefined, 42, 127, {}, [], ['8.8.8.8'], true]) {
      assert.deepEqual(classifyAddress(value), { ok: false, reason: 'not-an-address' }, String(value));
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: which URLs may be fetched', () => {
  const reasonOf = (url, own) => { const r = checkUrl(url, own); return r.ok ? 'ok' : r.reason; };

  test('an IP address is never fetched, in any spelling', () => {
    const literals = [
      'http://127.0.0.1/', 'http://127.0.0.1./', 'http://2130706433/', 'http://0x7f000001/', 'http://0x7f.0.0.1/', 'http://0x7F.0x0.0x0.0x1/',
      'http://0177.0.0.1/', 'http://017700000001/', 'http://127.1/', 'http://127.0.1/', 'http://0/', 'http://0.0.0.0/',
      'http://%31%32%37%2e%30%2e%30%2e%31/', 'http://１２７.０.０.１/', 'http://127。0。0。1/',
      'http://192.168.1.1/', 'http://3232235777/', 'http://0xc0a80101/', 'http://10.0.0.1/', 'http://167772161/', 'http://172.16.0.1/',
      'http://169.254.169.254/latest/meta-data/', 'http://2852039166/', 'http://100.100.100.100/', 'http://1684300900/',
      'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::127.0.0.1]/',
      'http://[fe80::1]/', 'http://[fd00::1]/', 'http://[fc00::1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::1]/', 'https://[::]/',
      // Public ones too: a preview of a bare address is not worth the ways it can go wrong.
      'http://8.8.8.8/', 'https://1.1.1.1/', 'http://134744072/', `https://[${PUBLIC_V6}]/`,
    ];
    for (const url of literals) assert.equal(reasonOf(url), 'ip-literal', url);
    // And every one of them, as the URL parser spells it, would be refused by range as well: two
    // locks, either of which holds on its own.
    for (const url of literals.slice(0, 36)) {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
      assert.equal(classifyAddress(host).ok, false, `${url} -> ${host}`);
    }
  });

  test('only http and https, on their own default port, with no credentials', () => {
    for (const url of ['ftp://example.com/file', 'file:///etc/passwd', 'gopher://example.com/', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>',
      'vaultmovies://party/123', 'ws://example.com/', 'smb://nas/share', 'ldap://example.com/', 'dict://example.com:11211/stat', 'blob:https://example.com/x']) {
      assert.equal(reasonOf(url), 'scheme', url);
    }
    for (const url of ['http://example.com:8080/', 'https://example.com:8443/', 'http://example.com:22/', 'http://example.com:3000/', 'http://example.com:5000/',
      'http://example.com:6379/', 'http://example.com:443/', 'https://example.com:80/', 'http://example.com:0/', 'http://example.com:65535/']) {
      assert.equal(reasonOf(url), 'port', url);
    }
    for (const url of ['http://example.com/', 'http://example.com:80/', 'https://example.com/', 'https://example.com:443/x?y=1']) assert.equal(reasonOf(url), 'ok', url);
    for (const url of ['http://user:pw@example.com/', 'http://user@example.com/', 'https://:pw@example.com/', 'https://example.com:pw@evil.example.net/', 'http://127.0.0.1@example.com/']) {
      assert.equal(reasonOf(url), 'credentials', url);
    }
  });

  test('lengths are capped, and nothing malformed gets through', () => {
    assert.equal(reasonOf(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`), 'url-too-long');
    assert.equal(reasonOf(`https://example.com/${'a'.repeat(MAX_URL_LENGTH - 30)}`), 'ok');
    assert.equal(reasonOf(`https://${Array(6).fill('a'.repeat(60)).join('.')}.com/`), 'host-too-long');
    assert.equal(reasonOf(`https://${'a'.repeat(64)}.example.com/`), 'bad-host', 'a label longer than DNS allows');
    for (const url of ['', ' ', 'not a url', 'example.com/page', '//example.com/x', 'http://', 'https://exa mple.com/', 'http://1.2.3.999/', null, undefined, 42, {}, ['https://example.com/']]) {
      assert.equal(reasonOf(url), 'bad-url', String(url));
    }
    for (const url of ['http://exa_mple.com/', 'http://-bad.example.com/', 'http://bad-.example.com/', 'http://a..b.com/', 'http://.example.com/']) {
      assert.equal(reasonOf(url), 'bad-host', url);
    }
  });

  test('names that are never on the public web are refused before any lookup', () => {
    for (const url of ['http://nas.local/', 'https://printer.lan/', 'http://db.internal/', 'http://router.home/', 'http://x.home.arpa/', 'http://1.168.192.in-addr.arpa/',
      'http://thing.test/', 'http://a.invalid/', 'http://box.corp/', 'http://wiki.intranet/', 'http://host.localdomain/', 'http://foo.localhost/',
      'http://a.b.localhost./', 'http://NAS.LOCAL/', 'http://facebookcorewwwi.onion/', 'http://svc.private/']) {
      assert.equal(reasonOf(url), 'internal-name', url);
    }
    for (const url of ['http://localhost/', 'http://LOCALHOST/', 'http://localhost./', 'http://intranet/', 'http://nas/', 'http://router./', 'https://fileserver/', 'http://kubernetes/']) {
      assert.equal(reasonOf(url), 'single-label', url);
    }
  });

  test('the server never fetches itself', () => {
    const own = ownHostnames(
      { host: 'lanparty.example.org', 'x-forwarded-host': 'public.example.net, proxy.example.net:8443', origin: 'https://app.example.org' },
      ['https://party.example.org', 'https://other.example.com:8443', 'bare.example.io:9000', '*', ''],
    );
    assert.deepEqual([...own].sort(), ['app.example.org', 'bare.example.io', 'lanparty.example.org', 'other.example.com', 'party.example.org', 'proxy.example.net', 'public.example.net']);
    for (const url of ['https://lanparty.example.org/app/', 'http://LanParty.Example.ORG/', 'https://lanparty.example.org./uploads/x', 'https://party.example.org/app/?invite=abc',
      'https://public.example.net/', 'https://proxy.example.net/', 'https://app.example.org/x', 'http://other.example.com/', 'https://bare.example.io/']) {
      assert.equal(reasonOf(url, own), 'own-host', url);
    }
    assert.equal(reasonOf('https://news.example.com/', own), 'ok');
    assert.equal(reasonOf('https://sub.lanparty.example.org/', own), 'ok', 'only the names themselves; what a subdomain points at is the address check\'s to judge');
    assert.deepEqual([...ownHostnames(undefined)], []);
    assert.deepEqual(checkHostname('Example.COM.'), { ok: true, host: 'example.com' });
  });

  test('what is fetched is the URL in one normal form', () => {
    const href = (url) => { const r = checkUrl(url); assert.ok(r.ok, url); return r.href; };
    assert.equal(href('HTTP://Example.COM:80/Path?q=1#frag'), 'http://example.com/Path?q=1');
    assert.equal(href('https://example.com./x'), 'https://example.com/x');
    assert.equal(href('https://example.com'), 'https://example.com/');
    assert.equal(href('https://bücher.example/straße'), 'https://xn--bcher-kva.example/stra%C3%9Fe');
    assert.equal(href('https://example.com/a/../b/./c'), 'https://example.com/b/c');
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: which link of a message is previewed', () => {
  const link = (text, attachment, own) => previewLinkOf(text, attachment, own);

  test('the first link that is not already shown as media', () => {
    assert.equal(link('see https://news.example.com/story for details'), 'https://news.example.com/story');
    assert.equal(link('https://news.example.com/story'), 'https://news.example.com/story');
    assert.equal(link('read https://news.example.com/story.'), 'https://news.example.com/story', 'the full stop is the sentence\'s');
    assert.equal(link('(https://news.example.com/a), right?'), 'https://news.example.com/a');
    assert.equal(link('https://news.example.com/story#comments'), 'https://news.example.com/story', 'a fragment is never sent');
    assert.equal(link('one https://a.example.com/x two https://b.example.com/y'), 'https://a.example.com/x', 'at most one, the first');
    assert.equal(link('first line\nthen https://news.example.com/later\nand more'), 'https://news.example.com/later');

    // A line that ends in a media url shows that media; it is not a link to preview.
    assert.equal(link('https://media.tenor.com/AbC/cat.gif'), null);
    assert.equal(link('look at this https://cdn.example.com/clips/win.mp4?x=1'), null);
    assert.equal(link('/gifs/1700000000000-ab12cd-party.webp'), null);
    assert.equal(link('https://news.example.com/story https://cdn.example.com/cat.gif'), 'https://news.example.com/story', 'the words before the media can still hold a link');
    // A media file in the middle of a sentence is a link, but still not a page.
    assert.equal(link('https://cdn.example.com/a.png wow'), null);
    assert.equal(link('https://cdn.example.com/a.png and https://news.example.com/x'), 'https://news.example.com/x');
  });

  test('a link that breaks the rules is passed over, never fetched', () => {
    assert.equal(link('http://192.168.1.1/admin'), null);
    assert.equal(link('http://nas.local/ and http://localhost:3000/ and http://user:pw@example.com/'), null);
    assert.equal(link('http://192.168.1.1/admin then https://news.example.com/x'), 'https://news.example.com/x');
    assert.equal(link('https://party.example.org/app/?invite=abc', null, new Set(['party.example.org'])), null, 'our own invite link');
    assert.equal(link('HTTPS://news.example.com/x'), null, 'the client does not render this as a link either');
    assert.equal(link('ftp://example.com/x file:///etc/passwd javascript:alert(1)'), null);
    // Only so many are looked at: a wall of links is not a list of things to try.
    const wall = `${Array.from({ length: 10 }, (_, i) => `http://10.0.0.${i}/`).join(' ')} https://news.example.com/x`;
    assert.equal(link(wall), null);
    assert.equal(link(`${Array.from({ length: 9 }, (_, i) => `http://10.0.0.${i}/`).join(' ')} https://news.example.com/x`), 'https://news.example.com/x');
  });

  test('a huge or hostile message is read once through, not over and over', () => {
    // A message can be a megabyte. Each of these would take seconds (or minutes) if the link were
    // found, or its trailing punctuation trimmed, by a pattern that retries from every position.
    const messages = {
      'a link that is a megabyte of dots': [`http://${'.'.repeat(1_000_000)}a`, null],
      'a link that is a megabyte long': [`https://news.example.com/${'a'.repeat(1_000_000)}`, null],
      'a megabyte of trailing punctuation': [`https://news.example.com/x${'!'.repeat(1_000_000)}`, null],
      'half a million empty lines, then a link': [`${'\n'.repeat(500_000)}https://news.example.com/x`, 'https://news.example.com/x'],
      'half a million words, then a link': [`${'word '.repeat(200_000)}https://news.example.com/x`, 'https://news.example.com/x'],
      'thousands of refused links': [`${'http://10.0.0.1/ '.repeat(50_000)}https://news.example.com/x`, null],
      'a last token that is a megabyte of slashes': [`see ${'/'.repeat(1_000_000)}`, null],
      'a media-looking tail with a million dots': [`https://cdn.example.com/${'a.'.repeat(500_000)}png`, null],
    };
    for (const [label, [text, expected]] of Object.entries(messages)) {
      const started = process.hrtime.bigint();
      assert.equal(link(text), expected, label);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 1500, `${label}: took ${Math.round(ms)}ms`);
    }
  });

  test('a message with an attachment, or with no text, has none', () => {
    assert.equal(link('https://news.example.com/story', '{"url":"/uploads/x.png"}'), null);
    assert.equal(link('https://news.example.com/story', { url: '/uploads/x.png' }), null);
    for (const text of ['', '   ', 'no links here', null, undefined, 42, {}]) assert.equal(link(text), null);
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: reading a hostile page', () => {
  test('Open Graph, then Twitter card, then <title> and the meta description', () => {
    const full = extractMetadata(page(`
      <title>Plain title</title>
      <meta name="description" content="Plain description">
      <meta name="twitter:title" content="Twitter title"><meta name="twitter:description" content="Twitter description">
      <meta name="twitter:image" content="https://cdn.example.net/tw.png">
      <meta property="og:title" content="OG title"><meta property="og:description" content="OG description">
      <meta property="og:site_name" content="Example News"><meta property="og:image" content="https://cdn.example.net/og.png">
      <meta property="og:image:secure_url" content="https://cdn.example.net/secure.png">`));
    assert.deepEqual(full, { title: 'OG title', description: 'OG description', siteName: 'Example News', image: 'https://cdn.example.net/secure.png' });

    assert.deepEqual(
      extractMetadata(page('<title>Plain title</title><meta name="description" content="Plain description"><meta name="twitter:title" content="Twitter title"><meta name="twitter:image:src" content="/tw.png">')),
      { title: 'Twitter title', description: 'Plain description', siteName: '', image: '/tw.png' },
    );
    assert.deepEqual(extractMetadata(page('<title>  Just\n a   title </title>')), { title: 'Just a title', description: '', siteName: '', image: '' });
    assert.deepEqual(extractMetadata('plain text, no markup at all'), { title: '', description: '', siteName: '', image: '' });
    assert.deepEqual(extractMetadata(''), { title: '', description: '', siteName: '', image: '' });
  });

  test('tags are read however they are written', () => {
    const variants = [
      '<meta content="T" property="og:title">',
      "<meta property='og:title' content='T'>",
      '<meta property=og:title content=T>',
      '<META PROPERTY="OG:TITLE" CONTENT="T">',
      '<meta name="og:title" content="T" />',
      '<meta\n  property = "og:title"\n  content = "T"\n/>',
      '<meta property="og:title" data-x="a > b" content="T">',
      '<meta/property="og:title"/content="T">',
    ];
    for (const tag of variants) assert.equal(extractMetadata(page(tag)).title, 'T', tag);
    // The first of a kind wins, here and for a repeated attribute.
    assert.equal(extractMetadata(page('<meta property="og:title" content="first"><meta property="og:title" content="second">')).title, 'first');
    assert.equal(extractMetadata(page('<meta property="og:title" content="first" content="second">')).title, 'first');
    assert.equal(extractMetadata(page('<meta property="og:title" content="a &gt; b &amp; c">')).title, 'a > b & c');
  });

  test('the result is plain text: nothing is decoded twice, and markup in it is just characters', () => {
    const hostile = extractMetadata(page(`
      <meta property="og:title" content="<img src=x onerror=alert(1)>">
      <meta property="og:description" content="&lt;script&gt;alert(document.cookie)&lt;/script&gt; &amp;lt;b&amp;gt;">
      <meta property="og:site_name" content="javascript:alert(1)">`));
    // Characters, to be put on screen as characters. (The client renders them as text.)
    assert.equal(hostile.title, '<img src=x onerror=alert(1)>');
    assert.equal(hostile.description, '<script>alert(document.cookie)</script> &lt;b&gt;', 'decoded once, not twice');
    assert.equal(hostile.siteName, 'javascript:alert(1)');
    // A <title> that is itself markup yields nothing rather than a tag.
    assert.equal(extractMetadata('<title><script>alert(1)</script></title>').title, '');
    assert.equal(extractMetadata('<title>Fine</title><title>Second</title>').title, 'Fine');
  });

  test('control characters and direction overrides are stripped, and whitespace is collapsed', () => {
    const tricky = extractMetadata(page('<meta property="og:title" content="Hello\u0000\u0007\u001b[31m ‮evil‬​⁦x⁩\r\n\tWorld\u0085!﻿">'));
    assert.equal(tricky.title, 'Hello [31m evilx World !');
    assert.doesNotMatch(tricky.title, /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/);
    assert.equal(cleanText('a&#0;b&#x0;c&#xD800;d&#x110000;e&#9999999;f', 100), 'a�b�c�d�e�f', 'a character reference that names no character');
    assert.equal(cleanText('&#x202E;gnp.exe&#8238;', 100), 'gnp.exe', 'an override smuggled in as a reference is still stripped');
    assert.equal(cleanText('&nbsp;&nbsp;a&nbsp;&nbsp;b&nbsp;', 100), 'a b');
    assert.equal(cleanText('&notanentity; &amp &#; &#x;', 100), '&notanentity; &amp &#; &#x;');
    for (const value of [null, undefined, 42, {}, []]) assert.equal(cleanText(value, 100), '');
  });

  test('every field is cut to its limit, by code point', () => {
    const long = 'word '.repeat(600);
    const found = extractMetadata(page(`<meta property="og:title" content="${long}"><meta property="og:description" content="${long}"><meta property="og:site_name" content="${long}">`));
    assert.equal(Array.from(found.title).length <= TITLE_MAX, true);
    assert.equal(Array.from(found.description).length <= DESCRIPTION_MAX, true);
    assert.equal(Array.from(found.siteName).length <= SITE_NAME_MAX, true);
    for (const field of [found.title, found.description, found.siteName]) assert.ok(field.endsWith('…'));
    const emoji = cleanText('😀'.repeat(500), 50);
    assert.equal(Array.from(emoji).length, 50);
    assert.ok(emoji.endsWith('…') && !/�/.test(emoji) && emoji.slice(0, -1) === '😀'.repeat(49), 'an emoji is never cut in half');
    assert.equal(extractMetadata(`<title>${'t'.repeat(5000)}</title>`).title.length, TITLE_MAX);
    // A tag too long to be a real one is skipped whole rather than read to its end.
    assert.equal(extractMetadata(page(`<meta property="og:title" content="${'word '.repeat(4000)}"><title>Fallback</title>`)).title, 'Fallback');
    // An image address longer than any URL may be is not carried along whole.
    assert.ok(extractMetadata(page(`<meta property="og:image" content="https://cdn.example.net/${'a'.repeat(100000)}">`)).image.length <= MAX_URL_LENGTH * 2);
  });

  test('pages built to make a parser hang or crash do neither', () => {
    const half = Math.floor(MAX_HTML_BYTES / 2);
    const nasty = {
      'unclosed <meta, over and over': '<meta '.repeat(MAX_HTML_BYTES / 6),
      'unclosed <title, over and over': '<title'.repeat(MAX_HTML_BYTES / 6),
      'one tag that never ends': `<meta property="og:title" content="${'a'.repeat(MAX_HTML_BYTES)}`,
      'a quote that never closes': `<meta property='og:title' content='${'x'.repeat(half)}<meta property="og:title" content="T">`,
      'thousands of attributes': `<meta ${'a=1 '.repeat(100000)}property="og:title" content="T">`,
      'a wall of spaces in a tag': `<meta${' '.repeat(half)}property="og:title" content="T">`,
      'a wall of equals signs': `<meta ${'='.repeat(half)}>`,
      'a wall of slashes': `<meta ${'/'.repeat(half)}>`,
      'names with no values': `<meta ${'a '.repeat(half / 2)}>`,
      'half a megabyte of angle brackets': '<'.repeat(MAX_HTML_BYTES),
      'half a megabyte of ampersands': `<title>${'&'.repeat(MAX_HTML_BYTES)}</title>`,
      'half a megabyte of entity starts': `<meta property="og:title" content="${'&#x'.repeat(half / 3)}">`,
      'null bytes': `<meta property="og:title" content="a\u0000b">${'\u0000'.repeat(half)}`,
      'prototype names as attributes': '<meta __proto__="x" constructor="y" toString="z" hasOwnProperty="w" property="og:title" content="T">',
      'prototype names as keys': '<meta property="__proto__" content="x"><meta name="constructor" content="y"><meta property="og:title" content="T">',
      'a lone surrogate': `<meta property="og:title" content="a${String.fromCharCode(0xd800)}b">`,
    };
    for (const [label, html] of Object.entries(nasty)) {
      const started = process.hrtime.bigint();
      let result;
      assert.doesNotThrow(() => { result = extractMetadata(html); }, label);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 1500, `${label}: took ${Math.round(ms)}ms`);
      for (const value of Object.values(result)) assert.equal(typeof value, 'string', label);
      assert.ok(Array.from(result.title).length <= TITLE_MAX, label);
    }
    assert.equal(extractMetadata(nasty['prototype names as attributes']).title, 'T');
    assert.equal(extractMetadata(nasty['prototype names as keys']).title, 'T');
    assert.equal(({}).x, undefined, 'and nothing was written onto Object.prototype');
  });

  test('a stored preview is checked again on the way out', () => {
    const good = { url: 'https://news.example.com/story', title: 'T', description: 'D', siteName: 'S', image: `/link-previews/${'a'.repeat(32)}.png` };
    assert.deepEqual(parsePreview(JSON.stringify(good)), good);
    assert.deepEqual(parsePreview(good), good);
    // Whatever a row holds, the image is one of this server's files or it is not sent at all.
    for (const image of ['https://tracker.example.net/pixel.gif', '//tracker.example.net/p.png', '/uploads/x.png', '/link-previews/../data.sqlite',
      `/link-previews/${'a'.repeat(32)}.svg`, `/link-previews/${'a'.repeat(32)}.html`, `/link-previews/${'A'.repeat(32)}.png`, 'javascript:alert(1)', 42, null]) {
      assert.deepEqual(parsePreview({ ...good, image }), { url: good.url, title: 'T', description: 'D', siteName: 'S' }, String(image));
    }
    for (const url of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'ftp://example.com/', '', null, 42, `https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`]) {
      assert.equal(parsePreview({ ...good, url }), null, String(url));
    }
    assert.equal(parsePreview({ url: good.url }), null, 'nothing to show');
    assert.equal(parsePreview({ url: good.url, title: 42, description: {} }), null);
    for (const value of [null, undefined, '', 'not json', '[]', '42', 'null', '{"url":5}']) assert.equal(parsePreview(value), null, String(value));
    assert.equal(Array.from(parsePreview({ url: good.url, title: 'x'.repeat(5000) }).title).length, TITLE_MAX);
  });

  test('an image is known by its bytes', () => {
    assert.equal(sniffImage(PNG), 'png');
    assert.equal(sniffImage(JPEG), 'jpeg');
    assert.equal(sniffImage(GIF), 'gif');
    assert.equal(sniffImage(WEBP), 'webp');
    for (const bytes of [SVG, Buffer.from('<!doctype html><script>alert(1)</script>'), Buffer.from('<?xml version="1.0"?><svg/>          '), Buffer.alloc(64),
      Buffer.from('GIF89a'), PNG.subarray(0, 8), Buffer.alloc(0), Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'), Buffer.from('BM' + 'x'.repeat(40))]) {
      assert.equal(sniffImage(bytes), null);
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: the fetcher, on a fake network', () => {
  const STORY = 'https://news.example.com/story';
  const storyNet = (extra = {}) => fakeNet({
    hosts: { 'news.example.com': [PUBLIC_A], 'cdn.example.net': [PUBLIC_B], ...(extra.hosts || {}) },
    pages: {
      [STORY]: htmlPage(og({ title: 'Big news', description: 'It happened.', site: 'Example News', image: 'https://cdn.example.net/img/story.png' })),
      'https://cdn.example.net/img/story.png': { headers: { 'content-type': 'image/png' }, body: PNG },
      ...(extra.pages || {}),
    },
  });

  test('a public page becomes a preview, fetched from the address that was checked and saying nothing about who asked', async () => {
    const fake = storyNet();
    const { previews, dataDir } = await service(fake);
    const preview = await previews.fetchPreview(STORY, new Set());
    assert.equal(preview.url, STORY);
    assert.equal(preview.title, 'Big news');
    assert.equal(preview.description, 'It happened.');
    assert.equal(preview.siteName, 'Example News');
    assert.match(preview.image, /^\/link-previews\/[a-f0-9]{32}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(dataDir, 'link-previews', path.basename(preview.image))), PNG, 'the image is on this server now');
    assert.ok(!JSON.stringify(preview).includes('cdn.example.net'), 'nothing in the preview points a reader\'s browser at the site');

    const [pageReq, imageReq] = fake.requests();
    assert.equal(fake.requests().length, 2);
    assert.deepEqual([pageReq.url, pageReq.hostname, pageReq.address, pageReq.family, pageReq.port], [STORY, 'news.example.com', PUBLIC_A, 4, 443]);
    assert.deepEqual([imageReq.url, imageReq.address, imageReq.port], ['https://cdn.example.net/img/story.png', PUBLIC_B, 443]);
    assert.deepEqual(fake.lookups().map((l) => l.hostname), ['news.example.com', 'cdn.example.net'], 'each name resolved once, by us');
    for (const req of [pageReq, imageReq]) {
      const names = Object.keys(req.headers).map((h) => h.toLowerCase()).sort();
      assert.deepEqual(names, ['accept', 'accept-encoding', 'accept-language', 'connection', 'user-agent'], 'exactly these headers: no cookie, no referer, no authorization, no origin');
      assert.equal(req.headers['User-Agent'], USER_AGENT);
      assert.match(USER_AGENT, /^Mozilla\/5\.0 \(compatible; LinkPreview\/[\d.]+\)$/);
      assert.equal(req.headers['Accept-Encoding'], 'identity');
    }
    assert.equal(pageReq.headers.Accept, 'text/html,application/xhtml+xml');

    // Plain http goes to port 80.
    const plain = fakeNet({ hosts: { 'old.example.com': [PUBLIC_A] }, pages: { 'http://old.example.com/': htmlPage('<title>Old site</title>') } });
    const viaHttp = await (await service(plain)).previews.fetchPreview('http://old.example.com/', new Set());
    assert.deepEqual(viaHttp, { url: 'http://old.example.com/', title: 'Old site' });
    assert.equal(plain.requests()[0].port, 80);
    // An IPv6-only site is reached over IPv6; with both, IPv4 is tried first.
    const v6 = fakeNet({ hosts: { 'six.example.com': [PUBLIC_V6], 'dual.example.com': [PUBLIC_V6, PUBLIC_A] }, pages: { 'https://six.example.com/': htmlPage('<title>Six</title>'), 'https://dual.example.com/': htmlPage('<title>Dual</title>') } });
    const six = await service(v6);
    await six.previews.fetchPreview('https://six.example.com/', new Set());
    await six.previews.fetchPreview('https://dual.example.com/', new Set());
    assert.deepEqual(v6.requests().map((r) => [r.address, r.family]), [[PUBLIC_V6, 6], [PUBLIC_A, 4]]);
  });

  test('a name that resolves to anything but a public address is never connected to', async () => {
    for (const [address, reason] of NOT_PUBLIC) {
      const fake = fakeNet({ hosts: { 'sneaky.example.com': [address] }, pages: { 'https://sneaky.example.com/': htmlPage('<title>Inside</title>') } });
      const { previews } = await service(fake);
      await refused(previews.fetchPreview('https://sneaky.example.com/', new Set()), reason);
      assert.equal(fake.requests().length, 0, `${address}: no connection was attempted`);
    }
  });

  test('one private address among public ones is enough to refuse the name', async () => {
    const mixes = [
      [[PUBLIC_A, '192.168.1.10'], 'private'], [['192.168.1.10', PUBLIC_A], 'private'], [[PUBLIC_A, PUBLIC_B, '127.0.0.1'], 'loopback'],
      [[PUBLIC_A, '::1'], 'loopback'], [[PUBLIC_V6, 'fd00::1'], 'unique-local'], [[PUBLIC_A, '100.100.100.100'], 'cgnat'],
      [[PUBLIC_A, '::ffff:10.0.0.1'], 'mapped'], [[PUBLIC_A, '169.254.169.254', PUBLIC_B], 'link-local'], [[PUBLIC_A, '0.0.0.0'], 'unspecified'],
    ];
    for (const [addresses, reason] of mixes) {
      const fake = fakeNet({ hosts: { 'mixed.example.com': addresses }, pages: { 'https://mixed.example.com/': htmlPage('<title>Mixed</title>') } });
      const { previews } = await service(fake);
      await refused(previews.fetchPreview('https://mixed.example.com/', new Set()), reason);
      assert.equal(fake.requests().length, 0, addresses.join(', '));
    }
  });

  test('a lookup that fails, answers nothing, or answers nonsense refuses the fetch', async () => {
    const cases = {
      'nowhere.example.com': undefined,
      'empty.example.com': [],
      'crowd.example.com': Array.from({ length: 17 }, (_, i) => `93.184.216.${i + 1}`),
      'junk.example.com': [{ address: 'not-an-address', family: 4 }],
      'name.example.com': [{ address: 'localhost', family: 4 }],
      'null.example.com': [null],
      'lying.example.com': [{ address: '10.0.0.1', family: 6 }, { address: PUBLIC_A, family: 4 }],
      'zone.example.com': [{ address: 'fe80::1%eth0', family: 6 }],
    };
    for (const [host, answer] of Object.entries(cases)) {
      const fake = fakeNet({ hosts: { [host]: answer }, pages: { [`https://${host}/`]: htmlPage('<title>x</title>') } });
      const { previews } = await service(fake);
      await assert.rejects(previews.fetchPreview(`https://${host}/`, new Set()), (err) => err.name === 'Refusal', host);
      assert.equal(fake.requests().length, 0, host);
    }
  });

  test('DNS rebinding: the address that was checked is the one connected to, and a name is never resolved twice for one hop', async () => {
    // Public the first time it is asked, loopback every time after: what a rebinding name does.
    const fake = fakeNet({
      hosts: { 'rebind.example.com': (nth) => (nth === 1 ? [PUBLIC_A] : ['127.0.0.1']) },
      pages: {
        'https://rebind.example.com/': htmlPage(og({ title: 'Looks innocent', image: 'https://rebind.example.com/admin.png' })),
        'https://rebind.example.com/admin.png': { headers: { 'content-type': 'image/png' }, body: PNG },
      },
    });
    const { previews } = await service(fake);
    const preview = await previews.fetchPreview('https://rebind.example.com/', new Set());
    // The page was fetched: from the address that was validated, after exactly one lookup.
    assert.equal(fake.log[0].kind, 'resolve');
    assert.equal(fake.log[1].kind, 'request');
    assert.equal(fake.log[1].address, PUBLIC_A, 'pinned to what was checked');
    // The image is a new fetch, so the name is looked up again; it now says loopback, and that is
    // refused like any other private answer. The preview simply has no image.
    assert.equal(fake.lookups().length, 2);
    assert.equal(fake.requests().length, 1, 'nothing was ever sent to the rebound address');
    assert.ok(fake.requests().every((r) => r.address === PUBLIC_A));
    assert.deepEqual(preview, { url: 'https://rebind.example.com/', title: 'Looks innocent' });
    // The requester is only ever handed an address, never a bare name to resolve for itself.
    for (const req of fake.requests()) assert.ok(net.isIP(req.address) > 0);
  });

  test(`redirects: at most ${MAX_REDIRECTS} are followed, and every hop is checked and resolved again`, async () => {
    const hop = (to) => ({ status: 302, headers: { location: to, 'content-type': 'text/html' }, body: '' });
    const fake = fakeNet({
      hosts: { 'a.example.com': [PUBLIC_A], 'b.example.com': [PUBLIC_B], 'inside.example.com': ['192.168.1.10'], 'tail.example.com': ['100.101.102.103'] },
      pages: {
        'http://a.example.com/one': hop('https://a.example.com/two'),
        'https://a.example.com/two': { status: 301, headers: { location: '/three?x=1' }, body: '' },
        'https://a.example.com/three?x=1': { status: 307, headers: { location: 'https://b.example.com/final' }, body: '' },
        'https://b.example.com/final': htmlPage('<title>Arrived</title>'),
        'https://a.example.com/four': hop('http://a.example.com/one'),
        'https://a.example.com/loop': hop('https://b.example.com/loop'),
        'https://b.example.com/loop': hop('https://a.example.com/loop'),
        'https://a.example.com/to-private': hop('https://inside.example.com/admin'),
        'https://a.example.com/to-tailnet': hop('http://tail.example.com/'),
        'https://a.example.com/to-literal': hop('http://192.168.1.1/'),
        'https://a.example.com/to-decimal': hop('http://2130706433/'),
        'https://a.example.com/to-v6': hop('http://[::1]/'),
        'https://a.example.com/to-localhost': hop('http://localhost/'),
        'https://a.example.com/to-local-name': hop('http://nas.local/'),
        'https://a.example.com/to-port': hop('https://b.example.com:8443/final'),
        'https://a.example.com/to-creds': hop('https://user:pw@b.example.com/final'),
        'https://a.example.com/to-own': hop('https://party.example.org/app/'),
        'https://a.example.com/to-ftp': hop('ftp://b.example.com/final'),
        'https://a.example.com/to-file': hop('file:///etc/passwd'),
        'https://a.example.com/to-nowhere': { status: 302, headers: {}, body: '' },
        'https://a.example.com/to-long': hop(`https://b.example.com/${'a'.repeat(MAX_URL_LENGTH)}`),
        'https://inside.example.com/admin': htmlPage('<title>Router admin</title>'),
        'http://tail.example.com/': htmlPage('<title>Tailnet box</title>'),
      },
    });
    const { previews } = await service(fake);
    const own = new Set(['party.example.org']);

    // Three hops, across schemes and hosts, with a relative Location: allowed.
    assert.deepEqual(await previews.fetchPreview('http://a.example.com/one', own), { url: 'http://a.example.com/one', title: 'Arrived' });
    assert.deepEqual(fake.requests().map((r) => [r.url, r.address, r.port]), [
      ['http://a.example.com/one', PUBLIC_A, 80], ['https://a.example.com/two', PUBLIC_A, 443],
      ['https://a.example.com/three?x=1', PUBLIC_A, 443], ['https://b.example.com/final', PUBLIC_B, 443],
    ]);
    assert.equal(fake.lookups().length, 4, 'a lookup per hop: nothing carried over from the hop before');

    // One more than that: refused, and the fifth request is never made.
    fake.log.length = 0;
    await refused(previews.fetchPreview('https://a.example.com/four', own), 'too-many-redirects');
    assert.equal(fake.requests().length, MAX_REDIRECTS + 1);
    fake.log.length = 0;
    await refused(previews.fetchPreview('https://a.example.com/loop', own), 'too-many-redirects');
    assert.equal(fake.requests().length, MAX_REDIRECTS + 1);

    // A redirect to anything the rules refuse ends the fetch, before a single byte goes there.
    const ends = {
      'to-private': 'private', 'to-tailnet': 'cgnat', 'to-literal': 'ip-literal', 'to-decimal': 'ip-literal', 'to-v6': 'ip-literal',
      'to-localhost': 'single-label', 'to-local-name': 'internal-name', 'to-port': 'port', 'to-creds': 'credentials', 'to-own': 'own-host',
      'to-ftp': 'scheme', 'to-file': 'scheme', 'to-nowhere': 'status', 'to-long': 'url-too-long',
    };
    for (const [from, reason] of Object.entries(ends)) {
      fake.log.length = 0;
      await refused(previews.fetchPreview(`https://a.example.com/${from}`, own), reason);
      assert.deepEqual(fake.requests().map((r) => r.url), [`https://a.example.com/${from}`], `${from}: only the first hop was requested`);
    }
  });

  test('the whole fetch has one deadline, wherever it stalls', async () => {
    const hang = () => new Promise(() => {});
    const stalls = {
      'in the lookup': fakeNet({ hosts: { 'slow.example.com': hang }, pages: {} }),
      'before the response': fakeNet({ hosts: { 'slow.example.com': [PUBLIC_A] }, pages: { 'https://slow.example.com/': { hang: true } } }),
      'part-way through the body': fakeNet({ hosts: { 'slow.example.com': [PUBLIC_A] }, pages: { 'https://slow.example.com/': htmlPage('<title>Never finishes</title>', { hangAfterBody: true }) } }),
      'a body that trickles': fakeNet({ hosts: { 'slow.example.com': [PUBLIC_A] }, pages: { 'https://slow.example.com/': htmlPage(`<title>Slow</title>${'x'.repeat(4000)}`, { chunkSize: 10, bodyDelayMs: 20 }) } }),
      'spread over redirects': fakeNet({
        hosts: { 'slow.example.com': [PUBLIC_A] },
        pages: {
          'https://slow.example.com/': { status: 302, headers: { location: '/b' }, delayMs: 90 },
          'https://slow.example.com/b': { status: 302, headers: { location: '/c' }, delayMs: 90 },
          'https://slow.example.com/c': htmlPage('<title>Too late</title>', { delayMs: 90 }),
        },
      }),
    };
    for (const [where, fake] of Object.entries(stalls)) {
      const { previews } = await service(fake, { timeoutMs: 200 });
      const started = Date.now();
      await refused(previews.fetchPreview('https://slow.example.com/', new Set()), 'timeout');
      const took = Date.now() - started;
      assert.ok(took >= 150 && took < 1500, `${where}: gave up after ${took}ms`);
    }
    // A page that is merely a little slow is fine.
    const ok = fakeNet({ hosts: { 'slow.example.com': [PUBLIC_A] }, pages: { 'https://slow.example.com/': htmlPage('<title>In time</title>', { delayMs: 40 }) } });
    assert.equal((await (await service(ok, { timeoutMs: 1000 })).previews.fetchPreview('https://slow.example.com/', new Set())).title, 'In time');
  });

  test(`a page is read up to ${MAX_HTML_BYTES / 1024} KB and no further, whatever it declares`, async () => {
    const head = og({ title: 'Near the top' });
    const padding = 'x'.repeat(4 * MAX_HTML_BYTES);
    const late = `<html><head>${padding}${og({ title: 'Past the cap' })}</head></html>`;
    const fake = fakeNet({
      hosts: { 'big.example.com': [PUBLIC_A] },
      pages: {
        'https://big.example.com/huge': { headers: { 'content-type': 'text/html' }, body: `<html><head>${head}</head><body>${padding}</body></html>` },
        'https://big.example.com/declared': { headers: { 'content-type': 'text/html', 'content-length': String(50 * 1024 * 1024) }, body: `<html><head>${head}</head><body>${padding}</body></html>` },
        'https://big.example.com/late': { headers: { 'content-type': 'text/html' }, body: late },
        'https://big.example.com/exact': { headers: { 'content-type': 'text/html' }, body: `${head}${'y'.repeat(MAX_HTML_BYTES - Buffer.byteLength(head))}` },
      },
    });
    const { previews } = await service(fake);
    for (const which of ['huge', 'declared']) {
      fake.log.length = 0;
      assert.equal((await previews.fetchPreview(`https://big.example.com/${which}`, new Set())).title, 'Near the top');
      const [req] = fake.requests();
      assert.ok(req.bytesRead <= MAX_HTML_BYTES + 16 * 1024, `${which}: stopped reading after ${req.bytesRead} bytes of ${5 * MAX_HTML_BYTES}`);
    }
    // What lies beyond the cap is never seen.
    await refused(previews.fetchPreview('https://big.example.com/late', new Set()), 'no-metadata');
    assert.equal((await previews.fetchPreview('https://big.example.com/exact', new Set())).title, 'Near the top');
  });

  test('only an HTML page with a successful, uncompressed answer is parsed', async () => {
    const body = page(og({ title: 'Should not be read' }));
    const answers = {
      json: [{ headers: { 'content-type': 'application/json' }, body }, 'content-type'],
      text: [{ headers: { 'content-type': 'text/plain' }, body }, 'content-type'],
      xml: [{ headers: { 'content-type': 'text/xml' }, body }, 'content-type'],
      svg: [{ headers: { 'content-type': 'image/svg+xml' }, body: SVG }, 'content-type'],
      image: [{ headers: { 'content-type': 'image/png' }, body: PNG }, 'content-type'],
      pdf: [{ headers: { 'content-type': 'application/pdf' }, body }, 'content-type'],
      binary: [{ headers: { 'content-type': 'application/octet-stream' }, body }, 'content-type'],
      lookalike: [{ headers: { 'content-type': 'text/htmlx' }, body }, 'content-type'],
      prefixed: [{ headers: { 'content-type': 'xtext/html' }, body }, 'content-type'],
      untyped: [{ headers: {}, body }, 'content-type'],
      empty: [{ headers: { 'content-type': '' }, body }, 'content-type'],
      gzip: [{ headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body }, 'content-encoding'],
      br: [{ headers: { 'content-type': 'text/html', 'content-encoding': 'br' }, body }, 'content-encoding'],
      missing: [{ status: 404, headers: { 'content-type': 'text/html' }, body }, 'status'],
      forbidden: [{ status: 403, headers: { 'content-type': 'text/html' }, body }, 'status'],
      login: [{ status: 401, headers: { 'content-type': 'text/html' }, body }, 'status'],
      broken: [{ status: 500, headers: { 'content-type': 'text/html' }, body }, 'status'],
      cached: [{ status: 304, headers: { 'content-type': 'text/html' }, body }, 'status'],
      multiple: [{ status: 300, headers: { 'content-type': 'text/html', location: 'https://types.example.com/elsewhere' }, body }, 'status'],
      bare: [{ headers: { 'content-type': 'text/html' }, body: '<p>no title, no meta</p>' }, 'no-metadata'],
      blank: [{ headers: { 'content-type': 'text/html' }, body: '' }, 'no-metadata'],
    };
    const fake = fakeNet({ hosts: { 'types.example.com': [PUBLIC_A] }, pages: Object.fromEntries(Object.entries(answers).map(([k, [v]]) => [`https://types.example.com/${k}`, v])) });
    const { previews } = await service(fake);
    for (const [which, [, reason]] of Object.entries(answers)) await refused(previews.fetchPreview(`https://types.example.com/${which}`, new Set()), reason);

    const fine = fakeNet({
      hosts: { 'types.example.com': [PUBLIC_A] },
      pages: {
        'https://types.example.com/caps': { headers: { 'content-type': 'TEXT/HTML; Charset=UTF-8' }, body },
        'https://types.example.com/xhtml': { headers: { 'content-type': 'application/xhtml+xml' }, body },
        'https://types.example.com/identity': { headers: { 'content-type': 'text/html', 'content-encoding': 'identity' }, body },
        'https://types.example.com/latin': { headers: { 'content-type': 'text/html; charset=iso-8859-1' }, body: Buffer.from('<title>Caf\xe9 M\xfcller</title>', 'latin1') },
        'https://types.example.com/meta-charset': { headers: { 'content-type': 'text/html' }, body: Buffer.from('<meta charset="windows-1252"><title>Na\xefve \x93quotes\x94</title>', 'latin1') },
        'https://types.example.com/odd-charset': { headers: { 'content-type': 'text/html; charset=no-such-charset' }, body: '<title>Still read as UTF-8 ✓</title>' },
      },
    });
    const ok = (await service(fine)).previews;
    assert.equal((await ok.fetchPreview('https://types.example.com/caps', new Set())).title, 'Should not be read');
    assert.equal((await ok.fetchPreview('https://types.example.com/xhtml', new Set())).title, 'Should not be read');
    assert.equal((await ok.fetchPreview('https://types.example.com/identity', new Set())).title, 'Should not be read');
    assert.equal((await ok.fetchPreview('https://types.example.com/latin', new Set())).title, 'Café Müller');
    assert.equal((await ok.fetchPreview('https://types.example.com/meta-charset', new Set())).title, 'Naïve “quotes”');
    assert.equal((await ok.fetchPreview('https://types.example.com/odd-charset', new Set())).title, 'Still read as UTF-8 ✓');
  });

  test('the preview image: raster types only, by declared type and by its bytes, and capped', async () => {
    const withImage = (image) => htmlPage(og({ title: 'Has an image', image }));
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES, 1)]);
    const fake = fakeNet({
      hosts: { 'img.example.com': [PUBLIC_A], 'cdn.example.net': [PUBLIC_B], 'inside.example.com': ['192.168.1.10'], 'moved.example.org': [PUBLIC_B] },
      pages: {
        'https://img.example.com/png': withImage('https://cdn.example.net/a.png'),
        'https://img.example.com/jpeg': withImage('https://cdn.example.net/a.jpg'),
        'https://img.example.com/gif': withImage('https://cdn.example.net/a.gif'),
        'https://img.example.com/webp': withImage('https://cdn.example.net/a.webp'),
        'https://img.example.com/mislabelled': withImage('https://cdn.example.net/jpeg-called-png'),
        'https://img.example.com/svg': withImage('https://cdn.example.net/a.svg'),
        'https://img.example.com/svg-as-png': withImage('https://cdn.example.net/svg-as-png'),
        'https://img.example.com/html-as-png': withImage('https://cdn.example.net/html-as-png'),
        'https://img.example.com/untyped': withImage('https://cdn.example.net/untyped'),
        'https://img.example.com/avif': withImage('https://cdn.example.net/a.avif'),
        'https://img.example.com/declared-big': withImage('https://cdn.example.net/declared-big'),
        'https://img.example.com/actually-big': withImage('https://cdn.example.net/actually-big'),
        'https://img.example.com/lying-small': withImage('https://cdn.example.net/lying-small'),
        'https://img.example.com/private': withImage('https://inside.example.com/cam.jpg'),
        'https://img.example.com/literal': withImage('http://192.168.1.1/logo.png'),
        'https://img.example.com/port': withImage('https://cdn.example.net:8443/a.png'),
        'https://img.example.com/data': withImage('data:image/png;base64,iVBORw0KGgo='),
        'https://img.example.com/js': withImage('javascript:alert(1)'),
        'https://img.example.com/file': withImage('file:///etc/passwd'),
        'https://img.example.com/missing': withImage('https://cdn.example.net/404.png'),
        'https://img.example.com/redirect-private': withImage('https://cdn.example.net/hop-inside'),
        'https://img.example.com/escaped': withImage('https://cdn.example.net/a.png?x=1&amp;y=2'),
        'https://img.example.com/moved': { status: 302, headers: { location: 'https://moved.example.org/deep/page' } },
        'https://moved.example.org/deep/page': withImage('../pic.png'),
        'https://moved.example.org/pic.png': { headers: { 'content-type': 'image/png' }, body: PNG },
        'https://cdn.example.net/a.png': { headers: { 'content-type': 'image/png' }, body: PNG },
        'https://cdn.example.net/a.png?x=1&y=2': { headers: { 'content-type': 'image/png' }, body: PNG },
        'https://cdn.example.net/a.jpg': { headers: { 'content-type': 'image/jpeg' }, body: JPEG },
        'https://cdn.example.net/a.gif': { headers: { 'content-type': 'IMAGE/GIF' }, body: GIF },
        'https://cdn.example.net/a.webp': { headers: { 'content-type': 'image/webp; q=1' }, body: WEBP },
        'https://cdn.example.net/jpeg-called-png': { headers: { 'content-type': 'image/png' }, body: JPEG },
        'https://cdn.example.net/a.svg': { headers: { 'content-type': 'image/svg+xml' }, body: SVG },
        'https://cdn.example.net/svg-as-png': { headers: { 'content-type': 'image/png' }, body: SVG },
        'https://cdn.example.net/html-as-png': { headers: { 'content-type': 'image/png' }, body: '<!doctype html><script>alert(1)</script>' },
        'https://cdn.example.net/untyped': { headers: {}, body: PNG },
        'https://cdn.example.net/a.avif': { headers: { 'content-type': 'image/avif' }, body: PNG },
        'https://cdn.example.net/declared-big': { headers: { 'content-type': 'image/png', 'content-length': String(MAX_IMAGE_BYTES + 1) }, body: big },
        'https://cdn.example.net/actually-big': { headers: { 'content-type': 'image/png' }, body: big },
        'https://cdn.example.net/lying-small': { headers: { 'content-type': 'image/png', 'content-length': '100' }, body: big },
        'https://cdn.example.net/hop-inside': { status: 302, headers: { location: 'https://inside.example.com/cam.jpg' } },
        'https://inside.example.com/cam.jpg': { headers: { 'content-type': 'image/jpeg' }, body: JPEG },
      },
    });
    const { previews, dataDir } = await service(fake);
    const imageOf = async (which) => (await previews.fetchPreview(`https://img.example.com/${which}`, new Set())).image;
    const filesNow = () => fs.readdirSync(path.join(dataDir, 'link-previews')).sort();

    // The four raster types, each stored under the extension of what its bytes are.
    assert.match(await imageOf('png'), /^\/link-previews\/[a-f0-9]{32}\.png$/);
    assert.match(await imageOf('jpeg'), /^\/link-previews\/[a-f0-9]{32}\.jpg$/);
    assert.match(await imageOf('gif'), /^\/link-previews\/[a-f0-9]{32}\.gif$/);
    assert.match(await imageOf('webp'), /^\/link-previews\/[a-f0-9]{32}\.webp$/);
    assert.match(await imageOf('mislabelled'), /\.jpg$/, 'the bytes decide the extension, not the label');
    assert.equal(await imageOf('escaped'), await imageOf('png'), 'the same bytes are the same file');
    assert.equal(filesNow().length, 4, 'one file per distinct image');
    assert.ok(filesNow().every((name) => /^[a-f0-9]{32}\.(png|jpg|gif|webp)$/.test(name)), 'named by content hash, never by anything the site said');

    // Everything else: the preview is kept, without an image, and nothing is written.
    for (const which of ['svg', 'svg-as-png', 'html-as-png', 'untyped', 'avif', 'declared-big', 'actually-big', 'lying-small', 'private', 'literal', 'port', 'data', 'js', 'file', 'missing', 'redirect-private']) {
      fake.log.length = 0;
      const preview = await previews.fetchPreview(`https://img.example.com/${which}`, new Set());
      assert.deepEqual(preview, { url: `https://img.example.com/${which}`, title: 'Has an image' }, which);
      if (['private', 'literal', 'port', 'data', 'js', 'file'].includes(which)) assert.equal(fake.requests().length, 1, `${which}: the image was never requested`);
      if (which === 'redirect-private') assert.ok(!fake.requests().some((r) => r.hostname === 'inside.example.com'), 'the redirect into the LAN was not followed');
      if (which === 'declared-big') assert.equal(fake.requests()[1].bytesRead, 0, 'refused on its declared size, before a byte was read');
      if (which === 'actually-big' || which === 'lying-small') assert.ok(fake.requests()[1].bytesRead <= MAX_IMAGE_BYTES + 16 * 1024, `${which}: stopped at the cap`);
    }
    assert.equal(filesNow().length, 4, 'none of those left a file');
    assert.ok(!filesNow().some((name) => /\.(svg|html?|tmp)$/.test(name)));

    // A relative image address is resolved against the page that was finally reached.
    fake.log.length = 0;
    assert.match(await imageOf('moved'), /\.png$/);
    assert.equal(fake.requests().at(-1).url, 'https://moved.example.org/pic.png');
  });

  test('one link is fetched once: answers are cached, and a fetch in progress is shared', async () => {
    let clock = 1_700_000_000_000;
    const fake = storyNet({
      hosts: { 'gone.example.com': [PUBLIC_A], 'inside.example.com': ['10.0.0.5'] },
      pages: { 'https://gone.example.com/': { status: 404, headers: { 'content-type': 'text/html' } } },
    });
    const { previews, db } = await service(fake, { now: () => clock });
    const ask = (url, user = 'ann') => previews.previewFor(url, { user });

    // Five people post it at the same moment: one fetch, shared.
    const all = await Promise.all(['ann', 'ben', 'cy', 'dee', 'eli'].map((user) => ask(STORY, user)));
    assert.ok(all.every((p) => p && p.title === 'Big news'));
    assert.equal(fake.requests().length, 2, 'the page and its image, once');
    // And again later: from the cache, with nothing fetched.
    assert.deepEqual(await ask(STORY, 'fay'), all[0]);
    assert.equal(fake.requests().length, 2);
    const [row] = await db.all('SELECT * FROM link_previews WHERE url = ?', STORY);
    assert.equal(row.status, 'ok');
    assert.equal(row.expires_at - row.fetched_at, OK_TTL_MS);
    assert.equal(OK_TTL_MS, 24 * 60 * 60 * 1000);

    // A failure is remembered too, for a shorter time: a dead link, and one that is refused.
    assert.equal(await ask('https://gone.example.com/'), null);
    assert.equal(await ask('https://inside.example.com/'), null);
    const lookups = fake.lookups().length;
    const requests = fake.requests().length;
    for (let i = 0; i < 5; i += 1) { assert.equal(await ask('https://gone.example.com/'), null); assert.equal(await ask('https://inside.example.com/'), null); }
    assert.equal(fake.lookups().length, lookups, 'not even looked up again');
    assert.equal(fake.requests().length, requests);
    const failed = await db.all("SELECT url, status, data, expires_at - fetched_at AS ttl FROM link_previews WHERE status = 'none' ORDER BY url");
    assert.deepEqual(failed, [
      { url: 'https://gone.example.com/', status: 'none', data: null, ttl: FAIL_TTL_MS },
      { url: 'https://inside.example.com/', status: 'none', data: null, ttl: FAIL_TTL_MS },
    ]);
    assert.equal(FAIL_TTL_MS, 60 * 60 * 1000);
    assert.deepEqual(previews.refusals().map((r) => r.reason), ['status', 'private']);

    // Once the hour is up the dead link is tried again; the good one is still cached.
    clock += FAIL_TTL_MS + 1;
    assert.equal(await ask('https://gone.example.com/'), null);
    assert.equal(fake.requests().length, requests + 1);
    await ask(STORY);
    assert.equal(fake.requests().length, requests + 1);
    // After a day the good one is fetched afresh.
    clock += OK_TTL_MS;
    assert.equal((await ask(STORY)).title, 'Big news');
    assert.equal(fake.requests().length, requests + 3, 'the page and its image again');
  });

  test(`each person may cause ${USER_FETCHES_PER_WINDOW} fetches a minute; the cache is free`, async () => {
    let clock = 1_700_000_000_000;
    const hosts = {};
    const pages = {};
    for (let i = 0; i < 40; i += 1) { hosts[`site${i}.example.com`] = [PUBLIC_A]; pages[`https://site${i}.example.com/`] = htmlPage(`<title>Site ${i}</title>`); }
    const fake = fakeNet({ hosts, pages });
    const { previews } = await service(fake, { now: () => clock });
    const ask = (i, user) => previews.previewFor(`https://site${i}.example.com/`, { user });

    for (let i = 0; i < USER_FETCHES_PER_WINDOW; i += 1) assert.equal((await ask(i, 'ann')).title, `Site ${i}`);
    assert.equal(await ask(20, 'ann'), null, 'over the limit: no preview');
    assert.equal(await ask(21, 'ann'), null);
    assert.equal(fake.lookups().length, USER_FETCHES_PER_WINDOW, 'and nothing was looked up or fetched for it');
    assert.deepEqual(previews.refusals().map((r) => r.reason), ['rate-limited', 'rate-limited']);
    // What is already known costs nothing, however often it is asked for.
    for (let n = 0; n < 30; n += 1) assert.equal((await ask(3, 'ann')).title, 'Site 3');
    // The limit is per person…
    assert.equal((await ask(20, 'ben')).title, 'Site 20');
    // …a link with nobody behind it is never fetched…
    assert.equal(await ask(22, null), null);
    assert.equal(await ask(22, ''), null);
    // …and it lifts after a minute.
    clock += 61_000;
    assert.equal((await ask(21, 'ann')).title, 'Site 21');
    // A refusal that was about the moment is not remembered against the link.
    assert.equal((await ask(22, 'ann')).title, 'Site 22');
  });

  test(`at most ${MAX_CONCURRENT} fetches run at once, a few wait, and the rest are dropped`, async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const hosts = {};
    const pages = {};
    const total = MAX_CONCURRENT + MAX_QUEUED + 3;
    for (let i = 0; i < total; i += 1) { hosts[`busy${i}.example.com`] = [PUBLIC_A]; pages[`https://busy${i}.example.com/`] = htmlPage(`<title>Busy ${i}</title>`, { gate }); }
    const fake = fakeNet({ hosts, pages });
    const { previews } = await service(fake, { timeoutMs: 5000 });
    // A person each, so that this is about the server's capacity and not anyone's own allowance.
    const jobs = Array.from({ length: total }, (_, i) => previews.previewFor(`https://busy${i}.example.com/`, { user: `user${i}` }));
    // Every job has been placed once three have been turned away and the first four are out.
    await waitFor(() => previews.refusals().length === 3 && fake.requests().length === MAX_CONCURRENT, 'the jobs to be placed');
    await sleep(60);
    assert.equal(fake.requests().length, MAX_CONCURRENT, 'only this many are out at once');
    assert.equal(fake.state.maxActive, MAX_CONCURRENT);
    // The ones beyond the queue have already been answered: no preview, and no work kept for
    // later. (Which three they are depends on the order the cache lookups came back in.)
    assert.deepEqual(previews.refusals().map((r) => r.reason), ['busy', 'busy', 'busy']);
    const droppedUrls = new Set(previews.refusals().map((r) => r.url));
    const dropped = await Promise.all(jobs.filter((_, i) => droppedUrls.has(`https://busy${i}.example.com/`)));
    assert.deepEqual(dropped, [null, null, null]);

    release();
    const done = await Promise.all(jobs);
    const served = done.map((p, i) => [i, p && p.title]).filter(([i]) => !droppedUrls.has(`https://busy${i}.example.com/`));
    assert.equal(served.length, MAX_CONCURRENT + MAX_QUEUED);
    for (const [i, title] of served) assert.equal(title, `Busy ${i}`, 'everyone in the queue was served');
    assert.equal(fake.state.maxActive, MAX_CONCURRENT, 'and never more than that at a time');
    assert.equal(fake.requests().length, MAX_CONCURRENT + MAX_QUEUED);
    // The slots are free again afterwards, and a dropped link was not remembered as a failure.
    const [again] = [...droppedUrls];
    assert.match((await previews.previewFor(again, { user: 'later' })).title, /^Busy \d+$/);
  });

  test('a slot is given back when a fetch fails or times out', async () => {
    const hosts = {};
    const pages = {};
    for (let i = 0; i < MAX_CONCURRENT * 3; i += 1) { hosts[`dead${i}.example.com`] = [PUBLIC_A]; pages[`https://dead${i}.example.com/`] = i % 2 ? { hang: true } : { status: 500, headers: { 'content-type': 'text/html' } }; }
    hosts['alive.example.com'] = [PUBLIC_A];
    pages['https://alive.example.com/'] = htmlPage('<title>Alive</title>');
    const fake = fakeNet({ hosts, pages });
    const { previews } = await service(fake, { timeoutMs: 120 });
    const all = await Promise.all(Array.from({ length: MAX_CONCURRENT * 3 }, (_, i) => previews.previewFor(`https://dead${i}.example.com/`, { user: `u${i}` })));
    assert.ok(all.every((p) => p === null));
    assert.equal((await previews.previewFor('https://alive.example.com/', { user: 'ann' })).title, 'Alive');
  });

  test('the kill switch: LINK_PREVIEWS=0 means nothing is looked up, fetched or attached', async () => {
    for (const value of ['0', 'false', 'off', ' OFF ']) {
      const fake = storyNet();
      const { previews, db, log } = await service(fake, { env: { LINK_PREVIEWS: value } });
      assert.equal(previews.enabled(), false, value);
      assert.ok(log.lines.some((l) => /link previews are off/.test(l)));
      assert.equal(await previews.previewFor(STORY, { user: 'ann' }), null);
      await db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts) VALUES (1, 'demo', 'general', 'ann', ?, 1)", `see ${STORY}`);
      let emitted = 0;
      assert.equal(await previews.attachTo({ table: 'messages', id: 1, user: 'ann', emit: () => { emitted += 1; } }), null);
      assert.equal(emitted, 0);
      assert.equal(fake.log.length, 0, 'the network was not touched in any way');
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM link_previews')).n, 0);
    }
    for (const value of [undefined, '', '1', 'true', 'on']) {
      assert.equal((await service(storyNet(), { env: { LINK_PREVIEWS: value } })).previews.enabled(), true, String(value));
    }
  });

  test('a stand-in network that cannot be loaded turns previews off rather than falling back to the real one', async () => {
    const db = await freshDb();
    const log = quietLog();
    const previews = createLinkPreviews({ db, dataDir: tmpDir(), env: { LINK_PREVIEW_TRANSPORT: path.join(__dirname, 'fixtures', 'no-such-transport.js') }, log });
    assert.equal(previews.enabled(), false);
    assert.ok(log.lines.some((l) => /LINK_PREVIEW_TRANSPORT could not be loaded: link previews are off/.test(l)));
    assert.equal(await previews.previewFor('https://news.example.com/story', { user: 'ann' }), null);
    // One that loads but is not a transport is no better.
    const notOne = createLinkPreviews({ db, dataDir: tmpDir(), env: { LINK_PREVIEW_TRANSPORT: path.join(__dirname, 'fixtures', 'fakeWebPush.js') }, log: quietLog() });
    assert.equal(notOne.enabled(), false);
    // The real stand-in loads, and is what gets used.
    const stood = createLinkPreviews({ db, dataDir: tmpDir(), env: { LINK_PREVIEW_TRANSPORT: FAKE_TRANSPORT, DATA_DIR: tmpDir() }, log: quietLog() });
    assert.equal(stood.enabled(), true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: attaching to a stored message', () => {
  const STORY = 'https://news.example.com/story';
  const OTHER = 'https://blog.example.org/post';
  const web = (extra = {}) => fakeNet({
    hosts: { 'news.example.com': [PUBLIC_A], 'blog.example.org': [PUBLIC_B] },
    pages: { [STORY]: htmlPage(og({ title: 'Big news' }), extra), [OTHER]: htmlPage(og({ title: 'A post' })) },
  });
  const TABLES = [
    ['messages', (db, id, text, attachment = null) => db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts, attachment_json) VALUES (?, 'demo', 'general', 'ann', ?, 1, ?)", id, text, attachment), 'text'],
    ['direct_messages', (db, id, text, attachment = null) => db.run('INSERT INTO direct_messages (id, sender_id, recipient_id, body, created_at, attachment_json) VALUES (?, 1, 2, ?, 1, ?)', id, text, attachment), 'body'],
    ['group_messages', (db, id, text, attachment = null) => db.run("INSERT INTO group_messages (id, group_id, sender_id, body, created_at, attachment_json) VALUES (?, 'grp-1', 1, ?, 1, ?)", id, text, attachment), 'body'],
  ];
  const stored = async (db, table, id) => { const row = await db.get(`SELECT preview_json FROM ${table} WHERE id = ?`, id); return row ? row.preview_json && JSON.parse(row.preview_json) : undefined; };

  test('the preview lands on the row and is announced, for each of the three kinds of message', async () => {
    for (const [table, insert] of TABLES) {
      const fake = web();
      const { previews, db } = await service(fake);
      await insert(db, 7, `have a look: ${STORY}`);
      const events = [];
      const preview = await previews.attachTo({ table, id: 7, user: 'ann', emit: (p) => events.push(p) });
      assert.deepEqual(preview, { url: STORY, title: 'Big news' }, table);
      assert.deepEqual(events, [preview], 'announced once, after it was stored');
      assert.deepEqual(await stored(db, table, 7), preview);

      // No link, a media link, a refused link, an attachment: nothing happens, and nothing is fetched.
      fake.log.length = 0;
      await insert(db, 8, 'no link in this one');
      await insert(db, 9, 'https://media.tenor.com/x/cat.gif');
      await insert(db, 10, 'http://192.168.1.1/admin and http://nas.local/');
      await insert(db, 11, STORY, '{"url":"/uploads/1-ab-shot.png","name":"shot.png"}');
      for (const id of [8, 9, 10, 11, 404]) {
        assert.equal(await previews.attachTo({ table, id, user: 'ann', emit: (p) => events.push(p) }), null);
        if (id !== 404) assert.equal(await stored(db, table, id), null);
      }
      assert.equal(fake.log.length, 0, table);
      assert.equal(events.length, 1);
    }
    // A table that is not one of the three is not something to build SQL from.
    const { previews } = await service(web());
    assert.equal(await previews.attachTo({ table: 'users; DROP TABLE users', id: 1, user: 'ann', emit() {} }), null);
    assert.equal(await previews.remove('users', 1), false);
  });

  test('a message deleted or edited while its page was being fetched gets nothing', async () => {
    for (const [table, insert, column] of TABLES) {
      let release;
      const fake = web({ gate: new Promise((resolve) => { release = resolve; }) });
      // The same database, counting the cache lookups that have come back: once all three jobs
      // are past theirs, each has read its message and is waiting on the one fetch.
      const db = await freshDb();
      let lookedUp = 0;
      const counting = {
        exec: db.exec.bind(db), run: db.run.bind(db), all: db.all.bind(db),
        get: async (sql, ...params) => { const row = await db.get(sql, ...params); if (/FROM link_previews/.test(sql)) lookedUp += 1; return row; },
      };
      const { previews } = await service(fake, { db: counting });
      await insert(db, 1, `deleted soon ${STORY}`);
      await insert(db, 2, `edited soon ${STORY}`);
      await insert(db, 3, `kept ${STORY}`);
      const events = [];
      const jobs = [1, 2, 3].map((id) => previews.attachTo({ table, id, user: 'ann', emit: (p) => events.push([id, p]) }));
      await waitFor(() => lookedUp === 3 && fake.requests().length === 1, 'the three jobs to be waiting on the fetch');
      await db.run(`DELETE FROM ${table} WHERE id = 1`);
      await db.run(`UPDATE ${table} SET ${column} = ? WHERE id = 2`, `now about ${OTHER}`);
      release();
      const [gone, changed, kept] = await Promise.all(jobs);
      assert.equal(gone, null);
      assert.equal(changed, null, 'the page that came back is not for the link the message now has');
      assert.equal(await stored(db, table, 2), null);
      assert.deepEqual(kept, { url: STORY, title: 'Big news' });
      assert.deepEqual(events, [[3, kept]]);
      assert.equal(fake.requests().length, 1, 'three messages, one link, one fetch');
    }
  });

  test('an edit only looks at the preview again when the link itself changed', async () => {
    for (const [table, insert, column] of TABLES) {
      const fake = web();
      const { previews, db } = await service(fake);
      const events = [];
      const edit = async (oldText, newText) => {
        await db.run(`UPDATE ${table} SET ${column} = ? WHERE id = 1`, newText);
        await previews.afterEdit({ table, id: 1, oldText, newText, user: 'ann', emit: (p) => events.push(p), clear: () => events.push(null) });
      };
      const first = `look ${STORY}`;
      await insert(db, 1, first);
      await previews.attachTo({ table, id: 1, user: 'ann', emit: (p) => events.push(p) });
      assert.equal(events.length, 1);
      const fetched = fake.requests().length;

      // Words around the link change: nothing happens at all.
      await edit(first, `look again!! ${STORY} (typo fixed)`);
      assert.equal(events.length, 1);
      assert.equal(fake.log.length, fetched + 1, 'no lookup, no request');
      assert.deepEqual(await stored(db, table, 1), { url: STORY, title: 'Big news' });

      // The link changes: the old card comes off, and the new link gets its own.
      await edit(`look again!! ${STORY} (typo fixed)`, `actually ${OTHER}`);
      assert.deepEqual(events.slice(1), [null, { url: OTHER, title: 'A post' }]);
      assert.deepEqual(await stored(db, table, 1), { url: OTHER, title: 'A post' });

      // The link is taken out: the card comes off and nothing is fetched.
      const before = fake.log.length;
      await edit(`actually ${OTHER}`, 'never mind');
      assert.deepEqual(events.slice(3), [null]);
      assert.equal(await stored(db, table, 1), null);
      assert.equal(fake.log.length, before);

      // The card links where the author's link pointed, fragment and all, while the page is
      // fetched (and cached) without it. A changed fragment is a changed link: the card follows
      // it, from the cache, with nothing fetched.
      const mark = fake.log.length;
      await edit('never mind', `see ${STORY}#comments`);
      assert.deepEqual(await stored(db, table, 1), { url: `${STORY}#comments`, title: 'Big news' });
      await edit(`see ${STORY}#comments`, `see ${STORY}#/reviews?page=2`);
      assert.deepEqual(await stored(db, table, 1), { url: `${STORY}#/reviews?page=2`, title: 'Big news' });
      assert.deepEqual(events.slice(4), [{ url: `${STORY}#comments`, title: 'Big news' }, null, { url: `${STORY}#/reviews?page=2`, title: 'Big news' }]);
      assert.equal(fake.log.length, mark, 'the page was already known');
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM link_previews')).n, 2, 'one cache row per page, whatever the fragment');

      // Its author removed the preview: an edit that keeps the link does not bring it back.
      await edit(`see ${STORY}#/reviews?page=2`, `back to ${STORY}`);
      assert.deepEqual(await stored(db, table, 1), { url: STORY, title: 'Big news' });
      assert.equal(await previews.remove(table, 1), true);
      assert.equal(await previews.remove(table, 1), false, 'there was nothing left to remove');
      const count = events.length;
      await edit(`back to ${STORY}`, `back to ${STORY}, as I said`);
      assert.equal(await stored(db, table, 1), null);
      assert.equal(events.length, count);
    }
  });

  test('with fetching switched off, an edit still takes a stale card off', async () => {
    const fake = web();
    const { previews, db } = await service(fake, { env: { LINK_PREVIEWS: '0' } });
    await db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts, preview_json) VALUES (1, 'demo', 'general', 'ann', ?, 1, ?)", `old ${STORY}`, JSON.stringify({ url: STORY, title: 'Big news' }));
    const events = [];
    await db.run('UPDATE messages SET text = ? WHERE id = 1', `new ${OTHER}`);
    await previews.afterEdit({ table: 'messages', id: 1, oldText: `old ${STORY}`, newText: `new ${OTHER}`, user: 'ann', emit: (p) => events.push(p), clear: () => events.push(null) });
    assert.deepEqual(events, [null]);
    assert.equal(await stored(db, 'messages', 1), null);
    assert.equal(fake.log.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: the sweep', () => {
  test('images older than 30 days that nothing shows any more are removed; everything else stays', async () => {
    assert.equal(IMAGE_KEEP_MS, 30 * 24 * 60 * 60 * 1000);
    const fake = fakeNet();
    const { previews, db, dataDir } = await service(fake);
    const dir = path.join(dataDir, 'link-previews');
    fs.mkdirSync(dir, { recursive: true });
    const name = (ch, ext = 'png') => `${ch.repeat(32)}.${ext}`;
    const put = (file, daysOld) => {
      fs.writeFileSync(path.join(dir, file), PNG);
      const when = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
      fs.utimesSync(path.join(dir, file), when, when);
    };
    const preview = (file) => JSON.stringify({ url: 'https://news.example.com/x', title: 'T', image: `/link-previews/${file}` });
    put(name('a'), 45); // old, on a channel message
    put(name('b'), 45); // old, on a direct message
    put(name('c'), 45); // old, on a group message
    put(name('d'), 45); // old, only in the cache (still within its day)
    put(name('e'), 45); // old, shown nowhere                                -> removed
    put(name('f'), 31); // old, was on a message that has since been deleted -> removed
    put(name('0'), 29); // young, shown nowhere: within its 30 days
    put(name('1'), 0);  // brand new, shown nowhere (a fetch that just finished)
    put(name('2', 'jpg'), 400); // very old, on a message
    await db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts, preview_json) VALUES (1, 'demo', 'general', 'ann', 'x', 1, ?)", preview(name('a')));
    await db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts, preview_json) VALUES (2, 'demo', 'general', 'ann', 'x', 1, ?)", preview(name('2', 'jpg')));
    await db.run('INSERT INTO direct_messages (sender_id, recipient_id, body, created_at, preview_json) VALUES (1, 2, ?, 1, ?)', 'x', preview(name('b')));
    await db.run("INSERT INTO group_messages (group_id, sender_id, body, created_at, preview_json) VALUES ('grp-1', 1, 'x', 1, ?)", preview(name('c')));
    await db.run("INSERT INTO messages (id, server_id, channel_id, author, text, ts, preview_json) VALUES (3, 'demo', 'general', 'ann', 'x', 1, ?)", preview(name('f')));
    await db.run('DELETE FROM messages WHERE id = 3');
    const now = Date.now();
    await db.run("INSERT INTO link_previews (url, status, data, fetched_at, expires_at) VALUES ('https://live.example.com/', 'ok', ?, ?, ?)", preview(name('d')), now, now + 60_000);
    await db.run("INSERT INTO link_previews (url, status, data, fetched_at, expires_at) VALUES ('https://stale.example.com/', 'ok', ?, ?, ?)", preview(name('e')), now - 2 * OK_TTL_MS, now - OK_TTL_MS);
    await db.run("INSERT INTO link_previews (url, status, data, fetched_at, expires_at) VALUES ('https://dead.example.com/', 'none', NULL, ?, ?)", now - 2 * FAIL_TTL_MS, now - 1);

    assert.deepEqual(await previews.sweep(), { files: 2, rows: 2 });
    assert.deepEqual(fs.readdirSync(dir).sort(), [name('0'), name('1'), name('2', 'jpg'), name('a'), name('b'), name('c'), name('d')].sort());
    assert.deepEqual((await db.all('SELECT url FROM link_previews')).map((r) => r.url), ['https://live.example.com/'], 'expired cache rows went with it');
    // Again: nothing more to do, and nothing that was kept is touched.
    assert.deepEqual(await previews.sweep(), { files: 0, rows: 0 });
    assert.equal(fs.readdirSync(dir).length, 7);
    // A folder that is not there is not an error.
    fs.rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(await previews.sweep(), { files: 0, rows: 0 });
    assert.equal(fake.log.length, 0);
  });

  test('the image folder has a ceiling: over it, previews go without an image until the sweep makes room', async () => {
    assert.ok(MAX_IMAGE_STORE_BYTES >= 50 * MAX_IMAGE_BYTES && MAX_IMAGE_STORE_BYTES <= 2 * 1024 * 1024 * 1024);
    const pages = {};
    const images = { png: PNG, jpg: JPEG, gif: GIF, webp: WEBP };
    const types = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
    for (const [ext, bytes] of Object.entries(images)) {
      pages[`https://news.example.com/${ext}`] = htmlPage(og({ title: ext, image: `/img.${ext}` }));
      pages[`https://news.example.com/img.${ext}`] = { headers: { 'content-type': types[ext] }, body: bytes };
    }
    const fake = fakeNet({ hosts: { 'news.example.com': [PUBLIC_A] }, pages });
    // Room for the first two and not the third.
    const { previews, dataDir } = await service(fake, { maxStoreBytes: PNG.length + JPEG.length + 5 });
    const dir = path.join(dataDir, 'link-previews');
    const fetchOne = (ext) => previews.fetchPreview(`https://news.example.com/${ext}`, new Set());
    assert.match((await fetchOne('png')).image, /\.png$/);
    assert.match((await fetchOne('jpg')).image, /\.jpg$/);
    assert.deepEqual(await fetchOne('gif'), { url: 'https://news.example.com/gif', title: 'gif' }, 'full: the card is still made, without its image');
    assert.deepEqual(await fetchOne('webp'), { url: 'https://news.example.com/webp', title: 'webp' });
    assert.equal(fs.readdirSync(dir).length, 2);
    // An image that is already there costs nothing, so it is still used.
    assert.match((await fetchOne('png')).image, /\.png$/);
    // The sweep collects what nothing shows any more, and there is room again.
    const longAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    for (const name of fs.readdirSync(dir)) fs.utimesSync(path.join(dir, name), longAgo, longAgo);
    assert.deepEqual(await previews.sweep(), { files: 2, rows: 0 });
    assert.match((await fetchOne('gif')).image, /\.gif$/);
  });

  test('fetching the same image again marks its file as in use', async () => {
    const fake = fakeNet({
      hosts: { 'news.example.com': [PUBLIC_A] },
      pages: {
        'https://news.example.com/one': htmlPage(og({ title: 'One', image: '/shared.png' })),
        'https://news.example.com/two': htmlPage(og({ title: 'Two', image: '/shared.png' })),
        'https://news.example.com/shared.png': { headers: { 'content-type': 'image/png' }, body: PNG },
      },
    });
    const { previews, dataDir } = await service(fake);
    const one = await previews.fetchPreview('https://news.example.com/one', new Set());
    const file = path.join(dataDir, 'link-previews', path.basename(one.image));
    const longAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(file, longAgo, longAgo);
    const two = await previews.fetchPreview('https://news.example.com/two', new Set());
    assert.equal(two.image, one.image);
    assert.ok(Date.now() - fs.statSync(file).mtimeMs < 60_000, 'so the sweep will not take a file a fresh preview points at');
    assert.deepEqual(await previews.sweep(), { files: 0, rows: 0 });
    assert.ok(fs.existsSync(file));
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: the real requester connects to the address it is given', () => {
  // The only real socket in this file, and it goes to 127.0.0.1. The fetcher itself would never
  // allow this address or this port; the requester is called on its own, to show that what it
  // dials is the address it was handed and that the name is only ever a header.
  let server, port;
  const seen = [];
  before(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, headers: req.headers });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Pinned</title>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });
  after(async () => { await new Promise((resolve) => server.close(resolve)); });

  test('the name is sent as Host and never resolved', async () => {
    // "does-not-resolve.invalid" has no address anywhere: if the requester looked the name up, this
    // would fail. It reaches the local server only because it dials the address it was given.
    const res = await pinnedRequest({
      protocol: 'http:', hostname: 'does-not-resolve.invalid', address: '127.0.0.1', family: 4, port,
      path: '/page?x=1', headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', Connection: 'close' },
    });
    assert.equal(res.status, 200);
    let body = '';
    for await (const chunk of res.body) body += chunk;
    assert.equal(body, '<title>Pinned</title>');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, '/page?x=1');
    assert.equal(seen[0].host, 'does-not-resolve.invalid', 'the original name, as the Host header');
    assert.equal(seen[0].headers['user-agent'], USER_AGENT);
    for (const header of ['cookie', 'referer', 'authorization', 'origin']) assert.equal(seen[0].headers[header], undefined, header);
    assert.equal(seen[0].headers.connection, 'close', 'one connection per request, not kept');
    res.destroy();
  });

  test('a caller that supplies its own Host header cannot change which name is sent', async () => {
    const res = await pinnedRequest({
      protocol: 'http:', hostname: 'real.invalid', address: '127.0.0.1', family: 4, port,
      path: '/', headers: { Host: 'spoofed.invalid', Connection: 'close' },
    });
    for await (const _ of res.body) { /* drain */ }
    assert.equal(seen.at(-1).host, 'real.invalid');
  });

  test('over https it dials the address, and the name is only the TLS server name and the Host header', async () => {
    // No connection is made: https.request is swapped for a recorder for the length of this test,
    // to read exactly what the requester would hand it. (The module object is the same one
    // services/linkPreview.js holds, so the swap is what it calls.)
    const https = require('node:https');
    const { EventEmitter } = require('node:events');
    const real = https.request;
    const calls = [];
    https.request = (options) => {
      calls.push(options);
      return Object.assign(new EventEmitter(), { end() {}, destroy() {} });
    };
    try {
      // Never settles (the recorder answers nothing); only what was asked for matters.
      void pinnedRequest({
        protocol: 'https:', hostname: 'secure.example.com', address: PUBLIC_A, family: 4, port: 443,
        path: '/page?x=1', headers: { 'User-Agent': USER_AGENT },
      });
      void pinnedRequest({ protocol: 'https:', hostname: 'six.example.com', address: PUBLIC_V6, family: 6, port: 443, path: '/', headers: {} });
    } finally {
      https.request = real;
    }
    assert.equal(calls.length, 2);
    const [options, six] = calls;
    assert.equal(options.host, PUBLIC_A, 'the address that was checked is what is dialled');
    assert.equal(options.hostname, undefined, 'and no name is given that could be resolved instead');
    assert.equal(options.servername, 'secure.example.com', 'SNI, and what the certificate is checked against');
    assert.equal(options.headers.Host, 'secure.example.com');
    assert.equal(options.port, 443);
    assert.equal(options.path, '/page?x=1');
    assert.equal(options.method, 'GET');
    assert.equal(options.agent, false, 'no shared agent: a connection is never reused for another name');
    assert.notEqual(options.rejectUnauthorized, false, 'certificates are verified');
    assert.equal(options.checkServerIdentity, undefined);
    for (const header of ['cookie', 'referer', 'authorization', 'origin']) assert.ok(!Object.keys(options.headers).some((h) => h.toLowerCase() === header), header);
    // Should the HTTP client ever ask for a lookup after all, it can only be told the same address.
    const answers = [];
    options.lookup('anything-else.example.net', {}, (err, address, family) => answers.push([err, address, family]));
    options.lookup('localhost', { all: true }, (err, list) => answers.push([err, list]));
    assert.deepEqual(answers, [[null, PUBLIC_A, 4], [null, [{ address: PUBLIC_A, family: 4 }]]]);
    assert.deepEqual([six.host, six.family, six.servername], [PUBLIC_V6, 6, 'six.example.com']);
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: end to end, on a server with a stand-in network', () => {
  let server, call, tok, ids, serverId, general, group;
  const sockets = {};
  const STORY = 'https://news.example.com/story';
  const POST = 'https://blog.example.org/post';
  const WEB = {
    hosts: {
      'news.example.com': [PUBLIC_A], 'cdn.example.net': [PUBLIC_B], 'blog.example.org': [PUBLIC_B],
      'intranet.example.com': ['192.168.1.10'], 'tailnet.example.com': ['100.101.102.103'], 'mixed.example.com': [PUBLIC_A, '10.0.0.7'],
      'refused.example.com': [PUBLIC_A], 'party.example.org': [PUBLIC_A],
    },
    pages: {
      [STORY]: { headers: { 'content-type': 'text/html; charset=utf-8' }, body: page(og({ title: 'Big news', description: 'It happened.', site: 'Example News', image: 'https://cdn.example.net/img/story.png' })) },
      'https://cdn.example.net/img/story.png': { headers: { 'content-type': 'image/png' }, bodyBase64: PNG.toString('base64') },
      [POST]: { headers: { 'content-type': 'text/html' }, body: page('<title>A post</title><meta name="description" content="Words about things.">') },
      'https://blog.example.org/second': { headers: { 'content-type': 'text/html' }, body: page('<title>Second post</title>') },
      'https://blog.example.org/svg': { headers: { 'content-type': 'text/html' }, body: page(og({ title: 'Vector', image: 'https://cdn.example.net/logo.svg' })) },
      'https://cdn.example.net/logo.svg': { headers: { 'content-type': 'image/svg+xml' }, body: SVG.toString() },
      'https://blog.example.org/hop': { status: 302, headers: { location: 'http://intranet.example.com/admin' } },
      'https://intranet.example.com/': { headers: { 'content-type': 'text/html' }, body: page('<title>Router admin</title>') },
      'http://intranet.example.com/admin': { headers: { 'content-type': 'text/html' }, body: page('<title>Router admin</title>') },
      'https://tailnet.example.com/': { headers: { 'content-type': 'text/html' }, body: page('<title>Tailnet box</title>') },
      'https://mixed.example.com/': { headers: { 'content-type': 'text/html' }, body: page('<title>Mixed</title>') },
      'https://refused.example.com/a': { headers: { 'content-type': 'text/html' }, body: page('<title>Should never be fetched</title>') },
      'https://refused.example.com/b': { headers: { 'content-type': 'text/html' }, body: page('<title>Should never be fetched</title>') },
      'https://refused.example.com/c': { headers: { 'content-type': 'text/html' }, body: page('<title>Should never be fetched</title>') },
      'https://party.example.org/app/': { headers: { 'content-type': 'text/html' }, body: page('<title>LAN Party</title>') },
    },
  };

  const asked = () => {
    const file = path.join(server.dataDir, 'link-requests.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  };
  const requested = () => asked().filter((e) => e.kind === 'request').map((e) => e.url);
  const lookedUp = () => asked().filter((e) => e.kind === 'resolve').map((e) => e.hostname);

  function once(socket, event, match = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const onEvent = (payload) => {
        if (!match(payload)) return;
        clearTimeout(timer);
        socket.off(event, onEvent);
        resolve(payload);
      };
      const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`timed out waiting for "${event}"`)); }, timeoutMs);
      socket.on(event, onEvent);
    });
  }
  // Resolves true if the event does NOT arrive within the window.
  const never = (socket, event, match = () => true, ms = 500) => once(socket, event, match, ms).then(() => false, () => true);
  const connect = async (base, token) => {
    const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
    await once(socket, 'connect');
    return socket;
  };
  const say = async (who, text) => {
    const echoed = once(sockets[who], 'message', (m) => m.text === text);
    sockets[who].emit('message', { serverId, channelId: general, text });
    return echoed;
  };
  const emitAck = (who, event, payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} was never acknowledged`)), 5000);
    sockets[who].emit(event, payload, (answer) => { clearTimeout(timer); resolve(answer); });
  });
  const history = async (who) => (await call('GET', `/servers/${serverId}/channels/${general}/messages`, undefined, tok[who])).data.messages;

  before(async () => {
    // CLIENT_ORIGIN names this instance, so a link to it is one the server must never fetch.
    server = await startServer({ env: { LINK_PREVIEWS: '1', LINK_PREVIEW_TRANSPORT: FAKE_TRANSPORT, CLIENT_ORIGIN: 'https://party.example.org' } });
    fs.writeFileSync(path.join(server.dataDir, 'link-web.json'), JSON.stringify(WEB));
    call = apiFor(server.base);
    tok = {};
    for (const name of ['alice', 'bob', 'carol', 'dave']) tok[name] = await makeUserFromOwnAddress(server.base, name);
    ids = Object.fromEntries((await dbAll(server.dataDir, 'SELECT id, username FROM users')).map((r) => [r.username, r.id]));
    serverId = (await call('POST', '/servers', { name: 'Links' }, tok.alice)).data.server.id;
    for (const username of ['bob', 'carol']) await call('POST', `/servers/${serverId}/invite`, { username }, tok.alice);
    general = (await dbAll(server.dataDir, "SELECT id FROM channels WHERE server_id = ? AND type = 'text'", [serverId]))[0].id;
    group = (await call('POST', '/groups', { name: 'Trio', members: ['bob', 'carol'] }, tok.alice)).data.group;
    for (const name of ['alice', 'bob', 'carol', 'dave']) {
      sockets[name] = await connect(server.base, tok[name]);
      if (name === 'dave') continue; // not a member
      const joined = once(sockets[name], 'channel:joined', (p) => p.serverId === serverId);
      sockets[name].emit('join', { serverId, name });
      await joined;
    }
  });
  after(async () => {
    for (const s of Object.values(sockets)) { try { s.close(); } catch (_) { /* already closed */ } }
    await server.stop();
  });

  test('a channel message is delivered at once, and its preview follows to everyone in the channel and into history', async () => {
    const text = `have you seen this? ${STORY}`;
    const previewFor = (who) => once(sockets[who], 'message:preview', (p) => p.preview && p.preview.url === STORY);
    const waiting = [previewFor('alice'), previewFor('bob'), previewFor('carol')];
    const message = await say('alice', text);
    assert.equal(message.preview, undefined, 'the message does not wait for the page');
    const events = await Promise.all(waiting);
    const preview = events[0].preview;
    for (const event of events) assert.deepEqual(event, { id: message.id, serverId, channelId: general, preview });
    assert.deepEqual({ ...preview, image: 'x' }, { url: STORY, title: 'Big news', description: 'It happened.', siteName: 'Example News', image: 'x' });
    assert.match(preview.image, /^\/link-previews\/[a-f0-9]{32}\.png$/);
    assert.ok(!JSON.stringify(preview).includes('cdn.example.net'), 'a reader is never sent to the site for the image');

    // In history too, for someone who opens the channel later.
    assert.deepEqual((await history('bob')).find((m) => m.id === message.id).preview, preview);
    assert.deepEqual((await dbAll(server.dataDir, 'SELECT preview_json FROM messages WHERE id = ?', [message.id])).map((r) => JSON.parse(r.preview_json)), [preview]);

    // What the server asked the "network" for: each name once, each from the address it resolved
    // to, on 443, with a generic User-Agent and nothing about alice.
    assert.deepEqual(lookedUp(), ['news.example.com', 'cdn.example.net']);
    const sent = asked().filter((e) => e.kind === 'request');
    assert.deepEqual(sent.map((e) => [e.url, e.address, e.port]), [[STORY, PUBLIC_A, 443], ['https://cdn.example.net/img/story.png', PUBLIC_B, 443]]);
    for (const req of sent) {
      assert.deepEqual(Object.keys(req.headers).map((h) => h.toLowerCase()).sort(), ['accept', 'accept-encoding', 'accept-language', 'connection', 'user-agent']);
      assert.equal(req.headers['User-Agent'], USER_AGENT);
      assert.ok(!JSON.stringify(req).includes('alice'));
    }
  });

  test('the image is served from this server, as an inert file', async () => {
    const preview = (await history('alice')).find((m) => m.preview).preview;
    const res = await fetch(server.base + preview.image);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox; frame-ancestors 'self' https://party.example.org");
    assert.match(res.headers.get('etag'), /^W\/"uf\d+-[0-9a-f]+-[0-9a-f]+"$/);
    assert.equal(res.headers.get('last-modified'), null);
    assert.equal(res.headers.get('content-disposition'), null, 'shown inline, as an image');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    // The validator works (asked with http.get: fetch adds `Cache-Control: no-cache` to a request
    // that sets If-None-Match itself), and a file that is not there is a plain 404, never the app's page.
    const revalidated = await new Promise((resolve, reject) => {
      http.get(server.base + preview.image, { headers: { 'If-None-Match': res.headers.get('etag') } }, (r) => { r.resume(); resolve(r); }).on('error', reject);
    });
    assert.equal(revalidated.statusCode, 304);
    for (const missing of [`/link-previews/${'0'.repeat(32)}.png`, '/link-previews/', '/link-previews/..%2Fdata.sqlite', '/link-previews/%2e%2e/data.sqlite']) {
      const gone = await fetch(server.base + missing);
      assert.equal(gone.status, 404, missing);
      assert.equal(await gone.text(), 'Not found');
    }
    assert.deepEqual(fs.readdirSync(path.join(server.dataDir, 'link-previews')), [path.basename(preview.image)]);
  });

  test('the same link posted again is not fetched again', async () => {
    const before = asked().length;
    const waiting = once(sockets.alice, 'message:preview', (p) => p.preview && p.preview.url === STORY);
    const message = await say('bob', `${STORY} again`);
    const event = await waiting;
    assert.equal(event.id, message.id);
    assert.equal(event.preview.title, 'Big news');
    assert.equal(asked().length, before, 'from the cache: nothing looked up, nothing requested');
  });

  test('a direct message gets its preview, on both sides and in the conversation', async () => {
    const forBob = once(sockets.bob, 'dm:message-preview');
    const forAlice = once(sockets.alice, 'dm:message-preview');
    let leaked = false;
    sockets.carol.on('dm:message-preview', () => { leaked = true; });
    const sent = await call('POST', '/messages/send', { toUsername: 'bob', text: `between us: ${POST}` }, tok.alice);
    assert.equal(sent.status, 200);
    assert.equal(sent.data.message.preview, undefined);
    const expected = { id: sent.data.message.id, preview: { url: POST, title: 'A post', description: 'Words about things.' } };
    assert.deepEqual(await forBob, expected);
    assert.deepEqual(await forAlice, expected);
    for (const who of ['alice', 'bob']) {
      const thread = await call('GET', `/messages/with/${who === 'alice' ? 'bob' : 'alice'}`, undefined, tok[who]);
      assert.deepEqual(thread.data.messages.find((m) => m.id === sent.data.message.id).preview, expected.preview);
    }
    await sleep(60);
    assert.equal(leaked, false, 'and nobody outside the conversation');
    sockets.carol.off('dm:message-preview');
  });

  test('a group message gets its preview, for every member and in the history', async () => {
    const waiting = ['alice', 'bob', 'carol'].map((who) => once(sockets[who], 'group:message-preview'));
    let leaked = false;
    sockets.dave.on('group:message-preview', () => { leaked = true; });
    const sent = await call('POST', `/groups/${group.id}/messages`, { text: `for the three of us ${POST}` }, tok.bob);
    assert.equal(sent.status, 200);
    const expected = { groupId: group.id, id: sent.data.message.id, preview: { url: POST, title: 'A post', description: 'Words about things.' } };
    for (const event of await Promise.all(waiting)) assert.deepEqual(event, expected);
    const page1 = await call('GET', `/groups/${group.id}/messages`, undefined, tok.carol);
    assert.deepEqual(page1.data.messages.find((m) => m.id === sent.data.message.id).preview, expected.preview);
    await sleep(60);
    assert.equal(leaked, false);
    sockets.dave.off('group:message-preview');
  });

  test('links the rules refuse get no preview, and the refused address is never contacted', async () => {
    const cases = [
      ['a name that resolves into the LAN', 'https://intranet.example.com/', ['intranet.example.com'], []],
      ['a name that resolves into the tailnet', 'https://tailnet.example.com/', ['tailnet.example.com'], []],
      ['a name with one private address among public ones', 'https://mixed.example.com/', ['mixed.example.com'], []],
      ['a redirect into the LAN', 'https://blog.example.org/hop', ['blog.example.org', 'intranet.example.com'], ['https://blog.example.org/hop']],
      ['an address', 'http://192.168.1.10:8080/servers', [], []],
      ['an address in decimal', 'http://2130706433/', [], []],
      ['localhost', 'http://localhost:3000/', [], []],
      ['a LAN name', 'http://nas.local/', [], []],
      ['another port', 'https://news.example.com:8443/story', [], []],
      ['credentials', 'https://admin:hunter2@news.example.com/story', [], []],
      ['this instance (CLIENT_ORIGIN)', 'https://party.example.org/app/', [], []],
      ['a media link, which is shown as media', 'https://cdn.example.net/img/story.png', [], []],
    ];
    for (const [label, url, lookups, requests] of cases) {
      const mark = asked().length;
      const quiet = never(sockets.bob, 'message:preview', () => true, 350);
      const message = await say('alice', `look: ${url}`);
      assert.equal(await quiet, true, `${label}: no preview arrived`);
      const since = asked().slice(mark);
      assert.deepEqual(since.filter((e) => e.kind === 'resolve').map((e) => e.hostname), lookups, label);
      assert.deepEqual(since.filter((e) => e.kind === 'request').map((e) => e.url), requests, label);
      assert.equal((await dbAll(server.dataDir, 'SELECT preview_json FROM messages WHERE id = ?', [message.id]))[0].preview_json, null, label);
    }
    for (const entry of asked().filter((e) => e.kind === 'request')) assert.equal(classifyAddress(entry.address).ok, true, `${entry.url} went to ${entry.address}`);
    assert.ok(!requested().some((url) => /intranet|tailnet|mixed|party\.example\.org/.test(url)));

    // An SVG "image" is left out; the card is still made.
    const waiting = once(sockets.bob, 'message:preview', (p) => p.preview && p.preview.url === 'https://blog.example.org/svg');
    await say('alice', 'https://blog.example.org/svg');
    assert.deepEqual((await waiting).preview, { url: 'https://blog.example.org/svg', title: 'Vector' });
    assert.equal(fs.readdirSync(path.join(server.dataDir, 'link-previews')).length, 1, 'no file was kept for it');
  });

  test('a message that is refused is never fetched for: it does not exist', async () => {
    const mark = asked().length;
    // dave is not a member of the server.
    const refusedOutsider = once(sockets.dave, 'message:error');
    sockets.dave.emit('message', { serverId, channelId: general, text: 'https://refused.example.com/a' });
    assert.equal((await refusedOutsider).reason, 'no-access');
    // carol is timed out.
    assert.equal((await call('POST', `/servers/${serverId}/timeouts/carol`, { minutes: 5 }, tok.alice)).status, 200);
    const refusedTimeout = once(sockets.carol, 'message:error');
    sockets.carol.emit('message', { serverId, channelId: general, text: 'https://refused.example.com/b' });
    assert.equal((await refusedTimeout).reason, 'timed-out');
    assert.equal((await call('DELETE', `/servers/${serverId}/timeouts/carol`, undefined, tok.alice)).status, 200);
    // dave shares nothing with alice, so he cannot message her; and he is not in the group.
    assert.equal((await call('POST', '/messages/send', { toUsername: 'alice', text: 'https://refused.example.com/c' }, tok.dave)).status, 403);
    assert.equal((await call('POST', `/groups/${group.id}/messages`, { text: 'https://refused.example.com/c' }, tok.dave)).status, 404);
    await sleep(250);
    assert.deepEqual(asked().slice(mark), [], 'nothing was looked up or requested for any of them');
    assert.equal((await dbAll(server.dataDir, "SELECT COUNT(*) AS n FROM messages WHERE text LIKE '%refused.example.com%'"))[0].n, 0);
  });

  test('editing a message only re-fetches when its link changed', async () => {
    const first = once(sockets.bob, 'message:preview', (p) => p.preview && p.preview.url === POST);
    const message = await say('alice', `reading ${POST}`);
    await first;

    // Same link, different words: no event, nothing fetched.
    let mark = asked().length;
    let quiet = never(sockets.bob, 'message:preview', (p) => p.id === message.id, 350);
    assert.deepEqual((await emitAck('alice', 'message:edit', { id: message.id, text: `still reading ${POST} (slowly)` })).ok, true);
    assert.equal(await quiet, true);
    assert.equal(asked().length, mark);
    assert.equal((await history('bob')).find((m) => m.id === message.id).preview.title, 'A post');

    // A different link: the old card comes off, then the new one arrives.
    const events = [];
    const collect = (p) => { if (p.id === message.id) events.push(p.preview); };
    sockets.bob.on('message:preview', collect);
    assert.equal((await emitAck('alice', 'message:edit', { id: message.id, text: 'no wait, https://blog.example.org/second' })).ok, true);
    await waitFor(() => events.length === 2, 'the old card to come off and the new one to arrive');
    assert.deepEqual(events, [null, { url: 'https://blog.example.org/second', title: 'Second post' }]);
    assert.deepEqual(requested().slice(-1), ['https://blog.example.org/second']);

    // The link goes: the card goes, and nothing is fetched.
    mark = asked().length;
    assert.equal((await emitAck('alice', 'message:edit', { id: message.id, text: 'never mind' })).ok, true);
    await waitFor(() => events.length === 3, 'the card to come off');
    await sleep(100);
    assert.deepEqual(events.slice(2), [null]);
    assert.equal(asked().length, mark);
    assert.equal((await history('bob')).find((m) => m.id === message.id).preview, undefined);
    sockets.bob.off('message:preview', collect);
    quiet = null;
  });

  test('only the author can remove a preview, and it then goes for everyone and stays gone', async () => {
    // --- channel ---
    const attached = once(sockets.bob, 'message:preview', (p) => p.preview && p.preview.url === STORY);
    const message = await say('alice', `removable ${STORY}`);
    await attached;
    assert.deepEqual(await emitAck('bob', 'message:preview-remove', { id: message.id }), { ok: false, error: 'not-author' });
    assert.deepEqual(await emitAck('bob', 'message:preview-remove', { id: 99999999 }), { ok: false, error: 'not-found' });
    assert.deepEqual(await emitAck('bob', 'message:preview-remove', {}), { ok: false, error: 'bad-request' });
    assert.equal((await history('carol')).find((m) => m.id === message.id).preview.title, 'Big news', 'still there');

    const removed = ['alice', 'bob', 'carol'].map((who) => once(sockets[who], 'message:preview', (p) => p.id === message.id && p.preview === null));
    assert.deepEqual(await emitAck('alice', 'message:preview-remove', { id: message.id }), { ok: true });
    for (const event of await Promise.all(removed)) assert.deepEqual(event, { id: message.id, serverId, channelId: general, preview: null });
    assert.equal((await history('carol')).find((m) => m.id === message.id).preview, undefined);
    // Again: nothing to remove, nothing announced.
    const quiet = never(sockets.bob, 'message:preview', (p) => p.id === message.id, 300);
    assert.deepEqual(await emitAck('alice', 'message:preview-remove', { id: message.id }), { ok: true });
    assert.equal(await quiet, true);
    // An edit that keeps the link does not bring it back, and fetches nothing.
    const mark = asked().length;
    assert.equal((await emitAck('alice', 'message:edit', { id: message.id, text: `removable ${STORY}, edited` })).ok, true);
    await sleep(200);
    assert.equal((await history('carol')).find((m) => m.id === message.id).preview, undefined);
    assert.equal(asked().length, mark);

    // --- direct message ---
    const dmAttached = once(sockets.bob, 'dm:message-preview', (p) => p.preview);
    const dm = (await call('POST', '/messages/send', { toUsername: 'bob', text: `dm ${STORY}` }, tok.alice)).data.message;
    await dmAttached;
    assert.equal((await call('DELETE', `/messages/${dm.id}/preview`, undefined, tok.bob)).status, 403, 'the recipient cannot');
    assert.equal((await call('DELETE', `/messages/${dm.id}/preview`, undefined, tok.carol)).status, 403, 'nor can a bystander');
    assert.equal((await call('DELETE', `/messages/${dm.id}/preview`)).status, 401);
    assert.equal((await call('DELETE', '/messages/99999999/preview', undefined, tok.alice)).status, 404);
    const dmRemoved = [once(sockets.alice, 'dm:message-preview', (p) => p.id === dm.id && p.preview === null), once(sockets.bob, 'dm:message-preview', (p) => p.id === dm.id && p.preview === null)];
    assert.equal((await call('DELETE', `/messages/${dm.id}/preview`, undefined, tok.alice)).status, 200);
    await Promise.all(dmRemoved);
    assert.equal((await call('GET', '/messages/with/alice', undefined, tok.bob)).data.messages.find((m) => m.id === dm.id).preview, undefined);

    // --- group message ---
    const groupAttached = once(sockets.carol, 'group:message-preview', (p) => p.preview);
    const gm = (await call('POST', `/groups/${group.id}/messages`, { text: `group ${STORY}` }, tok.alice)).data.message;
    await groupAttached;
    assert.equal((await call('DELETE', `/groups/${group.id}/messages/${gm.id}/preview`, undefined, tok.bob)).status, 403, 'another member cannot');
    assert.equal((await call('DELETE', `/groups/${group.id}/messages/${gm.id}/preview`, undefined, tok.dave)).status, 404, 'an outsider is told there is no such group');
    const groupRemoved = ['alice', 'bob', 'carol'].map((who) => once(sockets[who], 'group:message-preview', (p) => p.id === gm.id && p.preview === null));
    assert.equal((await call('DELETE', `/groups/${group.id}/messages/${gm.id}/preview`, undefined, tok.alice)).status, 200);
    for (const event of await Promise.all(groupRemoved)) assert.deepEqual(event, { groupId: group.id, id: gm.id, preview: null });
    assert.equal((await call('GET', `/groups/${group.id}/messages`, undefined, tok.bob)).data.messages.find((m) => m.id === gm.id).preview, undefined);
  });

  test('a preview on a message from someone the reader blocked still travels with it, marked for the client to collapse', async () => {
    // The card is part of the message: the client does not mount a blocked message at all until
    // "Show" is pressed, and that hides its preview with it (BlockedMessage.tsx).
    assert.equal((await call('POST', '/blocks/alice', {}, tok.carol)).status, 200);
    const mine = (await history('carol')).filter((m) => m.author === 'alice' && m.preview);
    assert.ok(mine.length > 0);
    assert.ok(mine.every((m) => m.blocked === true));
    assert.equal((await call('DELETE', '/blocks/alice', undefined, tok.carol)).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------
describe('link previews: switched off on a real server', () => {
  const WEB = {
    hosts: { 'news.example.com': [PUBLIC_A] },
    pages: { 'https://news.example.com/story': { headers: { 'content-type': 'text/html' }, body: page('<title>Big news</title>') } },
  };

  async function postAndWait(env, { expectPreview = false } = {}) {
    const server = await startServer({ env });
    try {
      fs.writeFileSync(path.join(server.dataDir, 'link-web.json'), JSON.stringify(WEB));
      const call = apiFor(server.base);
      const alice = await makeUserFromOwnAddress(server.base, 'alice');
      const bob = await makeUserFromOwnAddress(server.base, 'bob');
      const serverId = (await call('POST', '/servers', { name: 'Off' }, alice)).data.server.id;
      await call('POST', `/servers/${serverId}/invite`, { username: 'bob' }, alice);
      const sent = await call('POST', '/messages/send', { toUsername: 'bob', text: 'https://news.example.com/story' }, alice);
      assert.equal(sent.status, 200, 'messages are sent exactly as before');
      const preview = async () => (await call('GET', '/messages/with/alice', undefined, bob)).data.messages[0].preview;
      // Where a preview is expected, wait for it; where none is, give one every chance to turn up.
      if (expectPreview) await waitFor(preview, 'the preview to be attached');
      else await sleep(400);
      const log = path.join(server.dataDir, 'link-requests.jsonl');
      return { asked: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', preview: await preview(), output: server.log(), cached: await dbAll(server.dataDir, 'SELECT COUNT(*) AS n FROM link_previews') };
    } finally {
      await server.stop();
    }
  }

  test('LINK_PREVIEWS=0: a link is sent as text and nothing is fetched', async () => {
    const off = await postAndWait({ LINK_PREVIEWS: '0', LINK_PREVIEW_TRANSPORT: FAKE_TRANSPORT });
    assert.equal(off.asked, '', 'no lookup, no request');
    assert.equal(off.preview, undefined);
    assert.equal(off.cached[0].n, 0);
    assert.match(off.output, /\[link-preview\] LINK_PREVIEWS=0: link previews are off/);
  });

  test('a stand-in network that cannot be loaded leaves previews off', async () => {
    const broken = await postAndWait({ LINK_PREVIEWS: '1', LINK_PREVIEW_TRANSPORT: path.join(__dirname, 'fixtures', 'no-such-transport.js') });
    assert.equal(broken.asked, '');
    assert.equal(broken.preview, undefined);
    assert.match(broken.output, /LINK_PREVIEW_TRANSPORT could not be loaded: link previews are off/);
  });

  test('with it on (and the stand-in in place) the same message does get its preview', async () => {
    const on = await postAndWait({ LINK_PREVIEWS: '1', LINK_PREVIEW_TRANSPORT: FAKE_TRANSPORT }, { expectPreview: true });
    assert.deepEqual(on.preview, { url: 'https://news.example.com/story', title: 'Big news' });
    assert.equal(on.asked.split('\n').filter(Boolean).length, 2, 'one lookup and one request');
  });
});
