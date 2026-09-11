# LAN Party for Android

A **Trusted Web Activity (TWA)** — the Android counterpart of the desktop app's thin Electron shell.
The APK opens the live app (`https://lanparty.thejumpvault.com/app/`) full-screen in Chrome, so it
always runs the latest web version and every conversation stays synced to the server. Built with
Google's [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) library.

## Requirements

- Node 18+, **JDK 17**, and an Android SDK with build-tools `36.1.0` (Android Studio's SDK works).
- Paths are found from `JAVA_HOME` / `ANDROID_HOME`, else `C:\Program Files\Java\jdk-17` and
  `%LOCALAPPDATA%\Android\Sdk`.

## ⚠️ The signing key

`lanparty-release.jks` + its password in `keystore.env` are the app's permanent identity. Android
only installs an update signed with the same key — **lose it and no user can ever update again**.
Both are gitignored. Keep a backup of the `.jks` file and put the password in a password manager.
(The first `npm run build`/`generate` creates the key if it doesn't exist.)

## Cut a release

1. Bump `version` in `android/package.json` (the versionCode is derived: `1.2.3` → `10203`; it must
   go up for Android to accept the update).
2. `npm install` (first time), then `npm run build`. Output: `dist/LAN-Party.apk`, zipaligned, signed,
   and signature-verified against the key.
3. Upload `dist/LAN-Party.apk` to the server's `DATA_DIR/downloads/` — it's served at
   `/downloads/LAN-Party.apk`, which the landing page links to.
4. Check the PUBLIC download is the new build: its sha256 must match `dist/LAN-Party.apk`.
   Cloudflare caches `.apk` files at the edge (`cf-cache-status: HIT`, browsers keep it 4h), so
   right after replacing the file it can still serve the old one — if the hash is stale, purge
   `https://lanparty.thejumpvault.com/downloads/LAN-Party.apk` in the Cloudflare dashboard.

Unlike the desktop app, there's no auto-update feed: the web app itself updates on every deploy, so a
new APK is only needed when the shell changes (name, icon, colors, package settings).

## Full-screen mode (Digital Asset Links)

`npm run generate` writes `assetlinks.json`, which the server serves at
`/.well-known/assetlinks.json`. Chrome checks it to confirm the app and the site belong together;
until it's live, the app still works but shows a URL bar at the top. If the signing key ever changes
(or you add Play Store signing), regenerate and redeploy it.

## Known limitations

- **Screen sharing from the phone** isn't possible (Chrome on Android has no screen-capture API);
  watching others' shares works.
- **Calls may drop or mute when the app is backgrounded** — Chrome can pause the page. Keeping voice
  alive in the background needs a native shell (e.g. Capacitor with a foreground service); that can
  ship later as an in-place update as long as it keeps the same package ID and signing key.
