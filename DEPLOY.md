# Deploying LAN Party

How production actually runs at lanparty.thejumpvault.com, and how to ship to it. It is one Node
server (Express + Socket.IO + SQLite) that also serves the built React client, all on one origin.

The host is shared with other services. Read `HOMELAB-SERVER.md` (in the GitHub folder next to this
repo, and at `/srv/apps/README.md` on the box) before changing anything outside `/srv/apps/lan-party`:
it has the storage layout, the port map, and the network incidents behind the rules below.

---

## Production at a glance

| Piece | Where |
|---|---|
| Host | `huckleberry` on the home LAN, `192.168.1.33` (static). SSH over the LAN only: `ssh -i ~/.ssh/id_ed25519 huckleberry@192.168.1.33`. The old SBC (`192.168.1.2`) is retired. |
| Code | `/srv/apps/lan-party` (a git checkout of `main`) |
| App | pm2 process **`lan-party`**, started from the host-only `ecosystem.config.cjs` (gitignored; holds the env, secrets included), on port **5280** (all interfaces, so the LAN can reach it directly) |
| Data | `DATA_DIR=/mnt/data/lan-party/data`: SQLite DB, uploads, avatars, sounds, GIFs, app bundles, `downloads/` (desktop feed + APK), feedback media |
| Backups | `/mnt/data/lan-party/backups` (release backups); DB snapshots sit beside the DB as `data.sqlite.bak-*` |
| Public access | pm2 **`lanparty-tunnel`**, a Cloudflare tunnel (`~/.cloudflared/lanparty.yml`) mapping `lanparty.thejumpvault.com` → `127.0.0.1:5280`. No inbound ports for the web. A tunnel UUID must run on exactly one machine. |
| Client | Built on the dev machine and shipped as `client/dist`; the host never builds it |
| Paths | Landing page at `/`, the app at `/app` (client built with `VITE_BASE=/app/`), desktop feed at `/downloads/` |

## Before any deploy

```bash
cd server && npm run verify    # typecheck + full test suite. Do not deploy red.
cd client && npm run check     # typecheck
```

Commit and push to `main` first: the host deploys by `git pull`. Nothing deploys on push.

**Quoting tip:** PowerShell → ssh → bash mangles quotes (SQL especially). Write anything non-trivial
as a script locally, `scp` it to `/tmp`, run it with `bash`, then delete it.

## Client-only change

No restart, so nobody's call drops. Build with PowerShell, since Git Bash rewrites `/app/` into a
Windows path:

```powershell
cd client; $env:VITE_BASE='/app/'; npm run build   # dist/index.html must reference /app/assets/…
```

Ship it into place atomically (from `client/dist`, in Git Bash):

```bash
MSYS_NO_PATHCONV=1 tar -czf - . | ssh -i ~/.ssh/id_ed25519 huckleberry@192.168.1.33 \
  'cd /srv/apps/lan-party/client && rm -rf dist.new && mkdir dist.new && tar -C dist.new -xzf - \
   && rm -rf dist.old && mv dist dist.old && mv dist.new dist'
```

`dist.old` is the instant rollback (swap it back). The build stamps its version (`git sha + date`,
with `+dirty` for uncommitted changes), which Settings → Feedback reports.

## Server change

```bash
ssh -i ~/.ssh/id_ed25519 huckleberry@192.168.1.33 \
  'cd /srv/apps/lan-party && git pull --ff-only origin main && pm2 restart lan-party'
```

A restart drops live voice and socket connections for a few seconds, so prefer quiet hours.

**New runtime dependency:** the host does not reinstall on deploy, and a missing `require` crashes
on restart. Install first, prove it loads, then restart. If the install fails, don't restart: the
running process keeps serving the old code.

```bash
cd /srv/apps/lan-party/server && npm install --omit=dev && node -e "require('the-new-dep')" && pm2 restart lan-party
```

**Env change:** edit `ecosystem.config.cjs` on the host (back it up first), then
`pm2 restart ecosystem.config.cjs --update-env`.

## Schema change

Append a **new** named migration to `MIGRATIONS` in `server/db/schema.js`. Never edit one that has
shipped; use the `addColumn()` helper for columns. Migrations run once at boot and are recorded in
`schema_migrations`.

Back up the DB before pulling. `VACUUM INTO` takes a consistent copy while the app keeps running:

```bash
cd /srv/apps/lan-party/server && node -e '
  const s = require("sqlite3"); const db = new s.Database(process.argv[1], s.OPEN_READONLY);
  db.run("VACUUM INTO ?", process.argv[2], (e) => { if (e) { console.error(e.message); process.exit(1) } db.close() })' \
  /mnt/data/lan-party/data/data.sqlite /mnt/data/lan-party/data/data.sqlite.bak-$(date +%Y%m%d-%H%M%S)
```

After the restart, check the migration is listed in `schema_migrations` and that per-table
`count(*)` matches before and after. A 200 is not proof on this box.

## Verify from the outside

Always through the **public hostname**, never only `127.0.0.1:5280` (a whole deploy once went to the
retired box and "passed" on localhost):

```bash
curl -s https://lanparty.thejumpvault.com/app/ | grep -oE '/app/assets/index-[^"]*\.js'   # the new hash
ssh … 'pm2 logs lan-party --err --lines 20 --nostream'                                    # no new errors
```

If the public site is slow from home, look at the `cf-ray` header's suffix before suspecting the app.
This free-plan zone is served from Cloudflare's PDX or ATL data centres, and PDX → the home ISP is
sometimes very slow (seen 2026-09-26: 5–30 KB/s even for cached files). Also check the box's link:
`cat /sys/class/net/enp42s0/speed` should say `1000`.

## Desktop and Android releases

Web changes reach installed apps on their next load; nothing to release. Only changes under
`desktop/` or `android/` need one:

- **Windows:** [desktop/README.md](desktop/README.md). Upload the installer and blockmap first and
  `latest.yml` last, into `/mnt/data/lan-party/data/downloads/`. Never set `publisherName` on an
  unsigned build (it silently broke every update before 1.4.0).
- **Android:** [android/README.md](android/README.md). The signing key cannot be replaced; losing it
  means users must uninstall to update.

Leave `/downloads` cacheable. Marked `private`, every request (even a partial or abandoned one)
pulled the whole installer through the home uplink.

## Voice and video

Chosen automatically per join:

- **SFU (mediasoup)**, preferred: everyone uploads once and the server forwards. Media does **not**
  use the tunnel; it goes straight to the host on its own ports:
  - `SFU_ANNOUNCED_IPS='<public IP>,192.168.1.33'`, **public address first**. The i-th address is
    bound to `SFU_PORT + i`: remote clients use **40000** (UDP+TCP, forwarded on the router to
    `.33`), LAN clients use **40001** directly. `ufw` allows both. Never rely on auto-detect, which
    would also advertise Docker bridge addresses.
  - If the home's public IP changes, remote media stops until `SFU_ANNOUNCED_IPS` is updated.
  - `mediasoup` is a native module installed on the host. If it's missing, or `SFU_DISABLED=1`,
    every client uses the mesh and nothing breaks.
- **P2P mesh**, the fallback: STUN only in production, so peers on hard NATs can't connect unless
  a TURN relay is added (coturn per `deploy/turnserver.conf.example`, then the `TURN_*` vars).

## Environment variables and key files

Set in `ecosystem.config.cjs` on the host. Integrations also accept a key file in `server/`.

| Var / file | Purpose |
|---|---|
| `JWT_SECRET` | Required. Signs logins; rotating it logs everyone out. |
| `PORT`, `DATA_DIR`, `CLIENT_DIST`, `CLIENT_ORIGIN` | `5280`, `/mnt/data/lan-party/data`, `/srv/apps/lan-party/client/dist`, `https://lanparty.thejumpvault.com` |
| `PUBLIC_APP_URL` | Public base URL for links the server hands out, e.g. feedback screenshots in Vaultline tickets |
| `SFU_ANNOUNCED_IPS`, `SFU_PORT`, `SFU_DISABLED` | Voice networking, above |
| `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | ICE servers handed to clients via `/webrtc/ice`; changing them needs no client build |
| `TENOR_API_KEY` / `tenor.key` | GIF search |
| `YOUTUBE_API_KEY` / `youtube.key` | Watch Together search |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` / `spotify.key` | Spotify |
| `smtp.key` | Transactional email (shared Gmail SMTP) |
| `vaultline.key` | Feedback → Vaultline, over loopback `:4100` |
| `VAULT_SSO_SECRET` (also `/srv/apps/lan-party/vault-sso.key`) | Vault Player SSO; see [docs/VAULT-PLAYER-INTEGRATION.md](docs/VAULT-PLAYER-INTEGRATION.md) |

Music playback also needs `yt-dlp` on the PATH (`/usr/local/bin/yt-dlp` on the host).

## Scale

SQLite on local disk means one host, by design. High availability would mean Postgres plus object
storage.
