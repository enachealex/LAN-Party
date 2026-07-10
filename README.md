# LAN Party

A self-hosted, Discord-style communication app for game nights: servers & channels, text chat with
uploads/GIFs/reactions, peer-to-peer voice & video calls with background effects, screen sharing
("Go Live") with a watch/discover directory, a soundboard, collaborative image editing, and shared
in-call Activities (Watch Together, Whiteboard, Polls, Tic-Tac-Toe).

**Stack:** Node.js (Express + Socket.IO + SQLite) server · React (Vite) client · WebRTC mesh for
calls · optional Electron desktop wrapper and Expo mobile skeleton.

## Features

- **Servers & channels** — create servers and text/voice channels; fully isolated per server.
- **Text chat** — file uploads (auto-expire after 7 days), GIF library + Giphy, custom emojis,
  reactions, edit/delete, right-click collaborative image editing.
- **Voice & video** — P2P mesh calls (DTLS-SRTP encrypted), Teams-style pre-join screen (camera
  preview, background blur/covers/"hide me", mic/speaker pickers, live mic meter), responsive
  gallery grid with paging, deafen, per-device audio selection.
- **Go Live + Discover** — share your screen at a chosen quality; everyone can find live streams
  in the 📡 directory and jump in to watch.
- **Soundboard** — shared clips broadcast to the voice room.
- **Activities** — one shared activity per voice room, auto-synced for everyone: Watch Together
  (synced YouTube), Whiteboard, Quick Poll, Tic-Tac-Toe.

## Run locally

```bash
# 1) server (http://localhost:3000)
cd server && npm install && npm start

# 2) client (http://localhost:5173) — in a second terminal
cd client && npm install && npm run dev
```

Register an account at http://localhost:5173 and you're in. Optional: put a Giphy API key in
`server/giphy.key` (or `GIPHY_API_KEY` env) to enable the Giphy tab.

## Deploy

See **[DEPLOY.md](DEPLOY.md)** — single-origin hosting (the server serves the built client),
Docker/pm2, nginx + HTTPS, and TURN setup for reliable calls across networks.
Device/privacy policy: **[DEVICE-PRIVACY.md](DEVICE-PRIVACY.md)**.

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Express + Socket.IO + SQLite backend (also serves the built client) |
| `client/` | React (Vite) web app |
| `desktop/` | Electron wrapper (scaffold + self-signed code-signing script) |
| `mobile/` | Expo skeleton (future native features, e.g. RTMP streaming) |
| `deploy/` | nginx + coturn example configs |
