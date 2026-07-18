// Forwards user-submitted feedback / bug reports to Vaultline's ingest API, which turns them into
// tickets (Tasks for feedback, Bugs for reports). The Vaultline API key is a secret and lives ONLY
// here on the server — it is never sent to the client. Credentials come from env vars, or a
// gitignored JSON key file (server/vaultline.key) alongside the other *.key files:
//   { "apiKey": "dev-api-key-demo", "baseUrl": "https://vaultline.thejumpvault.com" }
const fs = require('fs');
const path = require('path');

const DEFAULT_BASE = 'https://vaultline.thejumpvault.com';

function loadConfig() {
  const e = process.env;
  let cfg = { apiKey: e.VAULTLINE_API_KEY, baseUrl: e.VAULTLINE_API_BASE };
  if (!cfg.apiKey) {
    try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(__dirname, 'vaultline.key'), 'utf8')) }; } catch (_) { /* not configured */ }
  }
  cfg.baseUrl = (cfg.baseUrl || DEFAULT_BASE).replace(/\/$/, '');
  return cfg;
}

function isConfigured() {
  return !!loadConfig().apiKey;
}

// Bug reports become high-priority Bugs (/reports); everything else (feedback + feature requests)
// becomes a Task (/feedback). Vaultline has no dedicated "requests" endpoint today.
function endpointFor(type) {
  return type === 'bug' ? '/api/v1/reports' : '/api/v1/feedback';
}

// Submit one item. Throws on any non-201 so the caller can record the failure and keep the locally
// stored copy for a later retry. Resolves to { key, summary } on success.
async function submit({ type, username, email, message, title }) {
  const cfg = loadConfig();
  if (!cfg.apiKey) throw new Error('Vaultline API key not configured');

  const url = cfg.baseUrl + endpointFor(type);
  const body = { username, email, message };
  if (title) body.title = title;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Vaultline request failed: ${err.message}`);
  }

  let data = null;
  try { data = await res.json(); } catch (_) { /* non-JSON error body */ }
  if (res.status !== 201) {
    const detail = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new Error(`Vaultline rejected submission: ${detail}`);
  }
  const issue = (data && data.issue) || {};
  return { key: issue.key || null, summary: issue.summary || null };
}

module.exports = { submit, isConfigured, endpointFor, loadConfig };
