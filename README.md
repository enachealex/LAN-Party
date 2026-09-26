# LAN Party

A self-hosted, Discord-style communication app for game nights, live at
**https://lanparty.thejumpvault.com** (landing page at `/`, the app at `/app`).

**Stack:** Node.js (Express + Socket.IO + SQLite) server · React (Vite) client · mediasoup SFU for
calls, with a peer-to-peer WebRTC mesh as the fallback · Electron desktop app for Windows ·
Trusted Web Activity APK for Android.

## Features

- **Servers & channels**: text and voice channels, private channels, owner/admin roles, invites,
  custom server icons.
- **Chat**: file uploads (deleted after 7 days), GIFs (Tenor plus your own library), custom emojis,
  reactions with customizable quick reactions, quoted replies, pins, and edits and deletes that are
  saved and shown to everyone.
- **Friends, DMs and group chats**: friend requests, presence, direct messages and server-backed
  group chats (rename, add people, leave), with your own sections in the conversation list.
- **Voice & video**: SFU calls that scale past a handful of people, a pre-join screen with camera
  preview and background blur/covers (processed on your device), mic/speaker pickers, deafen.
- **Go Live + Discover**: share your screen at a chosen quality; everyone can find live streams in
  the 📡 directory and jump in.
- **Soundboard, entrance sounds, Activities** (Watch Together, Music, Movie Night, Whiteboard,
  Polls, Tic-Tac-Toe) and **collaborative image editing**.
- **Apps directory**: links or uploaded web-app bundles, hosted by LAN Party.
- **Feedback** tab that files tickets in Vaultline, and **Vault Player** single sign-on.

## Run locally

```bash
# 1) server (http://localhost:3000)
cd server && npm install && npm start

# 2) client (http://localhost:5173), in a second terminal
cd client && npm install && npm run dev
```

Register an account at http://localhost:5173 and you're in. Optional integrations read a key file
next to the server or an env var: `server/tenor.key` (`TENOR_API_KEY`) for GIF search,
`youtube.key`, `spotify.key`, `smtp.key`, `vaultline.key`. See [DEPLOY.md](DEPLOY.md).

Checks before shipping:

```bash
cd server && npm run verify   # typecheck + the full test suite
cd client && npm run check    # typecheck
```

## Deploy

**[DEPLOY.md](DEPLOY.md)** covers the production host, routine deploys, schema changes, voice
networking and environment variables. The desktop and Android apps have their own release notes in
[desktop/README.md](desktop/README.md) and [android/README.md](android/README.md).
Device and privacy policy: **[DEVICE-PRIVACY.md](DEVICE-PRIVACY.md)**.

## Repository layout

| Path | What it is |
| --- | --- |
| `server/` | Express + Socket.IO + SQLite backend; also serves the built client and the landing page |
| `client/` | React (Vite) web app, also installable as a PWA |
| `desktop/` | Electron shell for Windows: tray, call overlay, screen-share picker, auto-update |
| `android/` | Bubblewrap Trusted Web Activity that builds the Android APK |
| `deploy/` | Example coturn config, for the optional TURN relay |
| `docs/` | Integration specs (Vault Player SSO) |
