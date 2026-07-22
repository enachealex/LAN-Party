# Deploying LAN Party

This documents the **actual production setup** for lanparty.thejumpvault.com, plus a short appendix
for standing up a fresh host. The app is one Node (Express + Socket.IO + SQLite) server that also
serves the built React client — everything on one origin.

---

## How production actually runs

| Piece | Reality |
|---|---|
| Host | A home-LAN SBC (`aenache2015`), **not** a cloud VPS |
| App | pm2 process **`lan-party`**, bare Node (`node index.js`), **PORT 5280** |
| Repo on host | `/mnt/retroboard-data/lan-party` |
| Public access | A **Cloudflare tunnel** (pm2 `lanparty-tunnel`) maps `lanparty.thejumpvault.com` → `127.0.0.1:5280`. No nginx, no certbot, no inbound ports — the tunnel is an *outbound* connection, which also means "site up" ≠ "host reachable over SSH" |
| Data | `DATA_DIR=/mnt/retroboard-data/lan-party/data` (SQLite DB + uploads/gifs/sounds/downloads/feedback-media) |
| Client | Built **on the dev machine** and shipped as `client/dist` — the host does not build (its `client/node_modules` has no vite) |
| Landing / app | Landing page at `/`, app at `/app` (client built with `VITE_BASE=/app/`) |
| Desktop feed | electron-updater generic feed at `/downloads/` (serves `DATA_DIR/downloads`) |
| Secrets | Gitignored key files next to the server: `giphy.key`, `youtube.key`, `spotify.key`, `smtp.key`, `vaultline.key` — or the matching env vars |

## Routine deploy (web changes)

Run the gate first, from `server/`:

```bash
npm run verify        # typecheck + full test suite (~5s). Do not deploy red.
```

**Client-only change** (no `server/*.js` touched) — no restart, nobody gets disconnected:

```bash
# dev machine — PowerShell builds because Git Bash mangles VITE_BASE=/app/ into a Windows path
$env:VITE_BASE='/app/'; cd client; npm run build

# ship the dist (from client/dist, Git Bash)
MSYS_NO_PATHCONV=1 tar -czf - . | ssh retroboard \
  'D=/mnt/retroboard-data/lan-party/client/dist; rm -rf "$D"/*; mkdir -p "$D"; tar -C "$D" -xzf -'

ssh retroboard 'cd /mnt/retroboard-data/lan-party && git pull --ff-only origin main'
```

**Server change** — pull, then restart (restart drops live call/voice sockets, so prefer quiet hours):

```bash
ssh retroboard 'cd /mnt/retroboard-data/lan-party && git pull --ff-only origin main && pm2 restart lan-party --update-env'
```

**New server runtime dependency** — the host does NOT reinstall deps on deploy; a new `require`
will crash on restart unless you install first, and order matters:

```bash
ssh retroboard 'cd /mnt/retroboard-data/lan-party && git pull --ff-only origin main \
  && cd server && npm install --omit=dev && node -e "require(\"the-new-dep\")" \
  && pm2 restart lan-party --update-env'
# if the install fails, do NOT restart — the running process keeps serving the old code
```

**Schema change** — add a **new** named migration to `server/db/schema.js` `MIGRATIONS` (never edit
a shipped one; use the `addColumn()` helper for columns). Migrations run once at boot and are
recorded in `schema_migrations`. Back up first:

```bash
ssh retroboard 'cd /mnt/retroboard-data/lan-party && cp data/data.sqlite data/data.sqlite.bak-$(date +%Y%m%d-%H%M%S)'
```

## Desktop installer release (shell changes only)

The Windows app is a thin Electron shell around the live site — web changes reach installed apps on
reload with **no release**. Only changes under `desktop/` need one:

```bash
cd desktop && npm run build     # → dist/LAN-Party-Setup.exe + latest.yml + .blockmap
# upload the .exe and .blockmap BEFORE latest.yml (the feed must never point at a missing file)
scp dist/LAN-Party-Setup.exe dist/LAN-Party-Setup.exe.blockmap retroboard:/mnt/retroboard-data/lan-party/data/downloads/
scp dist/latest.yml retroboard:/mnt/retroboard-data/lan-party/data/downloads/
```

Installed apps auto-update on next startup check.

## Verify after deploying

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://lanparty.thejumpvault.com/        # 200
curl -s https://lanparty.thejumpvault.com/app/ | grep -oE 'assets/index-[^"]*\.js' # new hash?
ssh retroboard 'pm2 logs lan-party --err --lines 5 --nostream'                     # no new errors
```

## Environment variables

Set on the pm2 process (see `pm2 env <id>`); most have key-file fallbacks.

| Var | Prod value / purpose |
|---|---|
| `JWT_SECRET` | required — signing key for logins (rotating logs everyone out) |
| `PORT` | 5280 |
| `DATA_DIR` | `/mnt/retroboard-data/lan-party/data` |
| `CLIENT_DIST` | `/mnt/retroboard-data/lan-party/client/dist` |
| `CLIENT_ORIGIN` | `https://lanparty.thejumpvault.com` |
| `STUN_URLS` / `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` | WebRTC ICE served to clients via `/webrtc/ice` — rotating needs no client rebuild |
| `GIPHY_API_KEY` / `YOUTUBE_API_KEY` / `SPOTIFY_CLIENT_ID`+`SECRET` | optional integrations (or `server/*.key` files) |
| `VAULTLINE_API_KEY` / `VAULTLINE_API_BASE` | feedback forwarding (prod uses `server/vaultline.key` → loopback `http://127.0.0.1:4100`) |
| SMTP: `SMTP_HOST/PORT/USER/PASS/FROM/SECURE` | transactional email (prod uses `server/smtp.key`) |

---

## Appendix: fresh host from scratch

1. Clone; `cd server && npm install --omit=dev`.
2. Build the client somewhere with dev deps: `VITE_BASE=/app/ npm run build` in `client/`.
3. Run: `DATA_DIR=... JWT_SECRET=$(openssl rand -hex 32) PORT=5280 pm2 start index.js --name lan-party`
   then `pm2 save && pm2 startup`.
4. Expose it (either):
   - **Cloudflare tunnel** (what prod does): `cloudflared tunnel` with an ingress rule
     `hostname → http://127.0.0.1:5280`, run under pm2. No inbound firewall holes needed.
   - Classic reverse proxy: nginx + certbot per `deploy/nginx.conf.example` (forwards WebSocket
     upgrade, 100 MB uploads).
5. Music playback needs `yt-dlp` on PATH.

## Voice/video

Two paths, chosen automatically per join:

- **SFU (mediasoup)** — preferred. Each participant uploads their tracks once and the server fans
  them out (O(n) per client), so rooms scale well past the mesh's limit. Media flows over **one
  port, `SFU_PORT` (default 40000, UDP+TCP), NOT the Cloudflare tunnel** — straight to the host.
  - `SFU_ANNOUNCED_IPS` must list the address(es) clients should send media to. **Prod pins it to
    `192.168.1.2`** (the SBC's LAN IP) in `ecosystem.config.cjs` — do NOT rely on auto-detect, which
    would also advertise the unreachable Docker bridge IPs (172.x).
  - **LAN clients work with zero setup.** **Remote clients** additionally need: (a) the public IP
    added to `SFU_ANNOUNCED_IPS`, and (b) UDP **and** TCP port 40000 forwarded on the router to the
    SBC. Until then, remote users transparently fall back to the mesh.
  - `mediasoup` is a native module — `npm install` on the host before restart (it ships a prebuilt
    x86_64 binary; needs python3+make+g++ only if it must build). If it's missing or fails, or you
    set `SFU_DISABLED=1`, the app runs fine and every client uses the mesh.
- **P2P mesh** — the fallback (and what old/other-network clients use). TURN makes it work across
  NATs: coturn per `deploy/turnserver.conf.example` (UDP/TCP 3478 + relay range), then set the
  `TURN_*` vars. Media is peer-to-peer, never transiting the app server or tunnel.

## Scale notes

- SQLite + local disk = single host by design. For HA you'd move to Postgres + object storage.
