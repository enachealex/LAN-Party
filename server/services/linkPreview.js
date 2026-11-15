// @ts-check
// Link previews: when a message carries a link, fetch that page once and attach a small card to the
// message (title, description, site name, image).
//
// This is the one place where the server makes a request to an address a MEMBER chose, and the
// server sits on a home network next to other private services (a NAS, a router's admin page, the
// tailnet, its own loopback ports). So every rule below exists to make sure the only thing that can
// ever be fetched is a public web page, and that nothing about the fetch says who asked for it.
// Where a rule had two readings, the one that fetches less was taken.
//
//   the URL       http: or https: only, on the scheme's own default port, with no user:password,
//                 and no longer than MAX_URL_LENGTH (checkUrl).
//   the name      a real multi-label DNS name. Never an IP address in any spelling (the URL parser
//                 turns 2130706433, 0x7f.1, 0177.0.0.1 and 127.1 into 127.0.0.1 before this code
//                 sees them, and every literal is refused, public ones too), never localhost or a
//                 name under .local/.internal/.lan and their kin, never a single-label name, and
//                 never a name this server is itself reached by (checkHostname).
//   the address   the name is resolved HERE, and if ANY address it resolves to is not public
//                 unicast the fetch is refused: loopback, private, link-local, CGNAT (which is the
//                 tailnet), multicast, broadcast, unspecified, reserved and documentation ranges,
//                 and for IPv6 everything outside global unicast (so also unique-local, link-local,
//                 IPv4-mapped and IPv4-compatible forms, NAT64, 6to4 and Teredo) (classifyAddress).
//   the pin       the connection is then made TO THE ADDRESS THAT WAS CHECKED. The HTTP client is
//                 handed the address, not the name, so it never resolves anything itself and a
//                 name that answers differently a moment later (DNS rebinding) changes nothing.
//                 The name only travels as the Host header and the TLS server name (pinnedRequest).
//   redirects     at most MAX_REDIRECTS, and every hop goes through all of the above again. A
//                 redirect to something refused ends the fetch.
//   limits        one deadline for the whole fetch (FETCH_TIMEOUT_MS), a page is read up to
//                 MAX_HTML_BYTES and no further, only text/html and application/xhtml+xml are
//                 parsed, at most MAX_CONCURRENT fetches run at once (a short queue behind them),
//                 each person may cause USER_FETCHES_PER_WINDOW fetches a minute, and the answer
//                 for a URL is cached (OK_TTL_MS, or FAIL_TTL_MS when nothing came of it), so one
//                 link is fetched once however many times it is posted.
//   anonymity     a fixed generic User-Agent, no cookies (none sent, none kept), no Referer, and
//                 nothing derived from the person who posted the link.
//   the page      is hostile input. There is no HTML parser here; the capped text is scanned with
//                 bounded, linear string work (no pattern that can backtrack over the document),
//                 every field is length-capped, control characters are stripped, and the result is
//                 plain text that the client renders as text.
//   the image     is fetched by the same rules, must be a PNG, JPEG, GIF or WebP by declared type
//                 AND by its leading bytes (so never an SVG), is at most MAX_IMAGE_BYTES, and is
//                 stored under DATA_DIR/link-previews by content hash. Readers load it from this
//                 server (routed through userFileStatic), never from the site: loading it from the
//                 site would hand every reader's address to whoever posted the link.
//
//   oEmbed        some sites put what a preview needs so deep in a huge page that the cap above
//                 cuts it off (a YouTube watch page is ~1.5 MB with its title ~850 KB in). For a
//                 link one of OEMBED_PROVIDERS recognises, the page is not fetched at all: the
//                 provider's small oEmbed JSON is, through the very same fetcher and rules. Its
//                 fields are cleaned like a page's, and the picture it names is just another image
//                 URL to be checked and fetched like any other. Nothing in the JSON is trusted.
//
// LINK_PREVIEWS=0 turns all fetching off. Previews already stored stay on their messages.
//
// Config (env):
//   LINK_PREVIEWS             '0' (or 'false' / 'off') disables fetching
//   LINK_PREVIEW_DEBUG        set to anything to log why a link got no preview, or a preview no
//                             image: the host name and a short reason code, nothing else
//   LINK_PREVIEW_TRANSPORT    test seam: a module exporting { resolve, request } to use in place
//                             of DNS and HTTP. If it is set and cannot be loaded, previews are OFF:
//                             a test that meant to fake the network must never reach the real one.

const crypto = require('crypto');
const dns = require('dns');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const { ownHostKeys } = require('./hostedApps');

/**
 * @typedef {import('../db/migrate').Db} Db
 * @typedef {{ address: string, family: number }} ResolvedAddress
 * @typedef {(hostname: string) => Promise<ResolvedAddress[]>} Resolver
 * @typedef {{
 *   protocol: 'http:' | 'https:', hostname: string, address: string, family: number, port: number,
 *   path: string, headers: Record<string, string>, signal?: AbortSignal,
 * }} PinnedRequest
 * @typedef {{
 *   status: number,
 *   headers: Record<string, string | string[] | undefined>,
 *   body: AsyncIterable<Uint8Array>,
 *   destroy: () => void,
 * }} PinnedResponse
 * @typedef {(request: PinnedRequest) => Promise<PinnedResponse>} Requester
 * @typedef {{ url: string, title?: string, description?: string, siteName?: string, image?: string }} Preview
 * @typedef {'messages' | 'direct_messages' | 'group_messages'} MessageTable
 */

const MAX_URL_LENGTH = 2048;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT = 4;
// Jobs waiting for one of those slots. Beyond this a link simply gets no preview: a burst of links
// must not pile up work behind a slow site.
const MAX_QUEUED = 20;
const USER_FETCHES_PER_WINDOW = 10;
const USER_WINDOW_MS = 60_000;
const OK_TTL_MS = 24 * 60 * 60 * 1000;
const FAIL_TTL_MS = 60 * 60 * 1000;
// An image file is kept while any stored preview still shows it, and for this long regardless.
const IMAGE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// All the preview images together. At 2 MB each this is hundreds of cards' worth; the point is that
// the folder cannot be grown without limit by posting links (it shares a volume with the database).
const MAX_IMAGE_STORE_BYTES = 512 * 1024 * 1024;
// DNS answers per name. A real site has a handful; a name with more is not one to trust.
const MAX_ADDRESSES = 16;
// Addresses tried per hop. Every one was checked; the second is only for a first that is down.
const MAX_CONNECT_ATTEMPTS = 2;
// Links looked at per message when choosing the one to preview.
const MAX_LINKS_CONSIDERED = 10;

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 400;
const SITE_NAME_MAX = 80;
const MAX_META_TAGS = 300;
const MAX_TAG_LENGTH = 4096;
const MAX_ATTRIBUTES = 32;

// Says nothing about LAN Party, this instance, or the person who posted the link.
const USER_AGENT = 'Mozilla/5.0 (compatible; LinkPreview/1.0)';
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
// Raster only. image/svg+xml is a document that can carry script, and is not on this list.
// ('image/jpg' is not a registered type, but it is what a fair number of servers call a JPEG; the
// bytes are checked either way.)
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp']);
// An oEmbed answer. A few hundred bytes in practice; anything near this cap is not one.
const JSON_TYPES = new Set(['application/json']);
const MAX_JSON_BYTES = 64 * 1024;
const AUTHOR_MAX = 100;

// What each kind of fetch accepts, how much of it is read, and what happens past that: a page is
// cut off there and read as far as it went; an image or a JSON document cut short is useless, so
// it is refused (and refused up front when it declares itself too big).
const KINDS = /** @type {const} */ ({
  html: { types: HTML_TYPES, cap: MAX_HTML_BYTES, truncate: true, accept: 'text/html,application/xhtml+xml' },
  image: { types: IMAGE_TYPES, cap: MAX_IMAGE_BYTES, truncate: false, accept: 'image/png,image/jpeg,image/gif,image/webp' },
  json: { types: JSON_TYPES, cap: MAX_JSON_BYTES, truncate: false, accept: 'application/json' },
});

// --- oEmbed providers ---
// One entry per site whose links are previewed from its oEmbed endpoint instead of its page.
// `match` is handed the link (already through checkUrl) and answers:
//   null                   not one of this provider's links: the next provider, then the page
//   { oembed: null }       one of its links, but malformed (a video id that cannot be one): there
//                          is nothing to preview, and the page is not fetched instead
//   { oembed: '<url>' }    fetch this. Built here from validated pieces only; it then goes through
//                          every rule like any other URL.
// `siteName` is ours, not the JSON's: the card says "YouTube" because the link is to YouTube.
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com']);
/** @type {Array<{ siteName: string, match: (url: URL) => { oembed: string | null } | null }>} */
const OEMBED_PROVIDERS = [
  {
    siteName: 'YouTube',
    match(url) {
      /** @type {string | null | undefined} */
      let id;
      if (url.hostname === 'youtu.be') {
        id = url.pathname.slice(1);
        if (!id) return null; // the bare domain
      } else if (YOUTUBE_HOSTS.has(url.hostname)) {
        if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
        // One trailing slash is how some share links are written; anything more is not an id.
        else if (url.pathname.startsWith('/shorts/')) id = url.pathname.slice('/shorts/'.length).replace(/\/$/, '');
        else return null; // a channel, a playlist, the front page: an ordinary page
      } else {
        return null;
      }
      if (!YOUTUBE_ID.test(id || '')) return { oembed: null };
      // Always asked about the canonical watch address, whatever shape the link had: the id is
      // the only thing taken from it.
      const watch = `https://www.youtube.com/watch?v=${id}`;
      return { oembed: `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json` };
    },
  },
];

/**
 * Which provider's oEmbed endpoint stands in for this link's page, if any.
 * @param {string} href a link that has passed checkUrl
 * @returns {{ siteName: string, oembed: string | null } | null}
 */
function oembedFor(href) {
  /** @type {URL} */
  let url;
  try { url = new URL(href); } catch (_) { return null; }
  for (const provider of OEMBED_PROVIDERS) {
    const found = provider.match(url);
    if (found) return { siteName: provider.siteName, oembed: found.oembed };
  }
  return null;
}
const IMAGE_EXTENSIONS = /** @type {Record<string, string>} */ ({ png: '.png', jpeg: '.jpg', gif: '.gif', webp: '.webp' });
const IMAGE_URL_PREFIX = '/link-previews/';
const STORED_IMAGE = /^\/link-previews\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const IMAGE_DIR = 'link-previews';

// Names that are never on the public web, whatever they resolve to. The address check below would
// catch what they point at; refusing the name first means not even a DNS query is made for them.
const INTERNAL_SUFFIXES = new Set([
  'localhost', 'local', 'internal', 'lan', 'home', 'arpa', 'test', 'invalid', 'localdomain', 'corp', 'intranet', 'private', 'onion',
]);

// What the client shows inline as media when it ends a line (isMediaAttachment in
// client/src/App.jsx): such a link is already on screen as the thing itself and gets no card.
const MEDIA_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff', 'gif',
  'mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v', 'mkv',
]);

/** A fetch that was turned down, with the short code that says why (tests and logs read it). */
class Refusal extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`link preview refused: ${reason}`);
    this.name = 'Refusal';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------
// Addresses

/** @param {string} address @returns {number[] | null} the four octets of a dotted-decimal address */
function ipv4Octets(address) {
  if (!net.isIPv4(address)) return null;
  return address.split('.').map(Number);
}

/** @param {string} address @returns {Uint8Array | null} the sixteen bytes of an IPv6 address */
function ipv6Bytes(address) {
  // A zone id ("fe80::1%eth0") only ever belongs to a link-local address: refused outright.
  if (!net.isIPv6(address) || address.includes('%')) return null;
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    // The dotted form of the last 32 bits ("::ffff:10.0.0.1"): rewritten as two hex groups.
    const v4 = ipv4Octets(tail);
    if (!v4) return null;
    text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : null;
  const missing = 8 - head.length - (rest ? rest.length : 0);
  if (rest ? missing < 0 : missing !== 0) return null;
  const groups = rest ? [...head, ...new Array(missing).fill('0'), ...rest] : head;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const value = parseInt(groups[i], 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

/** @param {number[]} o @returns {string | null} why this IPv4 address is not public, or null if it is */
function ipv4Problem([a, b, c, d]) {
  if (a === 0) return 'unspecified';                          // 0.0.0.0/8, "this network"
  if (a === 10) return 'private';                             // 10/8
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';       // 100.64/10: carrier NAT, and Tailscale
  if (a === 127) return 'loopback';                           // 127/8
  if (a === 169 && b === 254) return 'link-local';            // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return 'private';      // 172.16/12
  if (a === 192 && b === 168) return 'private';               // 192.168/16
  if (a === 192 && b === 0 && c === 0) return 'reserved';     // 192.0.0.0/24, protocol assignments
  if (a === 192 && b === 0 && c === 2) return 'reserved';     // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'reserved';   // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 198.18/15, benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved';  // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved';   // TEST-NET-3
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'broadcast';
  if (a >= 224 && a <= 239) return 'multicast';               // 224/4
  if (a >= 240) return 'reserved';                            // 240/4
  return null;
}

/** @param {Uint8Array} b @returns {string | null} why this IPv6 address is not public, or null if it is */
function ipv6Problem(b) {
  const zeroUntil = (/** @type {number} */ n) => b.subarray(0, n).every((byte) => byte === 0);
  if (zeroUntil(16)) return 'unspecified';                                  // ::
  if (zeroUntil(15) && b[15] === 1) return 'loopback';                      // ::1
  if (zeroUntil(10) && b[10] === 0xff && b[11] === 0xff) return 'mapped';   // ::ffff:a.b.c.d
  if (zeroUntil(12)) return 'compatible';                                   // ::a.b.c.d (deprecated)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return 'nat64'; // 64:ff9b::/96 and 64:ff9b:1::/48
  if ((b[0] & 0xfe) === 0xfc) return 'unique-local';                        // fc00::/7
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local';         // fe80::/10
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return 'site-local';         // fec0::/10 (deprecated)
  if (b[0] === 0xff) return 'multicast';                                    // ff00::/8
  // Everything public is in 2000::/3. Whatever else is left outside it is unassigned or special.
  if ((b[0] & 0xe0) !== 0x20) return 'reserved';
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] <= 0x01) return 'reserved';    // 2001::/23: Teredo, ORCHID, benchmarking
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'reserved'; // 2001:db8::/32, documentation
  if (b[0] === 0x20 && b[1] === 0x02) return 'reserved';                    // 2002::/16, 6to4 (wraps an IPv4 address)
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0) return 'reserved'; // 3fff::/20, documentation
  return null;
}

/**
 * Is this address one a public web page can be on? Anything that is not plainly a public unicast
 * address is refused, including anything that does not parse as an address at all.
 * @param {unknown} address
 * @returns {{ ok: true, family: 4 | 6 } | { ok: false, reason: string }}
 */
function classifyAddress(address) {
  if (typeof address !== 'string') return { ok: false, reason: 'not-an-address' };
  const v4 = ipv4Octets(address);
  if (v4) {
    const problem = ipv4Problem(v4);
    return problem ? { ok: false, reason: problem } : { ok: true, family: 4 };
  }
  const v6 = ipv6Bytes(address);
  if (v6) {
    const problem = ipv6Problem(v6);
    return problem ? { ok: false, reason: problem } : { ok: true, family: 6 };
  }
  return { ok: false, reason: 'not-an-address' };
}

// ---------------------------------------------------------------------------------------------
// URLs and names

/**
 * The names this server is reached by, from where one request (or socket handshake) stands, plus
 * the configured origins: a link to LAN Party itself is never fetched.
 * @param {Record<string, any> | undefined} headers lower-cased, as Node hands them over
 * @param {string[]} [configuredOrigins]
 * @returns {Set<string>} bare host names
 */
function ownHostnames(headers, configuredOrigins = []) {
  /** @type {Set<string>} */
  const names = new Set();
  // ownHostKeys answers "host:port"; the port is not part of the question here. Anything that is
  // not shaped like a host name ('*', a stray word) is left out: it could never match one.
  for (const key of ownHostKeys(headers, configuredOrigins)) {
    const name = key.slice(0, key.lastIndexOf(':'));
    if (/^[a-z0-9.-]+$/.test(name)) names.add(name);
  }
  return names;
}

/**
 * @param {string} rawHost a URL's hostname, as the URL parser spells it
 * @param {Set<string>} [ownHosts]
 * @returns {{ ok: true, host: string } | { ok: false, reason: string }}
 */
function checkHostname(rawHost, ownHosts = new Set()) {
  const no = (/** @type {string} */ reason) => ({ ok: /** @type {const} */ (false), reason });
  // "example.com." is the same machine as "example.com": the dot must not be a way round a rule.
  const host = String(rawHost || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return no('no-host');
  if (host.length > MAX_HOSTNAME_LENGTH) return no('host-too-long');
  // The URL parser has already turned every spelling of an IPv4 address (decimal, hex, octal,
  // shortened, percent-encoded) into dotted decimal, and brackets an IPv6 one.
  if (host.startsWith('[') || net.isIP(host)) return no('ip-literal');
  const labels = host.split('.');
  if (labels.some((label) => !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return no('bad-host');
  if (labels.length < 2) return no('single-label');
  const last = labels[labels.length - 1];
  // No real top-level domain is a number; a name that ends in one is an address in disguise.
  if (/^\d+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return no('ip-literal');
  if (INTERNAL_SUFFIXES.has(last)) return no('internal-name');
  if (ownHosts.has(host)) return no('own-host');
  return { ok: true, host };
}

/**
 * Everything that can be said about a URL without touching the network.
 * @param {unknown} raw
 * @param {Set<string>} [ownHosts]
 * @returns {{ ok: true, url: URL, href: string, host: string, hash: string } | { ok: false, reason: string }}
 *   `href` is what is fetched and what the cache is keyed by; `hash` is the fragment that was left
 *   off it ('' or '#…'), which only matters to whoever follows the link afterwards.
 */
function checkUrl(raw, ownHosts = new Set()) {
  const no = (/** @type {string} */ reason) => ({ ok: /** @type {const} */ (false), reason });
  if (typeof raw !== 'string' || !raw) return no('bad-url');
  if (raw.length > MAX_URL_LENGTH) return no('url-too-long');
  /** @type {URL} */
  let url;
  try { url = new URL(raw); } catch (_) { return no('bad-url'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return no('scheme');
  if (url.username || url.password) return no('credentials');
  // The parser drops a scheme's own default port, so anything left here is some other port:
  // :8080, :22, and also https on :80 or http on :443.
  if (url.port !== '') return no('port');
  const name = checkHostname(url.hostname, ownHosts);
  if (!name.ok) return name;
  const hash = url.hash;
  url.hash = ''; // never sent, and not part of which page this is
  url.hostname = name.host;
  if (url.href.length + hash.length > MAX_URL_LENGTH) return no('url-too-long');
  return { ok: true, url, href: url.href, host: name.host, hash };
}

/** @param {string} token @returns {boolean} does this url end in a media file's extension? */
function isMediaUrl(token) {
  let name = token;
  if (/^https?:\/\//i.test(token)) {
    try { name = new URL(token).pathname; } catch (_) { return false; }
  } else {
    name = token.split(/[?#]/)[0];
  }
  const match = /\.([a-z0-9]+)$/i.exec(name.split('/').pop() || '');
  return !!match && MEDIA_EXTENSIONS.has(match[1].toLowerCase());
}

/**
 * The link of a message that gets the preview: the first http(s) link that is not already shown as
 * media and that passes the URL rules, or null. Follows the client's reading of a message
 * (messageBlocks and renderMessageText in client/src/App.jsx): a line whose last token is a media
 * url shows that media; every other url is a link.
 * @param {unknown} text
 * @param {unknown} [attachment] a message with an attachment shows the attachment, not its text
 * @param {Set<string>} [ownHosts]
 * @returns {{ href: string, shown: string } | null} `href` is the page to fetch (normalised, no
 *   fragment); `shown` is the same with the fragment the author wrote, which is where the card links.
 */
function findPreviewLink(text, attachment = null, ownHosts = new Set()) {
  if (attachment || typeof text !== 'string' || !text) return null;
  let considered = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const lastToken = /** @type {string} */ (line.split(/\s+/).pop());
    const mediaAt = /^(https?:\/\/|\/)\S+$/i.test(lastToken) && isMediaUrl(lastToken) ? line.length - lastToken.length : -1;
    for (const match of line.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
      if (considered >= MAX_LINKS_CONSIDERED) return null;
      considered += 1;
      if (match.index === mediaAt) continue; // shown as media already
      // Far too long to be fetched: passed over before any more work is done on it. (A message can
      // be a megabyte, and nothing below should ever be run over that much.)
      if (match[0].length > MAX_URL_LENGTH + 64) continue;
      // Trailing punctuation is the sentence's, not the link's. Walked from the end rather than
      // matched with a pattern, which would retry from every position of a long run.
      let end = match[0].length;
      while (end > 0 && '.,;:!?)]}'.includes(match[0][end - 1])) end -= 1;
      const url = match[0].slice(0, end);
      if (isMediaUrl(url)) continue; // a media file mid-sentence is still not a page
      const checked = checkUrl(url, ownHosts);
      if (checked.ok) return { href: checked.href, shown: `${checked.href}${checked.hash}` };
    }
  }
  return null;
}

/**
 * The page a message's preview is of: findPreviewLink's `href`, or null.
 * @param {unknown} text @param {unknown} [attachment] @param {Set<string>} [ownHosts]
 * @returns {string | null}
 */
function previewLinkOf(text, attachment = null, ownHosts = new Set()) {
  const found = findPreviewLink(text, attachment, ownHosts);
  return found ? found.href : null;
}

// ---------------------------------------------------------------------------------------------
// The real network: used only when nothing was injected

/** @type {Resolver} */
const systemResolve = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * One GET to `address`, which is the address that was checked. The HTTP client is given that
 * address as its host, so it has no name to resolve; `lookup` is there only so that if it ever
 * did ask, it would be handed the same address and nothing else. The name appears in exactly two
 * places: the Host header and, for https, the TLS server name (which is also what the certificate
 * is checked against). No agent: one connection per request, never kept or reused.
 * @type {Requester}
 */
function pinnedRequest({ protocol, hostname, address, family, port, path: requestPath, headers, signal }) {
  return new Promise((resolve, reject) => {
    const client = protocol === 'https:' ? https : http;
    /** @type {any} */
    const options = {
      host: address,
      family,
      port,
      path: requestPath,
      method: 'GET',
      headers: { ...headers, Host: hostname },
      agent: false,
      lookup: (/** @type {string} */ _name, /** @type {any} */ opts, /** @type {Function} */ done) => {
        if (opts && opts.all) done(null, [{ address, family }]);
        else done(null, address, family);
      },
      signal,
    };
    if (protocol === 'https:') options.servername = hostname;
    const req = client.request(options, (res) => {
      resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: res,
        destroy: () => { res.destroy(); req.destroy(); },
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
// Reading a hostile page

/** @param {string} ch */
const isSpace = (ch) => ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f';

/**
 * Where a tag that starts at `from` ends: its '>' outside any quoted value. -1 if it does not
 * end within MAX_TAG_LENGTH (not a tag worth reading, and never scanned further than that).
 * @param {string} html @param {number} from
 */
function tagEnd(html, from) {
  let quote = '';
  const limit = Math.min(html.length, from + MAX_TAG_LENGTH);
  for (let i = from; i < limit; i += 1) {
    const ch = html[i];
    if (quote) { if (ch === quote) quote = ''; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return i;
  }
  return -1;
}

/**
 * The attributes of one tag, names lower-cased, the first of each name winning. Written as a
 * single forward pass: a pattern for this would backtrack on a tag built to make it.
 * @param {string} tag the text between the tag name and its '>'
 * @returns {Record<string, string>}
 */
function parseAttributes(tag) {
  /** @type {Record<string, string>} */
  const attrs = Object.create(null);
  const n = tag.length;
  let i = 0;
  let count = 0;
  while (i < n && count < MAX_ATTRIBUTES) {
    while (i < n && (isSpace(tag[i]) || tag[i] === '/')) i += 1;
    let start = i;
    while (i < n && !isSpace(tag[i]) && tag[i] !== '=' && tag[i] !== '/') i += 1;
    const name = tag.slice(start, i).toLowerCase();
    while (i < n && isSpace(tag[i])) i += 1;
    let value = '';
    if (tag[i] === '=') {
      i += 1;
      while (i < n && isSpace(tag[i])) i += 1;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, i + 1);
        const stop = close === -1 ? n : close;
        value = tag.slice(i + 1, stop);
        i = stop + 1;
      } else {
        start = i;
        while (i < n && !isSpace(tag[i])) i += 1;
        value = tag.slice(start, i);
      }
    } else if (!name) {
      i += 1; // nothing was read: step on, so the loop always ends
    }
    if (name) {
      count += 1;
      if (!(name in attrs)) attrs[name] = value;
    }
  }
  return attrs;
}

const NAMED_ENTITIES = /** @type {Record<string, string>} */ ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
});

/** @param {string} text */
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body) => {
    if (body[0] !== '#') return Object.hasOwn(NAMED_ENTITIES, body.toLowerCase()) ? NAMED_ENTITIES[body.toLowerCase()] : whole;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  });
}

/**
 * One field of a preview as plain text: entities decoded (once), control and direction-override
 * characters removed, whitespace collapsed, and cut to `max` code points.
 * @param {unknown} raw @param {number} max
 * @returns {string}
 */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  // Bounded before any work is done on it: nothing downstream is ever handed a megabyte.
  const decoded = decodeEntities(raw.slice(0, max * 8));
  const flat = decoded
    // C0 and C1 controls become spaces; zero-width and bidi-override characters (which can make
    // text read as something it is not) are dropped.
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[​-‏‪-‮⁠-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

const WANTED_META = new Set([
  'og:title', 'og:description', 'og:site_name', 'og:image', 'og:image:url', 'og:image:secure_url',
  'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:src', 'description',
]);

/**
 * What a page says about itself: Open Graph, then Twitter card, then <title> and the meta
 * description. `image` is the page's own (unchecked) address for it, to be fetched by the same
 * rules as the page. Never throws, whatever it is given.
 * @param {string} html already capped
 * @returns {{ title: string, description: string, siteName: string, image: string }}
 */
function extractMetadata(html) {
  /** @type {Map<string, string>} */
  const meta = new Map();
  const finder = /<meta[\s/]/gi;
  let seen = 0;
  let match;
  while (seen < MAX_META_TAGS && (match = finder.exec(html)) !== null) {
    seen += 1;
    const start = match.index + 5;
    const end = tagEnd(html, start);
    if (end === -1) continue; // lastIndex is already past this '<meta'
    finder.lastIndex = end + 1;
    const attrs = parseAttributes(html.slice(start, end));
    const key = String(attrs.property || attrs.name || '').trim().toLowerCase();
    if (!WANTED_META.has(key) || meta.has(key) || !attrs.content) continue;
    meta.set(key, attrs.content);
  }
  // The quantifiers are bounded so that a page of unclosed "<title" cannot make this rescan itself.
  const titleTag = /<title[^>]{0,200}>([^<]{0,2000})/i.exec(html);
  const pick = (/** @type {string[]} */ ...keys) => { for (const key of keys) { const value = meta.get(key); if (value) return value; } return ''; };
  return {
    title: cleanText(pick('og:title', 'twitter:title') || (titleTag ? titleTag[1] : ''), TITLE_MAX),
    description: cleanText(pick('og:description', 'twitter:description', 'description'), DESCRIPTION_MAX),
    siteName: cleanText(pick('og:site_name'), SITE_NAME_MAX),
    image: decodeEntities(pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src').slice(0, MAX_URL_LENGTH * 2)).trim(),
  };
}

/**
 * The text of a page. The charset comes from the Content-Type header, else from a <meta> in the
 * first couple of kilobytes, else UTF-8; a label the decoder does not know falls back to UTF-8.
 * @param {Buffer} buffer @param {string} contentType the whole header value
 */
function decodeHtml(buffer, contentType) {
  let label = (/charset\s*=\s*"?([a-z0-9_.:-]{1,40})/i.exec(contentType) || [])[1];
  if (!label) label = (/<meta[^>]{0,200}charset\s*=\s*["']?([a-z0-9_.:-]{1,40})/i.exec(buffer.subarray(0, 2048).toString('latin1')) || [])[1];
  try { return new TextDecoder(label || 'utf-8').decode(buffer); } catch (_) { return new TextDecoder('utf-8').decode(buffer); }
}

/**
 * Which raster format these bytes are, by their signature. The declared type is only a claim.
 * @param {Buffer} buffer
 * @returns {'png' | 'jpeg' | 'gif' | 'webp' | null}
 */
function sniffImage(buffer) {
  if (buffer.length < 12) return null; // nothing decodable is this short
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  const six = buffer.subarray(0, 6).toString('latin1');
  if (six === 'GIF87a' || six === 'GIF89a') return 'gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/**
 * A stored preview, as the client is sent it, or null. Checked on the way out as well as on the
 * way in: whatever a row holds, the image is one of this server's own files and the link is http(s).
 * @param {unknown} value the preview_json column, or an object
 * @returns {Preview | null}
 */
function parsePreview(value) {
  if (!value) return null;
  /** @type {any} */
  let raw = value;
  if (typeof value === 'string') {
    try { raw = JSON.parse(value); } catch (_) { return null; }
  }
  if (!raw || typeof raw !== 'object' || typeof raw.url !== 'string' || !/^https?:\/\//.test(raw.url) || raw.url.length > MAX_URL_LENGTH) return null;
  /** @type {Preview} */
  const preview = { url: raw.url };
  const text = (/** @type {unknown} */ field, /** @type {number} */ max) => (typeof field === 'string' && field ? Array.from(field).slice(0, max).join('') : '');
  const title = text(raw.title, TITLE_MAX);
  const description = text(raw.description, DESCRIPTION_MAX);
  const siteName = text(raw.siteName, SITE_NAME_MAX);
  if (!title && !description) return null;
  if (title) preview.title = title;
  if (description) preview.description = description;
  if (siteName) preview.siteName = siteName;
  if (typeof raw.image === 'string' && STORED_IMAGE.test(raw.image)) preview.image = raw.image;
  return preview;
}

// ---------------------------------------------------------------------------------------------

/** @param {Record<string, string | string[] | undefined>} headers @param {string} name */
function headerOf(headers, name) {
  const value = headers ? headers[name] : undefined;
  return String(Array.isArray(value) ? value[0] : value || '');
}

/** @param {string | undefined} moduleId @returns {{ resolve: Resolver, request: Requester } | null} */
function loadTransport(moduleId) {
  try {
    const mod = require(/** @type {string} */ (moduleId));
    return mod && typeof mod.resolve === 'function' && typeof mod.request === 'function' ? mod : null;
  } catch (_) {
    return null;
  }
}

// The three message tables and the column each keeps its text in. Table names go into SQL, so
// they are only ever taken from here (textColumnOf), never from a caller's string as such.
const TEXT_COLUMN = /** @type {Record<MessageTable, string>} */ ({ messages: 'text', direct_messages: 'body', group_messages: 'body' });
/** @param {unknown} table @returns {string | null} */
const textColumnOf = (table) => (typeof table === 'string' && Object.hasOwn(TEXT_COLUMN, table) ? TEXT_COLUMN[/** @type {MessageTable} */ (table)] : null);

/**
 * @param {{
 *   db: Db,
 *   dataDir: string,
 *   env?: Record<string, string | undefined>,
 *   resolve?: Resolver,
 *   request?: Requester,
 *   timeoutMs?: number,
 *   maxStoreBytes?: number,
 *   now?: () => number,
 *   log?: Pick<Console, 'log' | 'warn'>,
 * }} deps `resolve` and `request` replace DNS and HTTP (tests pass both, so nothing leaves the
 *   machine).
 */
function createLinkPreviews({ db, dataDir, env = process.env, resolve, request, timeoutMs = FETCH_TIMEOUT_MS, maxStoreBytes = MAX_IMAGE_STORE_BYTES, now = Date.now, log = console }) {
  const imagesDir = path.join(dataDir, IMAGE_DIR);
  const switchedOff = ['0', 'false', 'off'].includes(String(env.LINK_PREVIEWS || '').trim().toLowerCase());
  let on = !switchedOff;
  /** @type {Resolver} */
  let resolveName = resolve || systemResolve;
  /** @type {Requester} */
  let sendRequest = request || pinnedRequest;
  if (on && !resolve && !request && env.LINK_PREVIEW_TRANSPORT) {
    const stand = loadTransport(env.LINK_PREVIEW_TRANSPORT);
    if (stand) {
      resolveName = stand.resolve;
      sendRequest = stand.request;
    } else {
      // Asked to use a stand-in network and could not: the real one must not be the fallback.
      on = false;
      log.warn('[link-preview] LINK_PREVIEW_TRANSPORT could not be loaded: link previews are off');
    }
  }
  if (switchedOff) log.log('[link-preview] LINK_PREVIEWS=0: link previews are off');
  else if (on) log.log('[link-preview] link previews on (LINK_PREVIEWS=0 turns them off)');

  const debug = !!String(env.LINK_PREVIEW_DEBUG || '').trim();

  const enabled = () => on;

  // --- One fetch ---

  /**
   * Resolve a name and insist that everything it resolves to is public.
   * @param {string} host
   * @returns {Promise<ResolvedAddress[]>} the addresses to connect to, IPv4 first
   */
  async function resolvePublic(host) {
    /** @type {ResolvedAddress[]} */
    let answers;
    try { answers = await resolveName(host); } catch (_) { throw new Refusal('dns'); }
    if (!Array.isArray(answers) || answers.length === 0 || answers.length > MAX_ADDRESSES) throw new Refusal('dns');
    /** @type {ResolvedAddress[]} */
    const checked = [];
    for (const answer of answers) {
      const verdict = classifyAddress(answer && answer.address);
      // ANY address that is not public refuses the name. Picking the public one out of a mixed
      // answer would be trusting a name that also points inside.
      if (!verdict.ok) throw new Refusal(verdict.reason);
      checked.push({ address: answer.address, family: verdict.family });
    }
    // A home server reaches IPv4 more reliably than IPv6.
    return [...checked.filter((a) => a.family === 4), ...checked.filter((a) => a.family === 6)];
  }

  /**
   * GET `startHref`, following redirects, and return what came back. Every hop is checked, resolved
   * and pinned again.
   * @param {string} startHref
   * @param {{ kind: 'html' | 'image' | 'json', ownHosts: Set<string> }} what
   * @returns {Promise<{ url: URL, contentType: string, buffer: Buffer }>}
   */
  async function fetchResource(startHref, { kind, ownHosts }) {
    const controller = new AbortController();
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    // One deadline for the whole thing: DNS, every hop, and the body.
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Refusal('timeout')); }, timeoutMs);
    });
    expired.catch(() => {}); // it is only ever observed through race()
    /** @template T @param {Promise<T>} work @returns {Promise<T>} */
    const race = (work) => /** @type {Promise<T>} */ (Promise.race([work, expired]));
    const { cap, types, truncate, accept } = KINDS[kind];
    /** @type {PinnedResponse | null} */
    let open = null;
    try {
      let href = startHref;
      for (let hop = 0; ; hop += 1) {
        const checked = checkUrl(href, ownHosts);
        if (!checked.ok) throw new Refusal(checked.reason);
        const { url, host } = checked;
        const addresses = await race(resolvePublic(host));
        /** @type {PinnedRequest} */
        const base = {
          protocol: /** @type {'http:' | 'https:'} */ (url.protocol),
          hostname: host,
          address: '',
          family: 4,
          port: url.protocol === 'https:' ? 443 : 80,
          path: `${url.pathname}${url.search}`,
          headers: {
            'User-Agent': USER_AGENT,
            Accept: accept,
            'Accept-Language': 'en',
            // Uncompressed, so the byte cap is a cap on what is read AND on what it turns into.
            'Accept-Encoding': 'identity',
            Connection: 'close',
          },
          signal: controller.signal,
        };
        /** @type {PinnedResponse | null} */
        let response = null;
        for (const target of addresses.slice(0, MAX_CONNECT_ATTEMPTS)) {
          try {
            response = await race(sendRequest({ ...base, address: target.address, family: target.family }));
            break;
          } catch (err) {
            if (err instanceof Refusal) throw err; // the deadline
            response = null;
          }
        }
        if (!response) throw new Refusal('connect');
        open = response;
        const status = Number(response.status);
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = headerOf(response.headers, 'location');
          response.destroy();
          open = null;
          if (!location) throw new Refusal('status');
          if (hop >= MAX_REDIRECTS) throw new Refusal('too-many-redirects');
          if (location.length > MAX_URL_LENGTH) throw new Refusal('url-too-long');
          try { href = new URL(location, url).href; } catch (_) { throw new Refusal('bad-url'); }
          continue;
        }
        if (status < 200 || status > 299) throw new Refusal('status');
        const contentType = headerOf(response.headers, 'content-type');
        if (!types.has(contentType.split(';')[0].trim().toLowerCase())) throw new Refusal('content-type');
        const encoding = headerOf(response.headers, 'content-encoding').trim().toLowerCase();
        if (encoding && encoding !== 'identity') throw new Refusal('content-encoding');
        // The declared size. An image over the cap is turned down before a byte of it is read; a
        // page is simply never read past the cap (what a preview needs is in its <head>).
        const declared = headerOf(response.headers, 'content-length').trim();
        if (!truncate && /^\d+$/.test(declared) && Number(declared) > cap) throw new Refusal('too-large');
        // The actual size, whatever was declared.
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        const iterator = response.body[Symbol.asyncIterator]();
        try {
          for (;;) {
            const step = await race(iterator.next());
            if (step.done) break;
            /** @type {any} */
            const value = step.value;
            const chunk = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
            if (size + chunk.length > cap) {
              if (!truncate) throw new Refusal('too-large');
              chunks.push(chunk.subarray(0, cap - size));
              size = cap;
              break; // stop reading
            }
            chunks.push(chunk);
            size += chunk.length;
          }
        } finally {
          // Not awaited: a source that is stuck would keep this waiting too.
          try { Promise.resolve(iterator.return ? iterator.return() : undefined).catch(() => {}); } catch (_) { /* already finished */ }
        }
        return { url, contentType, buffer: Buffer.concat(chunks, size) };
      }
    } finally {
      clearTimeout(timer);
      if (open) { try { open.destroy(); } catch (_) { /* already closed */ } }
    }
  }

  /**
   * Fetch a page's preview image and keep it under DATA_DIR/link-previews by content hash.
   * @param {string} rawImageUrl as the page gave it @param {URL} pageUrl @param {Set<string>} ownHosts
   * @returns {Promise<string | null>} its /link-previews/ url, or null: the preview then has no image
   */
  async function storeImage(rawImageUrl, pageUrl, ownHosts) {
    try {
      if (!rawImageUrl || rawImageUrl.length > MAX_URL_LENGTH) return null;
      const href = new URL(rawImageUrl, pageUrl).href;
      const { buffer } = await fetchResource(href, { kind: 'image', ownHosts });
      const format = sniffImage(buffer);
      if (!format) return null; // typed as an image, but its bytes are something else
      const name = `${crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 32)}${IMAGE_EXTENSIONS[format]}`;
      const file = path.join(imagesDir, name);
      await fs.promises.mkdir(imagesDir, { recursive: true });
      try {
        // The same picture again: keep the one file, and mark it as in use now (the sweep goes by
        // age) so that a cached preview never points at a file about to be collected.
        const stamp = new Date(now());
        await fs.promises.utimes(file, stamp, stamp);
      } catch (_) {
        // A new file. The folder shares a volume with the database, and what goes into it is
        // chosen by whoever posts links, so it has a ceiling: over it, previews go without an
        // image until the sweep has made room.
        if (storeBytes === null) storeBytes = await measureStore();
        if (storeBytes + buffer.length > maxStoreBytes) return null;
        storeBytes += buffer.length;
        // Written beside the target and renamed, so a reader never gets half a file.
        const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        await fs.promises.writeFile(tmp, buffer);
        await fs.promises.rename(tmp, file);
      }
      return `${IMAGE_URL_PREFIX}${name}`;
    } catch (err) {
      // A preview without its picture is a normal outcome, so this is silent unless asked: the reason
      // is the only way to tell a refused address from a slow site from an image that is too big.
      debugNote('image not kept', rawImageUrl, pageUrl, err);
      return null;
    }
  }

  /**
   * LINK_PREVIEW_DEBUG: one line saying why something was not fetched. Only ever the host name and
   * a short reason code: never a path or a query (a link can carry a token in either), and never
   * anything about who posted it.
   * @param {string} what @param {string} rawUrl @param {URL | undefined} base @param {unknown} err
   */
  function debugNote(what, rawUrl, base, err) {
    if (!debug) return;
    let host = 'unknown host';
    try { host = new URL(rawUrl, base).hostname || host; } catch (_) { /* not a URL: say so by saying nothing more */ }
    const failure = /** @type {any} */ (err) || {};
    // A Refusal's reason is one of our own codes. Anything else is reduced to its error code or
    // class name: a message can quote the address it was about.
    const reason = err instanceof Refusal ? err.reason : String(failure.code || failure.name || 'error');
    log.warn(`[link-preview] ${what}: ${host} (${reason.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)})`);
  }

  // How many bytes the image folder holds: counted the first time it matters and again after each
  // sweep, and added to in between.
  /** @type {number | null} */
  let storeBytes = null;
  async function measureStore() {
    let total = 0;
    try {
      for (const name of await fs.promises.readdir(imagesDir)) {
        try { total += (await fs.promises.stat(path.join(imagesDir, name))).size; } catch (_) { /* vanished under us */ }
      }
    } catch (_) { /* no folder yet: nothing in it */ }
    return total;
  }

  /**
   * @param {string} href @param {Set<string>} ownHosts
   * @returns {Promise<Preview>} rejects with a Refusal when there is nothing to show
   */
  async function fetchPreview(href, ownHosts) {
    const provider = oembedFor(href);
    if (provider) return fetchOembedPreview(href, provider, ownHosts);
    const page = await fetchResource(href, { kind: 'html', ownHosts });
    const found = extractMetadata(decodeHtml(page.buffer, page.contentType));
    if (!found.title && !found.description) throw new Refusal('no-metadata');
    /** @type {Preview} */
    const preview = { url: href };
    if (found.title) preview.title = found.title;
    if (found.description) preview.description = found.description;
    if (found.siteName) preview.siteName = found.siteName;
    const image = found.image ? await storeImage(found.image, page.url, ownHosts) : null;
    if (image) preview.image = image;
    return preview;
  }

  /**
   * The preview of a link a provider recognised, from that provider's oEmbed JSON. The link's own
   * page is never fetched. The card links to `href`, the address that was posted: no URL in the
   * JSON is used for anything except the thumbnail, and that one is only ever handed to storeImage,
   * which checks, resolves and pins it like any image a page names.
   * @param {string} href @param {{ siteName: string, oembed: string | null }} provider @param {Set<string>} ownHosts
   * @returns {Promise<Preview>}
   */
  async function fetchOembedPreview(href, provider, ownHosts) {
    if (!provider.oembed) throw new Refusal('bad-id');
    const answer = await fetchResource(provider.oembed, { kind: 'json', ownHosts });
    /** @type {any} */
    let data;
    try { data = JSON.parse(answer.buffer.toString('utf8')); } catch (_) { throw new Refusal('bad-json'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Refusal('bad-json');
    const title = cleanText(data.title, TITLE_MAX);
    if (!title) throw new Refusal('no-metadata');
    /** @type {Preview} */
    const preview = { url: href, title };
    const author = cleanText(data.author_name, AUTHOR_MAX);
    if (author) preview.description = `by ${author}`;
    preview.siteName = provider.siteName;
    const thumbnail = typeof data.thumbnail_url === 'string' ? data.thumbnail_url.trim() : '';
    const image = thumbnail ? await storeImage(thumbnail, answer.url, ownHosts) : null;
    if (image) preview.image = image;
    return preview;
  }

  // --- Who may fetch, how many at once, and what is already known ---

  /** @type {Map<string, number[]>} */
  const userFetches = new Map();
  /** @param {string} user @returns {boolean} true if this person may cause another fetch now */
  function allowUser(user) {
    const at = now();
    const recent = (userFetches.get(user) || []).filter((t) => at - t < USER_WINDOW_MS);
    if (recent.length >= USER_FETCHES_PER_WINDOW) { userFetches.set(user, recent); return false; }
    recent.push(at);
    userFetches.set(user, recent);
    if (userFetches.size > 5000) userFetches.clear(); // a bound, not a cache worth tuning
    return true;
  }

  let active = 0;
  /** @type {Array<() => void>} */
  const waiting = [];
  /** @returns {Promise<void>} resolves when a slot is this job's */
  function acquire() {
    if (active < MAX_CONCURRENT) { active += 1; return Promise.resolve(); }
    return new Promise((resolveSlot) => { waiting.push(resolveSlot); });
  }
  function release() {
    const next = waiting.shift();
    if (next) next(); // the slot passes straight to the next job
    else active -= 1;
  }

  /** @type {Map<string, Promise<Preview | null>>} */
  const inFlight = new Map();
  /** What was turned down and why, for tests: the last few only. @type {Array<{ url: string, reason: string }>} */
  const refusals = [];
  /** @param {string} url @param {string} reason */
  const noteRefusal = (url, reason) => { refusals.push({ url, reason }); if (refusals.length > 50) refusals.shift(); };

  /**
   * The preview for a link that has already passed checkUrl: from the cache, from a fetch that is
   * already running, or from a new one. Null when there is none to be had. Never rejects.
   * @param {string} href normalised
   * @param {{ user: string | null | undefined, ownHosts?: Set<string> }} who
   * @returns {Promise<Preview | null>}
   */
  async function previewFor(href, { user, ownHosts = new Set() }) {
    if (!on) return null;
    try {
      const row = await db.get('SELECT status, data, expires_at FROM link_previews WHERE url = ?', href);
      if (row && row.expires_at > now()) return row.status === 'ok' ? parsePreview(row.data) : null;
      const running = inFlight.get(href);
      if (running) return running;
      // Neither of these is remembered: they are about this moment, not about the link.
      if (!user || !allowUser(user)) { noteRefusal(href, 'rate-limited'); return null; }
      if (active >= MAX_CONCURRENT && waiting.length >= MAX_QUEUED) { noteRefusal(href, 'busy'); return null; }
      const job = (async () => {
        await acquire();
        try {
          const preview = await fetchPreview(href, ownHosts);
          await remember(href, 'ok', preview, OK_TTL_MS);
          return preview;
        } catch (err) {
          const reason = err instanceof Refusal ? err.reason : 'error';
          noteRefusal(href, reason);
          debugNote('no preview', href, undefined, err);
          if (!(err instanceof Refusal)) log.warn('[link-preview] fetch failed:', (err && (/** @type {any} */ (err).code || /** @type {any} */ (err).name)) || 'error');
          await remember(href, 'none', null, FAIL_TTL_MS).catch(() => {});
          return null;
        } finally {
          release();
          inFlight.delete(href);
        }
      })();
      inFlight.set(href, job);
      return await job;
    } catch (err) {
      log.warn('[link-preview] lookup failed:', (err && (/** @type {any} */ (err).code || /** @type {any} */ (err).name)) || 'error');
      return null;
    }
  }

  /** @param {string} href @param {'ok' | 'none'} status @param {Preview | null} data @param {number} ttl */
  async function remember(href, status, data, ttl) {
    const at = now();
    await db.run(
      `INSERT INTO link_previews (url, status, data, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET status = excluded.status, data = excluded.data, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
      href, status, data ? JSON.stringify(data) : null, at, at + ttl
    );
  }

  // --- Messages ---

  /**
   * Find the link in a stored message, get its preview, and attach it. Runs after the message has
   * been stored and delivered: `emit` is called with the preview once it is on the row, and never
   * if there is none. Never rejects.
   * @param {{
   *   table: MessageTable, id: number | string, user: string | null | undefined,
   *   ownHosts?: Set<string>, emit: (preview: Preview) => unknown,
   * }} job
   * @returns {Promise<Preview | null>}
   */
  async function attachTo({ table, id, user, ownHosts = new Set(), emit }) {
    if (!on) return null;
    const column = textColumnOf(table);
    if (!column) return null;
    try {
      const read = () => db.get(`SELECT ${column} AS text, attachment_json FROM ${table} WHERE id = ?`, id);
      const before = await read();
      const link = before ? findPreviewLink(before.text, before.attachment_json, ownHosts) : null;
      if (!link) return null;
      const fetched = await previewFor(link.href, { user, ownHosts });
      if (!fetched) return null;
      // The fetch took a moment. The message may have been deleted meanwhile, or edited so that
      // this is no longer its link: then the preview belongs to nothing.
      const after = await read();
      const current = after ? findPreviewLink(after.text, after.attachment_json, ownHosts) : null;
      if (!current || current.shown !== link.shown) return null;
      // What was fetched (and cached) is the page; the card links to it the way the author wrote
      // it, fragment included, so "#section" and "#/route" links still land where they point.
      const preview = { ...fetched, url: link.shown };
      await db.run(`UPDATE ${table} SET preview_json = ? WHERE id = ?`, JSON.stringify(preview), id);
      await emit(preview);
      return preview;
    } catch (err) {
      log.warn('[link-preview] could not attach a preview:', (err && (/** @type {any} */ (err).code || /** @type {any} */ (err).name)) || 'error');
      return null;
    }
  }

  /**
   * A message was edited. Its preview is looked at again only if the link it is for changed: the
   * old card is taken off (`clear` is called if there was one) and the new link, if any, goes
   * through attachTo. An edit that leaves the link alone fetches nothing, and does not bring back
   * a preview its author removed.
   * @param {{
   *   table: MessageTable, id: number | string, oldText: string, newText: string, user: string | null | undefined,
   *   ownHosts?: Set<string>, emit: (preview: Preview) => unknown, clear: () => unknown,
   * }} edit
   * @returns {Promise<void>}
   */
  async function afterEdit({ table, id, oldText, newText, user, ownHosts = new Set(), emit, clear }) {
    try {
      const was = findPreviewLink(oldText, null, ownHosts);
      const is = findPreviewLink(newText, null, ownHosts);
      if ((was ? was.shown : null) === (is ? is.shown : null)) return;
      // Whether or not fetching is on: a card for a link that is no longer in the message is wrong.
      if (await remove(table, id)) await clear();
      await attachTo({ table, id, user, ownHosts, emit });
    } catch (err) {
      log.warn('[link-preview] could not update a preview after an edit:', (err && (/** @type {any} */ (err).code || /** @type {any} */ (err).name)) || 'error');
    }
  }

  /**
   * Take the preview off a message. Who may is the caller's to decide.
   * @param {MessageTable} table @param {number | string} id
   * @returns {Promise<boolean>} whether there was one
   */
  async function remove(table, id) {
    if (!textColumnOf(table)) return false;
    const result = await db.run(`UPDATE ${table} SET preview_json = NULL WHERE id = ? AND preview_json IS NOT NULL`, id);
    return !!(result && result.changes > 0);
  }

  // --- Housekeeping ---

  /**
   * Drop cache rows that have expired, and image files older than IMAGE_KEEP_MS that no stored
   * preview (on a message, or still in the cache) refers to.
   * @returns {Promise<{ files: number, rows: number }>} what was removed
   */
  async function sweep() {
    const at = now();
    const expired = await db.run('DELETE FROM link_previews WHERE expires_at <= ?', at);
    const removed = { files: 0, rows: (expired && expired.changes) || 0 };
    /** @type {string[]} */
    let names;
    try { names = await fs.promises.readdir(imagesDir); } catch (_) { return removed; }
    /** @type {string[]} */
    const old = [];
    for (const name of names) {
      try {
        const stat = await fs.promises.stat(path.join(imagesDir, name));
        if (stat.isFile() && at - stat.mtimeMs > IMAGE_KEEP_MS) old.push(name);
      } catch (_) { /* vanished under us */ }
    }
    if (old.length === 0) return removed;
    // One pass over what is stored: anything that names the file counts, which errs towards keeping.
    /** @type {Set<string>} */
    const referenced = new Set();
    const sources = [
      "SELECT preview_json AS json FROM messages WHERE preview_json LIKE '%/link-previews/%'",
      "SELECT preview_json AS json FROM direct_messages WHERE preview_json LIKE '%/link-previews/%'",
      "SELECT preview_json AS json FROM group_messages WHERE preview_json LIKE '%/link-previews/%'",
      "SELECT data AS json FROM link_previews WHERE data LIKE '%/link-previews/%'",
    ];
    for (const sql of sources) {
      for (const row of await db.all(sql)) {
        for (const found of String(row.json || '').matchAll(/\/link-previews\/([A-Za-z0-9._-]+)/g)) referenced.add(found[1]);
      }
    }
    for (const name of old) {
      if (referenced.has(name)) continue;
      try { await fs.promises.unlink(path.join(imagesDir, name)); removed.files += 1; } catch (_) { /* not ours to remove */ }
    }
    if (removed.files) storeBytes = null; // counted afresh the next time an image is stored
    if (removed.files) log.log(`[link-preview] removed ${removed.files} unreferenced preview image(s)`);
    return removed;
  }

  return {
    enabled, imagesDir, previewFor, attachTo, afterEdit, remove, sweep,
    // For tests: one fetch with no cache, queue or rate limit in front of it, and what was refused.
    fetchPreview, refusals: () => refusals.slice(),
  };
}

module.exports = {
  createLinkPreviews, Refusal, classifyAddress, checkHostname, checkUrl, previewLinkOf, ownHostnames, oembedFor,
  MAX_JSON_BYTES,
  extractMetadata, cleanText, parsePreview, sniffImage, pinnedRequest,
  IMAGE_DIR, MAX_URL_LENGTH, MAX_REDIRECTS, MAX_HTML_BYTES, MAX_IMAGE_BYTES, MAX_IMAGE_STORE_BYTES, MAX_CONCURRENT, MAX_QUEUED,
  USER_FETCHES_PER_WINDOW, OK_TTL_MS, FAIL_TTL_MS, IMAGE_KEEP_MS, TITLE_MAX, DESCRIPTION_MAX, SITE_NAME_MAX, USER_AGENT,
};
