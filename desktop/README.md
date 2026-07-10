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

## Code signing (self-signed, The Jump Vault)

The app can be digitally signed with a self-signed certificate for **The Jump Vault (thejumpvault.com)**.

1. Generate the certificate (creates `certs/thejumpvault.pfx` + `.cer`, gitignored):
   ```powershell
   ./scripts/create-cert.ps1
   ```
2. Build a **signed** installer (electron-builder reads these env vars):
   ```powershell
   $env:CSC_LINK = "certs/thejumpvault.pfx"
   $env:CSC_KEY_PASSWORD = "<the password you chose>"
   npm run build
   ```
   The build config sets `publisherName: "The Jump Vault"` and RFC-3161 timestamping. Without the
   env vars, builds are unsigned.
3. To trust the signature on a test machine (as Administrator), import the public `.cer` into
   `TrustedPublisher` and `Root` (commands are printed by the script).

Self-signed proves integrity + publisher identity but is **not** trusted by Windows SmartScreen by
default — for warning-free public distribution you'd need a cert from a trusted CA.

## Notes / next steps
- Giphy: uses the **Web JS/React SDK** (not React Native). Key stays server-side via the proxy.
- The app currently expects the server at `localhost:3000`. Bundling/auto-starting the Node
  server inside the packaged app (spawn from `main.js`) is a future step.
- For production hardening, add a Content-Security-Policy that allowlists the server origin
  and `*.giphy.com` (avoid a CSP so strict it blocks Giphy media).
