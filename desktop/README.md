# LAN Party — Desktop (Electron)

Wraps the web client (`../client`) in a native window. Chromium under the hood, so **all
existing web features work unchanged** — including the Giphy library (`@giphy/react-components`
web SDK via the server proxy), WebRTC voice/video, and screen sharing.

## Prerequisites
- Install deps once: `cd desktop && npm install`
- The backend must be reachable at `http://localhost:3000` (run `cd server && npm run start`).

## Run (development)
1. Terminal 1 — server: `cd server && npm run start`
2. Terminal 2 — client dev server: `cd client && npm run dev`  (serves http://localhost:5173)
3. Terminal 3 — desktop: `cd desktop && npm run dev`  (opens Electron pointed at the dev server)

## Run (production-style, against the built client)
1. Build the client: `cd client && npm run build`  (outputs `client/dist`)
2. `cd desktop && npm start`  (loads `../client/dist/index.html` over file://)

## Package installers
`cd desktop && npm run build` (electron-builder) — produces installers per-OS. The built
client from `client/dist` is bundled as an extra resource (`client-dist`).

## Media permissions
`main.js` grants camera / mic / screen-capture and provides a source to `getDisplayMedia`
via `desktopCapturer` (uses the OS picker where supported) so screen sharing works in the app.

## Code signing (Publisher = Jump Vault LLC)

The SmartScreen "Publisher" line comes **only** from the app's Authenticode signature — an unsigned
build always shows "Unknown publisher" no matter what `publisherName` says. To show
**Jump Vault LLC**, the `.exe` must be signed with a certificate whose subject is `Jump Vault LLC`.

**Trusted CA cert (the real fix — shows the publisher for everyone, drops the warning):** buy an OV
or EV code-signing certificate issued to Jump Vault LLC from a trusted CA (DigiCert, Sectigo,
SSL.com…). Then sign as below with that `.pfx` (or the CA's cloud-signing token).

**Self-signed (interim — your own machine only):**
1. Generate the certificate (creates `certs/jumpvaultllc.pfx` + `.cer`, gitignored):
   ```powershell
   ./scripts/create-cert.ps1
   ```
2. Build a **signed** installer (electron-builder reads these env vars):
   ```powershell
   $env:CSC_LINK = "certs/jumpvaultllc.pfx"
   $env:CSC_KEY_PASSWORD = "<the password you chose>"
   npm run build
   ```
   The build config sets `publisherName: "Jump Vault LLC"` and RFC-3161 timestamping. Without the
   env vars, builds are unsigned.
3. To trust the signature on a test machine (as Administrator), import the public `.cer` into
   `TrustedPublisher` and `Root` (commands are printed by the script).

A self-signed cert is **not** trusted by Windows on other machines — they still see "Unknown
publisher." Only a trusted-CA cert removes the warning for everyone.

## Notes / next steps
- Giphy: uses the **Web JS/React SDK** (not React Native). Key stays server-side via the proxy.
- The app currently expects the server at `localhost:3000`. Bundling/auto-starting the Node
  server inside the packaged app (spawn from `main.js`) is a future step.
- For production hardening, add a Content-Security-Policy that allowlists the server origin
  and `*.giphy.com` (avoid a CSP so strict it blocks Giphy media).
