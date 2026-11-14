// @ts-check
// Is the public address the SFU announces still this network's public address?
//
// Remote callers reach the voice server at the address in SFU_ANNOUNCED_IPS. A home connection's
// public address changes whenever the provider feels like it, and nothing fails loudly when it does:
// the server keeps running, LAN callers keep working, and every remote caller's media silently goes
// to an address that is no longer this house. This asks an outside service what address the machine
// is seen from and says so, once, when the two differ.
const http = require('http');
const https = require('https');
const net = require('net');

const TRACE_URL = 'https://cloudflare.com/cdn-cgi/trace';
const CHECK_INTERVAL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 5000;
const STALE_WARNING = '[sfu] the announced public address no longer matches this network\'s public address; remote callers cannot reach the voice server until SFU_ANNOUNCED_IPS is updated';

/**
 * Can someone outside this network send packets to this address? A name (DDNS) counts: nobody
 * announces a name for the LAN's benefit.
 * @param {string} address
 */
function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT, which is also Tailscale
    return true;
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return false;
    return !/^(fe[89ab]|f[cd])/.test(lower); // link-local, unique-local
  }
  return address.length > 0;
}

/**
 * The `ip=` line of a Cloudflare trace.
 * @param {string} text
 * @returns {string | null}
 */
function parseTrace(text) {
  const match = /^ip=(\S+)\s*$/m.exec(String(text || ''));
  return match && net.isIP(match[1]) ? match[1] : null;
}

/**
 * Ask the trace service which address this machine is seen from. `family` pins the connection to
 * IPv4 or IPv6: a dual-stack host asked over IPv6 would report an address that can never equal an
 * announced IPv4 one.
 * @param {{ url?: string, family?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<string | null>}
 */
function fetchPublicAddress({ url = TRACE_URL, family = 4, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http:') ? http : https;
    const req = client.get(url, { family, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy(new Error('trace response too large'));
      });
      res.on('end', () => resolve(parseTrace(body)));
    });
    req.on('timeout', () => req.destroy(new Error('trace timed out')));
    req.on('error', reject);
  });
}

/**
 * @param {{
 *   announced: string[],
 *   fetchAddress?: (family: number) => Promise<string | null>,
 *   warn?: (message: string) => void,
 *   info?: (message: string) => void,
 *   intervalMs?: number,
 * }} opts
 */
function createAddressMonitor({ announced, fetchAddress = (family) => fetchPublicAddress({ family }), warn = console.warn, info = console.log, intervalMs = CHECK_INTERVAL_MS }) {
  // DEPLOY.md puts the public address first. Taking the first public LITERAL covers a list written
  // the other way round too; a name cannot be compared without resolving it, so it is left alone.
  const target = announced.find((a) => net.isIP(a) !== 0 && isPublicAddress(a)) || null;
  let stale = false;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  // Never throws and never guesses: an unreachable trace service, or an answer in the other address
  // family, leaves the last known state as it was.
  async function check() {
    if (!target) return stale;
    let current = null;
    try { current = await fetchAddress(net.isIP(target)); } catch (_) { return stale; }
    if (!current || net.isIP(current) !== net.isIP(target)) return stale;
    const differs = current.toLowerCase() !== target.toLowerCase();
    // Once per change, not once per check: a line every half hour is a line nobody reads.
    if (differs && !stale) warn(STALE_WARNING);
    if (!differs && stale) info('[sfu] the announced public address matches this network\'s public address again');
    stale = differs;
    return stale;
  }

  function start() {
    if (!target || timer) return;
    void check();
    timer = setInterval(() => { void check(); }, intervalMs);
    timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { check, start, stop, isStale: () => stale, watching: !!target };
}

module.exports = { createAddressMonitor, fetchPublicAddress, isPublicAddress, parseTrace, STALE_WARNING };
