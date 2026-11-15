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
  - If the home's public IP changes, remote media stops until `SFU_ANNOUNCED_IPS` is updated. The
    server checks for this at boot and every 30 minutes (it asks `cloudflare.com/cdn-cgi/trace`
    what address it is seen from) and logs once, when the two differ:
    `[sfu] the announced public address no longer matches this network's public address; ...`.
    `SFU_ADDRESS_CHECK=0` turns the check off.
  - `mediasoup` is a native module installed on the host. If it's missing, or `SFU_DISABLED=1`,
    every client uses the mesh and nothing breaks.
- **P2P mesh**, the fallback: STUN only in production, so peers on hard NATs can't connect unless
  a TURN relay is added (coturn per `deploy/turnserver.conf.example`, then the `TURN_*` vars).

Until November 2026 **no call ever used the SFU**. The client sent `voice:join` and its first SFU
request back to back; the join read the database before putting the socket in the room, so the SFU
request was handled first, found no room, and was refused, and the client fell back to the mesh.
The server now holds SFU requests until the join is decided, which fixes clients already in the
field too. Expect the media port to carry traffic for the first time: if remote callers go quiet
after this deploy, the port forward or `SFU_ANNOUNCED_IPS` was never right.

A room can mix both kinds. Each client declares its mode (`sfu` or `mesh`) when it joins and when
it changes; two participants connect directly exactly when at least one of them is in mesh mode. A
client still running a build from before this declares nothing: it works with other old builds as
before and with new ones in SFU mode, but **a new client in mesh mode and an old client in SFU mode
cannot hear each other** until the old one reloads.

When someone "cannot hear anyone":

- **In the call**, the dot at the left of the call controls opens the connection details: through
  the voice server or directly, why not the server if not (media port unreachable from their
  network, voice server off, their own "Direct connection only" setting, or the server's refusal),
  and per person the state, the path, and for direct links the ICE candidate type, round trip and
  loss. `window.__lanpartyVoice()` in the browser console returns the same as data.
- **Before a call**, "Check connection" (next to the microphone test, in the pre-join screen and in
  Settings) connects a real transport to the media port over UDP and over TCP, asks STUN for a
  public address, and says whether a TURN relay is configured.
- **On the host**, `pm2 logs` has one line per fallback, e.g.
  `[voice] <socket id> fell back to direct connections (reason: media-unreachable)`. Reasons:
  `media-unreachable` (the port did not answer within 8 s: forwarding, firewall, or a stale
  announced address), `media-lost`, `refused`, `sfu-off` (the worker failed to start),
  `user-choice`, `old-client`.
- `GET /webrtc/diagnostics` (signed in) reports whether the SFU is enabled and usable, its ports,
  whether a public address is announced and whether it has gone stale (`announcedAddressStale`),
  the STUN urls, and whether TURN is configured. No addresses or credentials.
- "Direct connection only (skip the voice server)" in the in-call audio menu is the workaround for
  one person the SFU does not work for; it is per device and off by default.

## Environment variables and key files

Set in `ecosystem.config.cjs` on the host. Integrations also accept a key file in `server/`.

| Var / file | Purpose |
|---|---|
| `JWT_SECRET` | Required. Signs logins; rotating it logs everyone out. It is also what the two-step sign-in secrets are encrypted under, so rotating it locks out every account that has two-step sign-in on: see "Two-step sign-in" below before you do. |
| `PORT`, `DATA_DIR`, `CLIENT_DIST`, `CLIENT_ORIGIN` | `5280`, `/mnt/data/lan-party/data`, `/srv/apps/lan-party/client/dist`, `https://lanparty.thejumpvault.com` |
| `INSTANCE_OWNERS` | Optional. Comma-separated usernames who run the instance; today that means approving uploaded apps for the public app directory. When set and non-empty it replaces the default, which is the oldest account (lowest `users.id`). **The accounts must already exist**, spelled exactly as registered (case matters): a listed name that no account has makes nobody an owner and is logged as a warning at every boot. A listed name is reserved in any capitalisation — it cannot be registered or renamed into — and the list does not follow a rename, so a listed account cannot change its username until this variable is changed (then restart). |
| `PUBLIC_APP_URL` | Public base URL for links the server hands out, e.g. feedback screenshots in Vaultline tickets |
| `SFU_ANNOUNCED_IPS`, `SFU_PORT`, `SFU_DISABLED`, `SFU_ADDRESS_CHECK` | Voice networking, above |
| `STUN_URLS`, `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | ICE servers handed to clients via `/webrtc/ice`; changing them needs no client build |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push (notifications while the app is closed). All optional: with none set, a keypair is generated on first boot and kept in `DATA_DIR/vapid.json`, and the subject is `mailto:admin@<CLIENT_ORIGIN host>`. See below. |
| `LINK_PREVIEWS` | Optional. Set to `0` to stop the server fetching the pages people link to (the preview cards under messages). On when unset. See "Link previews" below. |
| `LINK_PREVIEW_DEBUG` | Optional. Set to anything to log why a link got no preview, or a preview no image: one line with the host name and a short reason code (`[link-preview] no preview: example.com (timeout)`). Never the rest of the URL, and nothing about who posted it. Off when unset. |
| `TENOR_API_KEY` / `tenor.key` | GIF search |
| `YOUTUBE_API_KEY` / `youtube.key` | Watch Together search |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI` / `spotify.key` | Spotify |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_SECURE` / `smtp.key` | Transactional email (shared Gmail SMTP). Whether this is set also decides whether new accounts must verify their email: see "Email verification" below. |
| `vaultline.key` | Feedback → Vaultline, over loopback `:4100` |
| `VAULT_SSO_SECRET` (also `/srv/apps/lan-party/vault-sso.key`) | Vault Player SSO; see [docs/VAULT-PLAYER-INTEGRATION.md](docs/VAULT-PLAYER-INTEGRATION.md) |

Music playback also needs `yt-dlp` on the PATH (`/usr/local/bin/yt-dlp` on the host).

## Two-step sign-in

Optional, per account, turned on by each person in Settings > Security. Nothing to configure, and
no new dependency. After the password, sign-in asks for a code from an authenticator app or one of
the account's ten recovery codes. Sessions that already exist are not affected when someone turns
it on.

- **Someone lost their phone AND their recovery codes.** A password reset does not help (by design:
  a reset link in a stolen mailbox must not be a way in). An **instance owner** (`INSTANCE_OWNERS`,
  or the oldest account) clears it for them: Settings > Security > "Locked-out accounts", or
  `POST /admin/users/<username>/2fa/clear` with the owner's session. The person then signs in with
  their password alone and can set it up again. Make sure the request is really theirs first, by
  some other channel. Every use is written to the server log:
  `[2fa] AUDIT: instance owner "<owner>" cleared two-factor for "<username>" (was on)`.
- **The owner is the one locked out** (or there is no other owner). On the host, with the app
  running or not, using the `sqlite3` CLI or any SQLite client on `DATA_DIR/data.sqlite`:

  ```sql
  DELETE FROM user_two_factor           WHERE user_id = (SELECT id FROM users WHERE username = 'NAME');
  DELETE FROM two_factor_recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = 'NAME');
  DELETE FROM login_tickets             WHERE user_id = (SELECT id FROM users WHERE username = 'NAME');
  ```

  Shell access to the host is the trust boundary here, as it is for everything else on it.
- **What is stored.** `user_two_factor.secret_enc` is the authenticator secret encrypted with
  AES-256-GCM under a key derived from `JWT_SECRET`; recovery codes are stored only as keyed hashes
  (`two_factor_recovery_codes`). A copy of the database without `JWT_SECRET` gives up neither.
- **Rotating `JWT_SECRET`** therefore makes every stored secret unreadable and every recovery code
  unmatchable: those accounts can no longer pass the second step (the log says
  `[2fa] the stored secret for user id N could not be decrypted`). If you must rotate, empty the
  three tables above for everyone (`DELETE FROM user_two_factor;` and so on) as part of the same
  change and tell people to set it up again.
- Wrong codes: five in a row pause that account's second step for five minutes. The pause clears by
  itself; the owner route above also clears it.

## Email verification

A new account is emailed a link (`/app/?verify=...`, good for 24 hours) and, until it is opened,
can sign in and read but cannot post in the public server, send direct messages or friend requests,
create invites, upload files, or start or accept calls.

- **It depends on SMTP being configured.** The server only asks for verification when it has a
  mailer (`SMTP_*` or `server/smtp.key`). The boot log says which:
  `[email] new accounts must verify their email address` or
  `[email] no mailer configured: email verification is not required`. With no mailer every account
  counts as verified, so an instance without email is never locked out of its own features.
- **Existing accounts are not asked.** The migration that adds `users.email_verified` marks every
  account that exists at that moment as verified. Accounts that register while there is no mailer
  are stored as verified too, so setting SMTP up later does not restrict them.
- If SMTP is configured but **broken** (wrong password, provider outage), new accounts cannot
  receive their link and stay restricted until it is fixed; they can ask for the email again from
  the banner or Settings > Security (three an hour per account). To let one through by hand:
  `UPDATE users SET email_verified = 1 WHERE username = 'NAME';`
- Links are built from `PUBLIC_APP_URL`, like the password reset link.

## Push notifications

Standard Web Push, sent straight from the server to each browser's push service (outbound HTTPS to
Google, Mozilla, Apple, Microsoft). No account or API key is involved.

- Needs the `web-push` module, which is a **new runtime dependency**: install it per "Server change"
  above. Without it the server boots normally, logs `[push] web-push is not installed`, and clients
  keep their in-page notifications. With it, the log says `[push] notifications on`.
- `DATA_DIR/vapid.json` (mode 600) is the server's identity to the push services. **Back it up with
  the database and never replace it**: every browser is subscribed against that key, and a new one
  silently orphans them all until each person next opens the app. It lives in `DATA_DIR`, so a
  restore that brings the database back brings the key with it.
- Subscriptions are rows in `push_subscriptions`. A browser that has gone away is removed the first
  time its push service answers 404/410.
- Who is pushed follows each person's notification levels (`notification_settings`): "All
  messages" adds them to every message of a channel, "Nothing" and a muted DM or group take them
  out. A level never widens who MAY be pushed: channel access, blocking and the per-sender push
  allowances are checked the same way at every level.

## Link previews

When a message contains a link, the server fetches that page once and attaches a small card to the
message (`server/services/linkPreview.js`). This is the only place the server makes a request to an
address a member chose, so it is held to rules meant for a server that shares a network with
private services:

- **What is fetched**: `http`/`https` pages on the default port, by DNS name only. Never an IP
  address in any spelling, `localhost`, a single-label or `.local`/`.internal`/`.lan`-style name, a
  URL with credentials, or this instance's own hostnames (the request's `Host`, `CLIENT_ORIGIN`,
  `PUBLIC_APP_URL`).
- **Where it connects**: the name is resolved by the server, and the fetch is refused if **any**
  address it resolves to is not public (loopback, RFC 1918, link-local, CGNAT/Tailscale
  `100.64.0.0/10`, multicast, reserved ranges; for IPv6 anything outside global unicast). The
  connection then goes to the address that was checked, never to a second lookup of the name, so
  DNS rebinding changes nothing. Up to 3 redirects, each checked the same way.
- **YouTube links use oEmbed**: for a video link (`youtube.com/watch?v=`, `youtu.be/<id>`,
  `/shorts/<id>`, also `m.` and `music.`) the watch page is not fetched; it is ~1.5 MB with its
  title past what is read of any page. The server asks `https://www.youtube.com/oembed` about the
  video instead (a small JSON answer, at most 64 KB, by the same rules as any other fetch) and takes
  the title, the uploader and the thumbnail from it. The thumbnail is fetched and checked like any
  other image, and the card still links to the address that was posted.
- **Limits**: 5 s per fetch, 512 KB of HTML read, 2 MB per image, 4 fetches at once, 10 new links
  per person per minute. Results are cached in the `link_previews` table (24 h, or 1 h for a link
  that yielded nothing), so a link is fetched once however often it is posted.
- **What the site sees**: a request from the server's address with a generic `User-Agent`, no
  cookies and no referrer. Nothing identifies the person who posted the link, and readers' browsers
  never contact the site: the card's image is fetched by the server (PNG/JPEG/GIF/WebP only, never
  SVG), stored under `DATA_DIR/link-previews/` by content hash and served from `/link-previews/`
  with the same headers as uploaded files. Images no stored preview refers to are swept after 30 days.
- **Outbound access**: the host needs outbound DNS and HTTP/HTTPS (80/443) for this, which it
  already has. Nothing inbound changes.
- **Turning it off**: `LINK_PREVIEWS=0` and restart. Nothing is fetched from then on; cards already
  attached to messages stay (their images are local files). The log says
  `[link-preview] LINK_PREVIEWS=0: link previews are off`.
- `DATA_DIR/link-previews/` holds at most 512 MB (past that, new cards go without an image until
  the sweep frees room). It is disposable: it does not need backing up, and deleting it only costs
  the images on existing cards.

## Scale

SQLite on local disk means one host, by design. High availability would mean Postgres plus object
storage.
