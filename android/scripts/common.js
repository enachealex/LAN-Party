// Shared paths and config for the LAN Party Android (TWA) build scripts.
const fs = require('fs');
const path = require('path');
const { Config, JdkHelper, AndroidSdkTools } = require('@bubblewrap/core');
const { BUILD_TOOLS_VERSION } = require('@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools');

const ANDROID_DIR = path.join(__dirname, '..');
const REPO_DIR = path.join(ANDROID_DIR, '..');
const PROJECT_DIR = path.join(ANDROID_DIR, 'twa'); // generated Gradle project — gitignored, rebuilt each time
const DIST_DIR = path.join(ANDROID_DIR, 'dist'); // signed APK lands here — gitignored
// The signing key IS the app's identity: Android only installs an update if it's signed with the same
// key. Losing it means no user can ever update again. Both files are gitignored — back them up.
const KEYSTORE = path.join(ANDROID_DIR, 'lanparty-release.jks');
const KEYSTORE_ENV = path.join(ANDROID_DIR, 'keystore.env');
const KEY_ALIAS = 'lanparty';

const APP = {
  packageId: 'com.thejumpvault.lanparty', // permanent — changing it forces every user to reinstall
  host: 'lanparty.thejumpvault.com',
  startUrl: '/app/',
  webManifestUrl: 'https://lanparty.thejumpvault.com/app/manifest.webmanifest',
};

function resolveJdk() {
  if (process.env.JAVA_HOME) return process.env.JAVA_HOME;
  return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Java', 'jdk-17');
}

function resolveSdk() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
}

// Windows: Bubblewrap prepends the JDK to env['Path'] on a plain copy of process.env, but the
// variable can be enumerated as 'PATH' (e.g. under Git Bash). The child then gets both keys, the
// wrong one wins, and bare `keytool` isn't found. Collapse to the single key Bubblewrap expects.
function normalizeWindowsPath(jdkBin) {
  if (process.platform !== 'win32') return;
  const keys = Object.keys(process.env).filter((k) => k.toLowerCase() === 'path');
  const value = [jdkBin, ...keys.map((k) => process.env[k])].filter(Boolean).join(';');
  for (const k of keys) delete process.env[k];
  process.env.Path = value;
}

// Passwords end up on keytool/apksigner command lines, and a failed command echoes its command
// line in the error. Anything registered here is scrubbed from error output.
const secrets = new Set();
function registerSecret(value) { if (value) secrets.add(value); return value; }
function redact(text) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}
// Top-level error handler for the scripts: print a redacted error and exit non-zero.
function fail(err) {
  console.error(redact(require('util').inspect(err, { depth: 4 })));
  process.exit(1);
}

// Bubblewrap tool wrappers built from an in-process Config, so nothing is written to ~/.bubblewrap.
async function tools(log) {
  const config = new Config(resolveJdk(), resolveSdk());
  (await JdkHelper.validatePath(config.jdkPath)).unwrap();
  normalizeWindowsPath(path.join(config.jdkPath, 'bin'));
  const jdkHelper = new JdkHelper(process, config);
  // Not AndroidSdkTools.create(): its path check wants a standalone-SDK `tools/` or `bin/` folder,
  // which an Android Studio SDK doesn't have. What the build actually needs is the pinned
  // build-tools (zipalign + apksigner), so check for exactly that instead.
  const sdk = new AndroidSdkTools(process, config, jdkHelper, log);
  if (!(await sdk.checkBuildTools())) {
    throw new Error(`Android build-tools ${BUILD_TOOLS_VERSION} not found in ${config.androidSdkPath} — install it via Android Studio's SDK Manager`);
  }
  return { config, jdkHelper, sdk };
}

// Keystore password: LANPARTY_KEYSTORE_PASSWORD env var wins, else android/keystore.env.
function readPassword() {
  if (process.env.LANPARTY_KEYSTORE_PASSWORD) return registerSecret(process.env.LANPARTY_KEYSTORE_PASSWORD);
  if (!fs.existsSync(KEYSTORE_ENV)) throw new Error(`No keystore password: set LANPARTY_KEYSTORE_PASSWORD or create ${KEYSTORE_ENV}`);
  const m = fs.readFileSync(KEYSTORE_ENV, 'utf8').match(/^LANPARTY_KEYSTORE_PASSWORD=(.+)$/m);
  if (!m) throw new Error(`${KEYSTORE_ENV} has no LANPARTY_KEYSTORE_PASSWORD line`);
  return registerSecret(m[1].trim());
}

// android/package.json "version" drives the app version. versionCode must strictly increase for
// Android to accept an update, so it's derived from the semver: 1.2.3 -> 10203.
function appVersion() {
  const name = require('../package.json').version;
  const [major, minor, patch] = name.split('.').map((n) => parseInt(n, 10) || 0);
  return { name, code: major * 10000 + minor * 100 + patch };
}

module.exports = { ANDROID_DIR, REPO_DIR, PROJECT_DIR, DIST_DIR, KEYSTORE, KEYSTORE_ENV, KEY_ALIAS, APP, tools, readPassword, appVersion, registerSecret, fail };
