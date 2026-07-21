// Media proxies: the Giphy search proxy, YouTube search + yt-dlp audio streaming, saved playlists,
// and the Spotify OAuth + search flow. API keys stay server-side (env vars or server/*.key files);
// clients only ever see proxied results.
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const SERVER_DIR = path.join(__dirname, '..'); // *.key files live in server/, not server/routes/

/** @param {{ app: any, db: any, authMiddleware: any, io: any, JWT_SECRET: string }} deps */
function registerMediaRoutes({ app, db, authMiddleware, io, JWT_SECRET }) {
  // --- Giphy proxy ---
  // The Giphy API key comes from the GIPHY_API_KEY env var, or a `server/giphy.key` file.
  // The key stays server-side; clients only see the proxied results.
  function getGiphyKey() {
    if (process.env.GIPHY_API_KEY && process.env.GIPHY_API_KEY.trim()) return process.env.GIPHY_API_KEY.trim();
    try { return fs.readFileSync(path.join(SERVER_DIR, 'giphy.key'), 'utf8').trim(); } catch { return ''; }
  }

  app.get('/giphy/status', authMiddleware, (req, res) => res.json({ configured: !!getGiphyKey() }));

  // Trending + search return Giphy's raw { data, pagination, meta } so the client SDK <Grid>
  // (fed via this proxy) can render + paginate. offset/limit drive infinite scroll.
  async function proxyGiphy(res, endpoint, params) {
    const key = getGiphyKey();
    if (!key) return res.status(503).json({ error: 'Giphy is not configured', configured: false });
    const qs = new URLSearchParams({ api_key: key, rating: 'pg-13', ...params }).toString();
    try {
      const r = await fetch(`https://api.giphy.com/v1/gifs/${endpoint}?${qs}`);
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data?.meta?.msg || 'Giphy error' });
      return res.json({ data: data.data || [], pagination: data.pagination || {}, meta: data.meta || {} });
    } catch (err) {
      return res.status(502).json({ error: 'Giphy request failed' });
    }
  }

  app.get('/giphy/trending', authMiddleware, async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    return proxyGiphy(res, 'trending', { limit, offset });
  });

  app.get('/giphy/search', authMiddleware, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.json({ data: [], pagination: { total_count: 0, count: 0, offset: 0 } });
    const limit = Math.min(parseInt(req.query.limit, 10) || 24, 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    return proxyGiphy(res, 'search', { q, limit, offset, lang: 'en' });
  });

  // --- Music (YouTube) — ported from DiscordMusicActivity ---
  // Search uses the YouTube Data API (key from YOUTUBE_API_KEY env or `server/youtube.key`).
  // Playback: yt-dlp resolves a signed audio-only URL (cached ~55 min) which we proxy as a
  // Range-capable stream, so every participant plays the same audio via a plain <audio> tag.
  const { spawn } = require('child_process');
  function getYoutubeKey() {
    if (process.env.YOUTUBE_API_KEY && process.env.YOUTUBE_API_KEY.trim()) return process.env.YOUTUBE_API_KEY.trim();
    try { return fs.readFileSync(path.join(SERVER_DIR, 'youtube.key'), 'utf8').trim(); } catch { return ''; }
  }
  const decodeHtml = (s) => String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const AUDIO_URL_TTL_MS = 55 * 60 * 1000; // YouTube signed URLs last ~6h; 55 min is a safe reuse window
  const audioUrlCache = new Map();          // videoId -> { audioUrl, expiresAt }
  const inflightAudioResolves = new Map();  // videoId -> Promise (dedupe concurrent yt-dlp runs)
  const MAX_CONCURRENT_YTDLP = 4;
  let activeYtdlp = 0;
  const ytdlpQueue = [];
  const acquireYtdlp = () => new Promise((resolve) => {
    if (activeYtdlp < MAX_CONCURRENT_YTDLP) { activeYtdlp++; resolve(); } else ytdlpQueue.push(resolve);
  });
  const releaseYtdlp = () => { const next = ytdlpQueue.shift(); if (next) next(); else activeYtdlp--; };

  function resolveAudioUrl(videoId) {
    const cached = audioUrlCache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve({ audioUrl: cached.audioUrl, fromCache: true });
    if (cached) audioUrlCache.delete(videoId);
    const inflight = inflightAudioResolves.get(videoId);
    if (inflight) return inflight;
    const p = (async () => {
      await acquireYtdlp();
      try {
        const ytdlp = spawn('yt-dlp', [
          // Highest-bitrate audio-only stream; opus/m4a both play in browsers.
          '-f', 'bestaudio[acodec=opus]/bestaudio[ext=m4a]/bestaudio',
          '-S', 'acodec:opus,abr,asr',
          '--no-playlist', '--no-warnings', '-g',
          `https://www.youtube.com/watch?v=${videoId}`,
        ]);
        let out = '', errOut = '';
        ytdlp.stdout.on('data', (c) => { out += c.toString(); });
        ytdlp.stderr.on('data', (c) => { errOut += c.toString(); });
        const code = await new Promise((resolve, reject) => { ytdlp.once('error', reject); ytdlp.once('close', resolve); });
        const audioUrl = out.trim();
        if (code !== 0 || !audioUrl) { const e = new Error('Failed to get audio URL'); e.details = errOut; throw e; }
        audioUrlCache.set(videoId, { audioUrl, expiresAt: Date.now() + AUDIO_URL_TTL_MS });
        if (audioUrlCache.size > 500) {
          for (const [k, v] of audioUrlCache) if (v.expiresAt <= Date.now()) audioUrlCache.delete(k);
        }
        return { audioUrl, fromCache: false };
      } finally { releaseYtdlp(); }
    })().finally(() => inflightAudioResolves.delete(videoId));
    inflightAudioResolves.set(videoId, p);
    return p;
  }

  // Best-effort pre-resolve of the next few queued tracks so skips start instantly.
  function warmMusicQueue(queue, currentIndex, count = 3) {
    if (!Array.isArray(queue) || !queue.length) return;
    const idx = Number.isFinite(Number(currentIndex)) ? Number(currentIndex) : -1;
    const start = Math.max(0, idx + 1);
    for (const t of queue.slice(start, start + count)) {
      if (t && t.id && t.service !== 'spotify') resolveAudioUrl(t.id).catch(() => {}); // yt-dlp is YouTube-only
    }
  }

  // Pull a video id out of any common YouTube URL form (watch/shorts/embed/youtu.be/music.).
  function extractYouTubeId(input) {
    const text = String(input || '').trim();
    if (!/youtu\.?be/i.test(text)) return null;
    let url;
    try { url = new URL(text.startsWith('http') ? text : `https://${text}`); } catch { return null; }
    const host = url.hostname.replace(/^www\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      id = url.searchParams.get('v');
      if (!id) { const m = /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(url.pathname); if (m) id = m[1]; }
    }
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  }

  app.get('/music/status', authMiddleware, (req, res) => res.json({ configured: !!getYoutubeKey() }));

  app.get('/music/search', authMiddleware, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'Query required' });
    const key = getYoutubeKey();
    if (!key) return res.status(503).json({ error: 'Music search is not configured', configured: false });
    try {
      // A pasted YouTube URL resolves that exact video instead of searching.
      const pastedId = extractYouTubeId(q);
      if (pastedId) {
        const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'snippet', id: pastedId, key })}`);
        const data = await r.json();
        const item = data.items && data.items[0];
        if (!item) return res.json([]);
        return res.json([{
          id: pastedId,
          title: decodeHtml(item.snippet.title),
          artist: decodeHtml(item.snippet.channelTitle),
          thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
        }]);
      }
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({
        part: 'snippet', q, type: 'video', videoCategoryId: '10', maxResults: '10', key,
      })}`);
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: data?.error?.message || 'YouTube search failed' });
      return res.json((data.items || []).map((item) => ({
        id: item.id.videoId,
        title: decodeHtml(item.snippet.title),
        artist: decodeHtml(item.snippet.channelTitle),
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || '',
      })));
    } catch (err) {
      console.error('Music search error:', err.message);
      return res.status(500).json({ error: 'YouTube search failed' });
    }
  });

  // --- Music playlists: save the queue, load it back later (per user) ---
  app.get('/music/playlists', authMiddleware, async (req, res) => {
    const rows = await db.all('SELECT id, name, tracks_json, updated_at FROM music_playlists WHERE username = ? ORDER BY updated_at DESC', req.user.username);
    return res.json({ playlists: rows.map((r) => { let n = 0; try { n = JSON.parse(r.tracks_json).length; } catch {} return { id: r.id, name: r.name, count: n, updatedAt: r.updated_at }; }) });
  });

  app.post('/music/playlists', authMiddleware, async (req, res) => {
    const name = String((req.body || {}).name || '').trim().slice(0, 40);
    const tracks = (Array.isArray((req.body || {}).tracks) ? req.body.tracks : []).filter(musicTrackValid).slice(0, 200).map(musicTrackClean);
    if (!name) return res.status(400).json({ error: 'Playlist name required' });
    if (!tracks.length) return res.status(400).json({ error: 'Nothing to save — the queue is empty' });
    const me = req.user.username;
    const existing = await db.get('SELECT id FROM music_playlists WHERE username = ? AND name = ?', me, name);
    if (existing) {
      await db.run('UPDATE music_playlists SET tracks_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(tracks), Date.now(), existing.id);
      return res.json({ playlist: { id: existing.id, name, count: tracks.length, updated: true } });
    }
    const r = await db.run('INSERT INTO music_playlists (username, name, tracks_json, updated_at) VALUES (?, ?, ?, ?)', me, name, JSON.stringify(tracks), Date.now());
    return res.json({ playlist: { id: r.lastID, name, count: tracks.length } });
  });

  app.get('/music/playlists/:id', authMiddleware, async (req, res) => {
    const row = await db.get('SELECT id, name, tracks_json FROM music_playlists WHERE id = ? AND username = ?', req.params.id, req.user.username);
    if (!row) return res.status(404).json({ error: 'Playlist not found' });
    let tracks = [];
    try { tracks = JSON.parse(row.tracks_json); } catch {}
    return res.json({ playlist: { id: row.id, name: row.name, tracks } });
  });

  app.delete('/music/playlists/:id', authMiddleware, async (req, res) => {
    const r = await db.run('DELETE FROM music_playlists WHERE id = ? AND username = ?', req.params.id, req.user.username);
    if (!r.changes) return res.status(404).json({ error: 'Playlist not found' });
    return res.json({ success: true });
  });

  // --- Spotify (ported from DiscordMusicActivity) ---
  // Per-user OAuth for the Web Playback SDK: the client opens /music/spotify/login-url in a popup,
  // Spotify redirects to /callback here, and the tokens go back via postMessage + the user's socket
  // room. Tokens live only in that user's browser — the server never stores them.
  function getSpotifyCreds() {
    if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
      return { client_id: process.env.SPOTIFY_CLIENT_ID.trim(), client_secret: process.env.SPOTIFY_CLIENT_SECRET.trim() };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'spotify.key'), 'utf8'));
      if (parsed.client_id && parsed.client_secret) return parsed;
    } catch { /* not configured */ }
    return null;
  }
  const SPOTIFY_SCOPES = ['streaming', 'user-read-email', 'user-read-private', 'user-read-playback-state', 'user-modify-playback-state'].join(' ');
  // The redirect URI must EXACTLY match one registered in the Spotify dashboard. Env override wins;
  // otherwise it's this server's own origin + /callback (single-origin prod = the site domain).
  function spotifyRedirectUri(req) {
    if (process.env.SPOTIFY_REDIRECT_URI && process.env.SPOTIFY_REDIRECT_URI.trim()) return process.env.SPOTIFY_REDIRECT_URI.trim();
    return `${req.protocol}://${req.get('host')}/callback`;
  }

  app.get('/music/spotify/status', authMiddleware, (req, res) => res.json({ configured: !!getSpotifyCreds() }));

  app.get('/music/spotify/login-url', authMiddleware, (req, res) => {
    const creds = getSpotifyCreds();
    if (!creds) return res.status(503).json({ error: 'Spotify is not configured' });
    // state carries who asked + which origin the popup should postMessage back to.
    const clientOrigin = String(req.query.client_origin || '').slice(0, 200);
    const state = Buffer.from(JSON.stringify({ u: req.user.username, o: clientOrigin })).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: creds.client_id,
      scope: SPOTIFY_SCOPES,
      redirect_uri: spotifyRedirectUri(req),
      state,
    });
    return res.json({ url: `https://accounts.spotify.com/authorize?${params}`, redirectUri: spotifyRedirectUri(req) });
  });

  // OAuth callback — hit by Spotify's redirect (no app auth possible here; identity comes from state).
  app.get('/callback', async (req, res) => {
    const creds = getSpotifyCreds();
    const { code, state, error } = req.query;
    let username = '', clientOrigin = '';
    try {
      const parsed = JSON.parse(Buffer.from(String(state || ''), 'base64url').toString('utf8'));
      username = String(parsed.u || ''); clientOrigin = String(parsed.o || '');
    } catch { /* bad state — fall through to error page */ }
    // This page is built from OAuth-flow inputs, so nothing untrusted is interpolated raw: the
    // status line is a fixed string, and the token payload is embedded through a script-safe
    // JSON encoder. The postMessage target is only used if `clientOrigin` is a valid http(s) origin.
    const page = (body) => res.send(`<!DOCTYPE html><html><head><title>Spotify</title><style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#121212;color:#fff}</style></head><body>${body}</body></html>`);
    // JSON safe to embed inside a <script>: neutralize </script>, HTML-comment, and line-sep sequences.
    const jsonForScript = (v) => JSON.stringify(v)
      .replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    let safeOrigin = '*';
    try { safeOrigin = new URL(clientOrigin).origin === clientOrigin && /^https?:$/.test(new URL(clientOrigin).protocol) ? clientOrigin : '*'; } catch { safeOrigin = '*'; }
    if (error || !code || !creds) return page('<p>Spotify connection failed. You can close this window and try again.</p>');
    try {
      const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: String(code), redirect_uri: spotifyRedirectUri(req) }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error_description || 'token exchange failed');
      const payload = { type: 'spotify-auth', access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in };
      // Primary delivery is the user's socket room (below); postMessage is a best-effort popup nicety.
      if (username) io.to(`user:${username}`).emit('spotify:auth', payload);
      return page(`<p>Connected to Spotify — closing…</p><script>
try{window.opener&&window.opener.postMessage(${jsonForScript(payload)},${jsonForScript(safeOrigin)});}finally{window.close();}
</script>`);
    } catch (err) {
      console.error('Spotify callback error:', err.message);
      return page('<p>Spotify authentication failed. You can close this window.</p>');
    }
  });

  app.post('/music/spotify/refresh', authMiddleware, async (req, res) => {
    const creds = getSpotifyCreds();
    const refreshToken = (req.body || {}).refresh_token;
    if (!creds) return res.status(503).json({ error: 'Spotify is not configured' });
    if (!refreshToken) return res.status(400).json({ error: 'refresh_token required' });
    try {
      const basic = Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64');
      const r = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(refreshToken) }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: 'Token refresh failed' });
      const body = { access_token: data.access_token, expires_in: data.expires_in };
      if (data.refresh_token) body.refresh_token = data.refresh_token;
      return res.json(body);
    } catch {
      return res.status(502).json({ error: 'Token refresh failed' });
    }
  });

  // Search proxy — uses the requesting user's own Spotify token (never stored server-side).
  // The token comes in the X-Spotify-Token header, not the query string, so it never lands in
  // access logs. (Query fallback kept for older clients but discouraged.)
  app.get('/music/spotify/search', authMiddleware, async (req, res) => {
    const q = (req.query.q || '').toString().trim();
    const accessToken = (req.get('X-Spotify-Token') || req.query.access_token || '').toString();
    if (!q || !accessToken) return res.status(400).json({ error: 'q and Spotify token required' });
    try {
      const r = await fetch(`https://api.spotify.com/v1/search?${new URLSearchParams({ q, type: 'track', limit: '10' })}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await r.json();
      if (r.status === 401) return res.status(401).json({ error: 'Spotify token expired' });
      if (!r.ok) return res.status(502).json({ error: 'Spotify search failed' });
      return res.json((data.tracks?.items || []).map((t) => ({
        id: t.uri, // spotify:track:… — what the Web Playback SDK plays
        title: t.name,
        artist: (t.artists || []).map((a) => a.name).join(', '),
        thumbnail: t.album?.images?.[1]?.url || t.album?.images?.[0]?.url || '',
        durationMs: t.duration_ms,
        service: 'spotify',
      })));
    } catch (err) {
      console.error('Spotify search error:', err.message);
      return res.status(502).json({ error: 'Spotify search failed' });
    }
  });

  // Streaming audio proxy. Auth via ?token= because <audio src> can't send headers.
  app.get('/music/audio/:videoId', async (req, res) => {
    try { jwt.verify(String(req.query.token || ''), JWT_SECRET); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
    const { videoId } = req.params;
    if (!/^[a-zA-Z0-9_-]{6,20}$/.test(String(videoId || ''))) return res.status(400).json({ error: 'Invalid video id' });
    if (req.query.fresh === '1') audioUrlCache.delete(videoId); // client retry after a playback error
    try {
      const { audioUrl } = await resolveAudioUrl(videoId);
      const upstream = await fetch(audioUrl, { headers: req.headers.range ? { Range: req.headers.range } : {} });
      if (!upstream.ok && upstream.status !== 206) {
        if (upstream.status === 403 || upstream.status === 410) audioUrlCache.delete(videoId); // stale signed URL
        return res.status(502).json({ error: 'Audio stream failed' });
      }
      res.status(upstream.status);
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'private, max-age=3600');
      const { Readable } = require('stream');
      const body = Readable.fromWeb(upstream.body);
      body.on('error', () => { if (!res.headersSent) res.status(502); res.end(); });
      req.on('close', () => body.destroy());
      body.pipe(res);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        console.error('yt-dlp not found — install it for music playback');
        return res.status(502).json({ error: 'Audio extraction tool not available' });
      }
      if (err && err.details) console.error('yt-dlp error:', String(err.details).slice(0, 300));
      else console.error('Music audio error:', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Failed to get audio' });
    }
  });
}

module.exports = { registerMediaRoutes };
