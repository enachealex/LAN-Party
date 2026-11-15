// Stands in for DNS and HTTP inside a test server (helpers.startServer with LINK_PREVIEW_TRANSPORT
// pointing here), so the real link preview pipeline runs end to end (services/linkPreview.js) and
// nothing is ever looked up or fetched for real. No socket is opened anywhere in this file.
//
// The "web" is a JSON file the test writes into the server's DATA_DIR, read again on every call so
// a test can change it while the server runs:
//
//   link-web.json  {
//     "hosts": { "news.example.com": ["93.184.216.34"] },          name -> the addresses it "resolves" to
//     "pages": { "https://news.example.com/story": {                url -> what a GET of it answers
//       "status": 200, "headers": { "content-type": "text/html" },
//       "body": "<html>…", "bodyBase64": "…", "delayMs": 0 } }
//   }
//
// A name that is not listed does not resolve; a url that is not listed answers 404. Every lookup
// and every request is appended to DATA_DIR/link-requests.jsonl, which is how a test (a different
// process) sees exactly what the server asked for, of which address, and with which headers.
const fs = require('fs');
const net = require('net');
const path = require('path');

const DIR = process.env.DATA_DIR || '.';
const WEB = path.join(DIR, 'link-web.json');
const LOG = path.join(DIR, 'link-requests.jsonl');

function web() {
  try { return JSON.parse(fs.readFileSync(WEB, 'utf8')); } catch (_) { return { hosts: {}, pages: {} }; }
}
const record = (entry) => fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);

async function resolve(hostname) {
  const addresses = (web().hosts || {})[hostname];
  record({ kind: 'resolve', hostname, found: !!addresses });
  if (!addresses) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
  return addresses.map((address) => ({ address, family: net.isIP(address) }));
}

async function request({ protocol, hostname, address, port, path: requestPath, headers }) {
  const url = `${protocol}//${hostname}${requestPath}`;
  record({ kind: 'request', url, address, port, headers });
  const page = (web().pages || {})[url] || { status: 404, headers: { 'content-type': 'text/html' }, body: '' };
  if (page.delayMs) await new Promise((r) => setTimeout(r, page.delayMs));
  const bytes = page.bodyBase64 ? Buffer.from(page.bodyBase64, 'base64') : Buffer.from(page.body || '');
  return {
    status: page.status || 200,
    headers: page.headers || {},
    body: (async function* chunks() { for (let i = 0; i < bytes.length; i += 16384) yield bytes.subarray(i, i + 16384); }()),
    destroy() {},
  };
}

module.exports = { resolve, request };
