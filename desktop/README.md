# LAN Party — Desktop (Electron)

A thin native shell around the **live hosted app** (`https://lanparty.thejumpvault.com/app/`).
It loads the same origin as the browser and the Android app, so conversations are always in sync
and nothing is stored on the device — an update never risks losing messages.

What the shell adds on top of the web app (`main.js`):

- **Tray**: closing the window hides it to the tray so calls and chat stay connected. Right-click
  the tray icon for *Run in background* and *Start with Windows* (per-machine, in `userData`).
- **Call overlay**: while hidden to the tray, a small transparent always-on-top window keeps
  showing the call video (`overlay-preload.js`, loads `/app/?overlay=1`).
- **Media**: camera, microphone, screen share (`desktopCapturer`), notifications, fullscreen and
  speaker selection — granted to LAN Party's own origin only; sign-in pop-ups and any other
  page get nothing. External links open in the user's browser (web and mail links only).
- **Screen-share picker** (since 1.5.0): Electron has no built-in picker on Windows, so a share
  used to be the primary screen, no questions asked. `picker.html` + `picker.js` (bridge:
  `picker-preload.js`) list screens and app windows with previews that refresh every 3 s;
  Cancel, Escape or closing the window cancels the share. Video only: the web client asks for
  `audio: false`.
- **Auto-update** via `electron-updater` from `https://lanparty.thejumpvault.com/downloads/`.

## Run it

```bash
npm install
npm start      # the live app
npm run dev    # against a local client dev server (http://localhost:5173) — start the server
               # (cd ../server && npm start) and the client (cd ../client && npm run dev) first
```

Since Electron 42 the Electron binary downloads on the first `npm start`, not during `npm install`.

For automated tests, set `LANPARTY_NO_ACTIVATE=1`: the app's windows (including the screen-share
picker) then appear without taking the keyboard focus. Add `--remote-debugging-port=<port>` to
drive the pages over CDP.

## Releasing a new version

1. Bump `version` in `package.json`. The updater compares this against what's installed.
2. `npm run build` — writes `dist/LAN-Party-Setup.exe`, `dist/LAN-Party-Setup.exe.blockmap` and
   `dist/latest.yml`. The file name never changes, so the landing page's download link stays valid.
3. Upload all three to the server's downloads folder, installer first and `latest.yml` **last**
   (installed apps treat a new `latest.yml` as "an update is ready"):

   ```bash
   scp dist/LAN-Party-Setup.exe dist/LAN-Party-Setup.exe.blockmap huckleberry@192.168.1.33:/mnt/data/lan-party/data/downloads/
   scp dist/latest.yml huckleberry@192.168.1.33:/mnt/data/lan-party/data/downloads/
   ```
4. Check the public copy is the new one: the sha512 in
   `https://lanparty.thejumpvault.com/downloads/latest.yml` must match `dist/latest.yml`.

Installed apps check at startup and every 6 hours, download in the background, and offer
"Restart now"; otherwise the update installs when the app quits.

## Auto-update and code signing

Builds are **unsigned**, so Windows SmartScreen warns on a first manual install ("More info →
Run anyway"). Updates after that install quietly.

**Do not set `publisherName` on an unsigned build.** When it is set, electron-updater checks each
downloaded installer's Authenticode signature against that name and rejects anything unsigned —
the update is downloaded, refused and deleted, with the error visible only in a console no one
sees. Every release from 0.1.0 to 1.3.0 shipped that way, so **none of them ever updated**: anyone
on one has to install 1.4.0 manually once (download it from the landing page). From 1.4.0 on,
updates work.

**If you get a real code-signing certificate** (OV or EV, issued to Jump Vault LLC by a trusted CA
such as DigiCert, Sectigo or SSL.com), signing removes the SmartScreen warning for everyone:

1. Point electron-builder at it: `CSC_LINK` (path to the `.pfx`, or the CA's cloud-signing setup)
   and `CSC_KEY_PASSWORD`.
2. Only then add `"signtoolOptions": { "publisherName": "Jump Vault LLC" }` under `build.win`,
   spelled **exactly** like the certificate's subject CN. Updates are then verified against it.
   (Bonus: installs from 1.0.0 onward mostly pin "Jump Vault LLC", so a validly signed update
   would reach them automatically. The earliest 1.0.0 build and 0.1.0 pin "The Jump Vault" and
   need the manual reinstall regardless.)

`scripts/create-cert.ps1` makes a **self-signed** certificate. That's useful for testing signing on
your own machine only: other machines don't trust it, so never combine it with `publisherName` in a
release — every other install would reject the update.
