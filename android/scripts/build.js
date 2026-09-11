// Release build: regenerate the TWA project, `gradlew assembleRelease`, zipalign, then sign with
// apksigner. Output: android/dist/LAN-Party.apk (stable name, so the landing link never changes).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ConsoleLog } = require('@bubblewrap/core');
const { BUILD_TOOLS_VERSION } = require('@bubblewrap/core/dist/lib/androidSdk/AndroidSdkTools');
const c = require('./common');
const { generate } = require('./generate');

// Not Bubblewrap's GradleWrapper: it runs a bare `gradlew.bat` from the project cwd, which cmd.exe
// refuses when NoDefaultCurrentDirectoryInExePath is set (Windows hardening). An absolute path works
// either way. Output streams live (the first run downloads Gradle), and --no-daemon means no Gradle
// process is left running in the background afterwards.
function runGradle(sdk, task) {
  const args = [task, '--no-daemon', '--stacktrace'];
  return new Promise((resolve, reject) => {
    const opts = { cwd: c.PROJECT_DIR, env: sdk.getEnv(), stdio: 'inherit' };
    const child = process.platform === 'win32'
      // .bat files need a shell; one pre-quoted command string (args are fixed literals).
      ? spawn(`"${path.join(c.PROJECT_DIR, 'gradlew.bat')}" ${args.join(' ')}`, { ...opts, shell: true })
      : spawn(path.join(c.PROJECT_DIR, 'gradlew'), args, opts);
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`gradlew ${task} exited with code ${code}`))));
  });
}

// Run an executable directly — argument array, no shell — so paths with spaces need no quoting.
// (Bubblewrap's zipalign/apksigner wrappers build unquoted shell strings, which break on this
// repo's "Communication Tool gpt-free" path.) Resolves with stdout; rejects with a redacted error.
function run(file, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: { ...process.env, ...extraEnv }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0
      ? resolve(stdout)
      : reject(new Error(`${path.basename(file)} exited with code ${code}\n${stderr || stdout}`))));
  });
}

async function build() {
  const log = new ConsoleLog('build');
  const { sha256: fingerprint, version } = await generate();
  const { sdk, config } = await c.tools(log);
  const buildTools = path.join(config.androidSdkPath, 'build-tools', BUILD_TOOLS_VERSION);
  const exe = process.platform === 'win32' ? '.exe' : '';
  const java = path.join(config.jdkPath, 'bin', `java${exe}`);
  const apksignerJar = path.join(buildTools, 'lib', 'apksigner.jar');

  log.info('Running gradlew assembleRelease (the first run downloads Gradle — a few minutes)...');
  await runGradle(sdk, 'assembleRelease');

  const unsigned = path.join(c.PROJECT_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
  if (!fs.existsSync(unsigned)) throw new Error(`Gradle finished but ${unsigned} is missing`);
  fs.mkdirSync(c.DIST_DIR, { recursive: true });
  const aligned = path.join(c.DIST_DIR, 'app-release-aligned.apk');
  const out = path.join(c.DIST_DIR, 'LAN-Party.apk');
  fs.rmSync(aligned, { force: true });
  fs.rmSync(out, { force: true });

  // zipalign must precede signing: v2+ APK signatures cover the aligned bytes.
  await run(path.join(buildTools, `zipalign${exe}`), ['-f', '-p', '4', unsigned, aligned]);
  // The password reaches apksigner via an env var (`env:NAME`), never the command line — so it can't
  // show up in a process listing or in an error message.
  const password = c.readPassword();
  await run(java, ['-jar', apksignerJar, 'sign',
    '--ks', c.KEYSTORE, '--ks-key-alias', c.KEY_ALIAS,
    '--ks-pass', 'env:LANPARTY_KS_PASS', '--key-pass', 'env:LANPARTY_KS_PASS',
    '--out', out, aligned,
  ], { LANPARTY_KS_PASS: password });
  fs.rmSync(aligned, { force: true });
  fs.rmSync(`${out}.idsig`, { force: true }); // v4 sidecar — only used for adb incremental installs

  // Verify what we just produced: the signature checks out and it's signed by OUR key (the one the
  // server's assetlinks.json vouches for). Catches a wrong keystore before anyone installs it.
  const report = await run(java, ['-jar', apksignerJar, 'verify', '--print-certs', out]);
  const digest = (report.match(/SHA-256 digest:\s*([0-9a-f]+)/i) || [])[1];
  const expected = fingerprint.replace(/:/g, '').toLowerCase();
  if (!digest || digest.toLowerCase() !== expected) {
    throw new Error(`Signature check failed: APK cert ${digest || '(none)'} != signing key ${expected}`);
  }

  const bytes = fs.readFileSync(out);
  log.info(`Built ${out}`);
  log.info(`  version ${version.name} (code ${version.code}), ${(bytes.length / 1024).toFixed(0)} KB`);
  log.info(`  file sha256 ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
  log.info(`  signature verified — signed by ${fingerprint}`);
}

build().then(() => process.exit(0), c.fail); // explicit exit — see generate.js
