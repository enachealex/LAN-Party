// Creates the signing key (first run only), generates the TWA Gradle project in android/twa/, and
// writes android/assetlinks.json — the Digital Asset Links statement the server must serve at
// /.well-known/assetlinks.json so Chrome trusts the app and hides the URL bar.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { TwaManifest, TwaGenerator, KeyTool, ConsoleLog, DigitalAssetLinks } = require('@bubblewrap/core');
const c = require('./common');

async function ensureSigningKey(jdkHelper, log) {
  if (fs.existsSync(c.KEYSTORE)) return c.readPassword();
  const password = c.registerSecret(crypto.randomBytes(24).toString('base64url')); // shell-safe charset
  fs.writeFileSync(c.KEYSTORE_ENV, `LANPARTY_KEYSTORE_PASSWORD=${password}\n`, { mode: 0o600 });
  await new KeyTool(jdkHelper, log).createSigningKey({
    path: c.KEYSTORE, alias: c.KEY_ALIAS, password, keypassword: password,
    fullName: 'LAN Party', organizationalUnit: 'LAN Party', organization: 'thejumpvault', country: 'US',
  });
  log.warn(`Created a NEW signing key at ${c.KEYSTORE} (password in ${c.KEYSTORE_ENV}). Back up both.`);
  return password;
}

// Icons are served from the repo over loopback rather than fetched from the live site, so a build
// never depends on the current deploy (e.g. the maskable icon before it has shipped).
function serveRepoIcons() {
  const root = path.join(c.REPO_DIR, 'client', 'public');
  const server = http.createServer((req, res) => {
    const file = path.normalize(path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function generate() {
  const log = new ConsoleLog('generate');
  const { jdkHelper } = await c.tools(log);
  const password = await ensureSigningKey(jdkHelper, log);

  // Start from the repo's web manifest (name, colors, icons), then pin the TWA-specific fields.
  const webManifest = JSON.parse(fs.readFileSync(path.join(c.REPO_DIR, 'client', 'public', 'manifest.webmanifest'), 'utf8'));
  const base = TwaManifest.fromWebManifestJson(new URL(c.APP.webManifestUrl), webManifest).toJson();
  const version = c.appVersion();
  const json = {
    ...base,
    packageId: c.APP.packageId,
    host: c.APP.host,
    name: 'LAN Party',
    launcherName: 'LAN Party',
    startUrl: c.APP.startUrl,
    display: 'standalone',
    themeColor: '#7a0d0d',
    themeColorDark: '#7a0d0d',
    navigationColor: '#0f1418',
    navigationColorDark: '#0f1418',
    navigationDividerColor: '#0f1418',
    navigationDividerColorDark: '#0f1418',
    backgroundColor: '#0f1418',
    enableNotifications: false,
    fallbackType: 'customtabs',
    signingKey: { path: c.KEYSTORE, alias: c.KEY_ALIAS },
    appVersionCode: version.code,
    appVersion: version.name, // the JSON field for versionName is `appVersion`, not `appVersionName`
    iconUrl: new URL('icons/logo-512.png', c.APP.webManifestUrl).toString(),
    maskableIconUrl: new URL('icons/logo-maskable-512.png', c.APP.webManifestUrl).toString(),
    shortcuts: [],
  };

  const server = await serveRepoIcons();
  const local = `http://127.0.0.1:${server.address().port}`;
  try {
    const genManifest = new TwaManifest({
      ...json,
      iconUrl: `${local}/icons/logo-512.png`,
      maskableIconUrl: `${local}/icons/logo-maskable-512.png`,
    });
    const problem = genManifest.validate();
    if (problem) throw new Error(`Invalid TWA manifest: ${problem}`);
    try {
      fs.rmSync(c.PROJECT_DIR, { recursive: true, force: true });
    } catch (err) {
      // Windows refuses to delete a folder another process has open or is sitting in.
      if (err.code === 'EPERM' || err.code === 'EBUSY') {
        throw new Error(`Can't replace ${c.PROJECT_DIR}: something is using it (a terminal cd'd into it, an editor, Explorer, a Gradle daemon). Close it and re-run.`);
      }
      throw err;
    }
    await new TwaGenerator().createTwaProject(c.PROJECT_DIR, genManifest, log);
  } finally {
    server.close();
  }
  // Keep a copy with the public icon URLs next to the project, for reference.
  await new TwaManifest(json).saveToFile(path.join(c.PROJECT_DIR, 'twa-manifest.json'));

  const info = await new KeyTool(jdkHelper, log).keyInfo({ path: c.KEYSTORE, alias: c.KEY_ALIAS, password, keypassword: password });
  const sha256 = info.fingerprints.get('SHA256');
  if (!sha256) throw new Error('Could not read the SHA-256 fingerprint of the signing key');
  fs.writeFileSync(path.join(c.ANDROID_DIR, 'assetlinks.json'), DigitalAssetLinks.generateAssetLinks(c.APP.packageId, sha256) + '\n');
  log.info(`Generated ${c.APP.packageId} v${version.name} (code ${version.code}) in ${c.PROJECT_DIR}`);
  log.info(`Signing SHA-256: ${sha256}`);
  return { sha256, version };
}

module.exports = { generate };

if (require.main === module) {
  // Explicit exit: Bubblewrap's fetches leave keep-alive sockets open (e.g. to the live site),
  // which otherwise hold the event loop — and the terminal — open for minutes after the work is done.
  generate().then(() => process.exit(0), c.fail);
}
