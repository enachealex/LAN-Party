// Shared libraries: per-server custom emojis, the public app directory, the shared GIF library,
// and the soundboard. Uploads use the multer instances created at boot (ephemeral for emoji
// source files, persistent for gifs/sounds), injected along with their directories.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractBundle } = require('../services/appBundles');

/** @param {Record<string, any>} deps */
function registerLibraryRoutes({ app, db, io, authMiddleware, upload, gifUpload, soundUpload, gifsDir, soundsDir, SOUND_NAME_MAX, bundleUpload, appBundlesDir }) {
  // --- Server custom emojis ---
  function slugifyEmojiName(raw) {
    const base = String(raw || 'emoji').replace(/\.[^.]+$/, '').toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    return base || 'emoji';
  }

  // List custom emojis for a server.
  app.get('/servers/:serverId/emojis', authMiddleware, async (req, res) => {
    const rows = await db.all(
      'SELECT name, url, created_by FROM server_emojis WHERE server_id = ? ORDER BY created_at ASC',
      req.params.serverId
    );
    return res.json({ emojis: rows });
  });

  // Add a custom emoji to a server (url comes from a prior /files/upload).
  app.post('/servers/:serverId/emojis', authMiddleware, async (req, res) => {
    const serverId = req.params.serverId;
    const { url } = req.body || {};
    if (typeof url !== 'string' || !url.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'Invalid emoji url' });
    }
    const server = await db.get('SELECT id FROM servers WHERE id = ?', serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    // Ensure a unique name within the server.
    let base = slugifyEmojiName(req.body?.name);
    let name = base;
    let n = 1;
    while (await db.get('SELECT id FROM server_emojis WHERE server_id = ? AND name = ?', serverId, name)) {
      name = `${base}_${n++}`;
    }
    await db.run(
      'INSERT INTO server_emojis (server_id, name, url, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
      serverId, name, url, req.user.username, Date.now()
    );
    const emojis = await db.all('SELECT name, url, created_by FROM server_emojis WHERE server_id = ? ORDER BY created_at ASC', serverId);
    return res.json({ success: true, name, emojis });
  });

  // Remove a custom emoji from a server.
  app.delete('/servers/:serverId/emojis/:name', authMiddleware, async (req, res) => {
    const { serverId, name } = req.params;
    await db.run('DELETE FROM server_emojis WHERE server_id = ? AND name = ?', serverId, name);
    const emojis = await db.all('SELECT name, url, created_by FROM server_emojis WHERE server_id = ? ORDER BY created_at ASC', serverId);
    return res.json({ success: true, emojis });
  });

  // --- Public app directory ---
  // A 'link' app keeps its external url; a 'bundle' app is LAN-Party-hosted, so its url is the
  // internal sandboxed path. `embeddable` tells the client it can be shown in the in-app viewer.
  async function listApps() {
    const rows = await db.all("SELECT id, name, description, url, icon_url AS iconUrl, created_by AS createdBy, created_at AS createdAt, COALESCE(kind, 'link') AS kind, bundle_dir AS bundleDir FROM apps ORDER BY created_at DESC");
    return rows.map((r) => {
      const isBundle = r.kind === 'bundle' && r.bundleDir;
      const { bundleDir, ...rest } = r;
      return { ...rest, url: isBundle ? `/app-bundles/${bundleDir}/` : r.url, embeddable: !!isBundle };
    });
  }

  // Publish a link-style app (external URL) to the public directory.
  app.post('/apps', authMiddleware, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'App name is required' });
    const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 500) : '';
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const iconUrl = typeof req.body?.iconUrl === 'string' && req.body.iconUrl.startsWith('/uploads/') ? req.body.iconUrl : '';
    await db.run(
      "INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind) VALUES (?, ?, ?, ?, ?, ?, 'link')",
      name.slice(0, 80), description, url, iconUrl, req.user.username, Date.now()
    );
    return res.json({ success: true, apps: await listApps() });
  });

  app.get('/apps', authMiddleware, async (req, res) => {
    return res.json({ apps: await listApps() });
  });

  // Upload a self-contained mini-app (single .html or a .zip). The server extracts it into a private
  // per-app folder and serves it sandboxed at /app-bundles/<dir>/ — so it embeds in the in-app viewer.
  app.post('/apps/bundle', authMiddleware, (req, res) => {
    bundleUpload.single('bundle')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Bundle is larger than 15 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing bundle file' });
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      if (!name) return res.status(400).json({ error: 'App name is required' });
      const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 500) : '';
      const iconUrl = typeof req.body?.iconUrl === 'string' && req.body.iconUrl.startsWith('/uploads/') ? req.body.iconUrl : '';
      const dir = `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
      const destDir = path.join(appBundlesDir, dir);
      try {
        extractBundle(req.file, destDir); // throws on unsafe/invalid archive; requires an index.html
      } catch (e) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        return res.status(400).json({ error: e.message || 'Could not process the bundle' });
      }
      await db.run(
        "INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind, bundle_dir) VALUES (?, ?, '', ?, ?, ?, 'bundle', ?)",
        name.slice(0, 80), description, iconUrl, req.user.username, Date.now(), dir
      );
      return res.json({ success: true, apps: await listApps() });
    });
  });

  // Remove an app — only its uploader may. For bundles, delete the hosted files too.
  app.delete('/apps/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid app id' });
    const row = await db.get('SELECT created_by, kind, bundle_dir FROM apps WHERE id = ?', id);
    if (!row) return res.status(404).json({ error: 'App not found' });
    if (row.created_by !== req.user.username) return res.status(403).json({ error: 'You can only remove apps you uploaded' });
    await db.run('DELETE FROM apps WHERE id = ?', id);
    if (row.kind === 'bundle' && row.bundle_dir) {
      // Resolve + confirm the target stays strictly inside appBundlesDir before recursive delete.
      const target = path.resolve(appBundlesDir, row.bundle_dir);
      const rel = path.relative(appBundlesDir, target);
      const contained = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
      if (contained) {
        try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* best effort */ }
      }
    }
    return res.json({ success: true, apps: await listApps() });
  });

  // --- Shared GIF library ---
  // List all GIFs (newest first).
  app.get('/gifs', authMiddleware, async (req, res) => {
    const gifs = await db.all('SELECT id, name, url, type, created_by AS createdBy, created_at AS createdAt FROM gifs ORDER BY created_at DESC');
    return res.json({ gifs });
  });

  // Add a GIF to the shared library (multipart upload -> persistent /gifs storage).
  app.post('/gifs', authMiddleware, (req, res) => {
    gifUpload.single('file')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 100 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing file' });
      const type = req.file.mimetype || 'image/gif';
      if (!type.startsWith('image/')) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'Only image files can be added to the GIF library' });
      }
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const name = (rawName || req.file.originalname || 'GIF').slice(0, 80);
      const url = `/gifs/${req.file.filename}`;
      await db.run(
        'INSERT INTO gifs (name, url, type, created_by, created_at) VALUES (?, ?, ?, ?, ?)',
        name, url, type, req.user.username, Date.now()
      );
      const gifs = await db.all('SELECT id, name, url, type, created_by AS createdBy, created_at AS createdAt FROM gifs ORDER BY created_at DESC');
      return res.json({ success: true, gifs });
    });
  });

  // Remove a GIF from the library (and delete its file).
  app.delete('/gifs/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid gif id' });
    const gif = await db.get('SELECT url FROM gifs WHERE id = ?', id);
    if (gif && typeof gif.url === 'string' && gif.url.startsWith('/gifs/')) {
      fs.promises.unlink(path.join(gifsDir, path.basename(gif.url))).catch(() => {});
    }
    await db.run('DELETE FROM gifs WHERE id = ?', id);
    const gifs = await db.all('SELECT id, name, url, type, created_by AS createdBy, created_at AS createdAt FROM gifs ORDER BY created_at DESC');
    return res.json({ success: true, gifs });
  });

  // --- Shared soundboard ---
  const SOUND_COLORS = ['#ff6b6b', '#f7b731', '#20bf6b', '#2bcbba', '#45aaf2', '#4b7bec', '#a55eea', '#fd79a8', '#e17055', '#00b894'];
  function soundColorForName(raw) {
    const s = String(raw || 'sound');
    let hash = 0;
    for (let i = 0; i < s.length; i++) hash = (hash + s.charCodeAt(i)) % SOUND_COLORS.length;
    return SOUND_COLORS[hash];
  }

  // List all soundboard clips (newest first).
  app.get('/sounds', authMiddleware, async (req, res) => {
    const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
    return res.json({ sounds });
  });

  // Add a soundboard clip (multipart upload -> persistent /sounds storage).
  app.post('/sounds', authMiddleware, (req, res) => {
    soundUpload.single('file')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 100 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing file' });
      const type = req.file.mimetype || 'audio/mpeg';
      // Accept by mimetype, or by extension (some clients send application/octet-stream for audio).
      const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'weba', 'opus'];
      const ext = (req.file.originalname.split('.').pop() || '').toLowerCase();
      if (!type.startsWith('audio/') && !AUDIO_EXTS.includes(ext)) {
        fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'Only audio files can be added to the soundboard' });
      }
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const name = (rawName || req.file.originalname.replace(/\.[^.]+$/, '') || 'Sound').slice(0, SOUND_NAME_MAX);
      const emoji = typeof req.body?.emoji === 'string' && req.body.emoji.trim() ? req.body.emoji.trim().slice(0, 8) : '🔊';
      const color = typeof req.body?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.color) ? req.body.color : soundColorForName(name);
      const url = `/sounds/${req.file.filename}`;
      await db.run(
        'INSERT INTO sounds (name, emoji, color, url, type, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        name, emoji, color, url, type, req.user.username, Date.now()
      );
      const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
      return res.json({ success: true, sounds });
    });
  });

  // Rename a soundboard clip.
  app.patch('/sounds/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid sound id' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, SOUND_NAME_MAX) : '';
    if (!name) return res.status(400).json({ error: 'Name is required' });
    const existing = await db.get('SELECT id FROM sounds WHERE id = ?', id);
    if (!existing) return res.status(404).json({ error: 'Sound not found' });
    await db.run('UPDATE sounds SET name = ? WHERE id = ?', name, id);
    const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
    return res.json({ success: true, sounds });
  });

  // Remove a soundboard clip (and delete its file).
  app.delete('/sounds/:id', authMiddleware, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'Invalid sound id' });
    const sound = await db.get('SELECT url FROM sounds WHERE id = ?', id);
    if (sound && typeof sound.url === 'string' && sound.url.startsWith('/sounds/')) {
      fs.promises.unlink(path.join(soundsDir, path.basename(sound.url))).catch(() => {});
    }
    await db.run('DELETE FROM sounds WHERE id = ?', id);
    const sounds = await db.all('SELECT id, name, emoji, color, url, type, created_by AS createdBy, created_at AS createdAt FROM sounds ORDER BY created_at DESC');
    return res.json({ success: true, sounds });
  });
}

module.exports = { registerLibraryRoutes };
