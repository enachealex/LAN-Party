# Deploying to lanparty.thejumpvault.com

The app is a **Node (Express + Socket.IO + SQLite) server** that also **serves the built React client**, so everything runs on **one origin** behind an HTTPS reverse proxy. This guide targets your own VPS.

> **HTTPS is mandatory.** Camera, microphone, screen share (`getUserMedia`/`getDisplayMedia`) and the PWA service worker only work in a secure context. Serve the site over `https://` (steps below).

---

## 0. DNS
Point an A/AAAA record for `lanparty.thejumpvault.com` at your VPS's public IP. (If the subdomain answers with a 403/default page before the app is wired up, that's just the web server's placeholder — the nginx step below points it at the app.)

---

## 1. Environment variables

| Var | Required | Purpose |
| --- | --- | --- |
| `JWT_SECRET` | **yes** | Long random string used to sign login tokens. Changing it logs everyone out. |
| `PORT` | no (3000) | Port the Node server listens on (behind nginx). |
| `DATA_DIR` | recommended | Folder for `data.sqlite` + `uploads/` `gifs/` `sounds/`. Put this on a **persistent** disk/volume. |
| `CLIENT_DIST` | auto | Path to the built client. Set by the Dockerfile; for bare Node it defaults to `../client/dist`. |
| `CLIENT_ORIGIN` | recommended | Allowed origin(s) for CORS/WebSockets, e.g. `https://lanparty.thejumpvault.com`. Defaults to `*`. |
| `STUN_URLS` | no | Comma-separated STUN URLs (default `stun:stun.l.google.com:19302`). |
| `TURN_URLS` | **for reliable calls** | Comma-separated TURN URLs, e.g. `turn:lanparty.thejumpvault.com:3478,turns:lanparty.thejumpvault.com:5349`. |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | with TURN | TURN credentials. |
| `GIPHY_API_KEY` | no | Enables the Giphy tab (or drop a `server/giphy.key` file). |
| `YOUTUBE_API_KEY` | for Music | Enables Music activity search (or drop a `server/youtube.key` file). Playback also needs `yt-dlp` on PATH — the Dockerfile installs it. |

Generate a secret: `openssl rand -hex 32`.

---

## 2A. Run with Docker (recommended)

```bash
git clone <your repo> && cd "Communication Tool gpt-free"
printf 'JWT_SECRET=%s\nCLIENT_ORIGIN=https://lanparty.thejumpvault.com\n' "$(openssl rand -hex 32)" > .env
# (add TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL to .env once TURN is set up — step 4)
docker compose up -d --build
```
The app now listens on `127.0.0.1:3000`. Data persists in the `appdata` Docker volume.

## 2B. Run with bare Node + pm2 (alternative)

```bash
# build the client (served by the server)
cd client && npm ci && VITE_BASE=/ npm run build && cd ..
# run the server
cd server && npm ci --omit=dev
DATA_DIR=/var/lib/lanparty CLIENT_ORIGIN=https://lanparty.thejumpvault.com \
JWT_SECRET=$(openssl rand -hex 32) pm2 start index.js --name lanparty
pm2 save && pm2 startup   # run the printed command to survive reboots
```

---

## 3. nginx + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/lanparty
sudo ln -s /etc/nginx/sites-available/lanparty /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d lanparty.thejumpvault.com   # adds the 443 block + auto-renew
```
The nginx config already forwards the **WebSocket upgrade** (needed for voice signalling/chat) and allows **100 MB uploads**.

---

## 4. TURN server (so calls connect across networks)

Voice/video uses a peer-to-peer mesh. STUN alone fails behind many home routers, so run **coturn**:

```bash
sudo apt-get install -y coturn
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo cp deploy/turnserver.conf.example /etc/turnserver.conf   # edit YOUR_PUBLIC_IP + the secret
sudo systemctl enable --now coturn
```
Open UDP/TCP **3478** and **5349**, plus UDP **49152–65535**, in your firewall/security group. Then set in the app's env:
```
TURN_URLS=turn:lanparty.thejumpvault.com:3478,turns:lanparty.thejumpvault.com:5349
TURN_USERNAME=lanparty
TURN_CREDENTIAL=<the secret from turnserver.conf>
```
Restart the app. The client fetches these from `/webrtc/ice`, so no rebuild is needed to rotate them.

Prefer not to self-host TURN? Use a managed service (Cloudflare Calls, Twilio, Metered) and just fill in the `TURN_*` vars.

---

## 5. Verify
- `https://lanparty.thejumpvault.com` loads the app (padlock = valid TLS).
- Register/login works; refresh keeps you signed in.
- Two people on **different networks** can join a voice channel and hear/see each other (this is the TURN test).
- Upload a file, use GIFs/soundboard, start an Activity — all persist across a redeploy (thanks to `DATA_DIR`).

## Scale notes
- The WebRTC mesh is designed for **small calls** (a handful of people each). It's not an SFU; very large calls would need one.
- SQLite + local disk = single server. Fine for this scale; for HA you'd move to Postgres + object storage.
