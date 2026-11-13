// Shared libraries: per-server custom emojis, the public app directory, the shared GIF library,
// and the soundboard. Uploads use the multer instances created at boot (ephemeral for emoji
// source files, persistent for gifs/sounds), injected along with their directories.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractBundle } = require('../services/appBundles');
const { isHostedApp, ownHostKeys, servedFromLoopback, checkHostedUrl } = require('../services/hostedApps');

/** @param {Record<string, any>} deps */
function registerLibraryRoutes({ app, db, io, authMiddleware, upload, gifUpload, soundUpload, gifsDir, soundsDir, SOUND_NAME_MAX, bundleUpload, appBundlesDir, endAppActivities, approveAppActivities, isInstanceOwner, instanceOwners, ownOrigins = [] }) {
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

  // --- App directory ---
  // A 'link' app keeps its external url; a 'bundle' app is LAN-Party-hosted, so its url is the
  // internal sandboxed path. `embeddable` tells the client it is a bundle: shown in the in-app
  // viewer, in the opaque sandbox.
  //
  // A link app with "Run inside LAN Party" on (embed) is a HOSTED app: still someone else's site at
  // its own address, but framed in the viewer and startable in a voice room like a bundle, under
  // the same review. `hosted` tells the client which frame to build — a hosted app runs on its real
  // origin, which is only safe because that origin is never ours (services/hostedApps.js).
  //
  // A hosted app is NOT `embeddable`. Clients from before hosted apps existed (a tab left open over
  // a deploy) read `embeddable` as "frame this in the bundle sandbox", where a hosted site is a
  // blank page. Left false, those clients show a hosted app as the plain link it also is, which
  // works. Current clients ask `hosted` first and run either kind inside.
  //
  // "Anyone drafts, the instance owner publishes." Every app has a status:
  //   draft      only its uploader (and the instance owners) can see it
  //   pending    the uploader has asked for it to be published
  //   published  in everyone's directory, startable in any room
  //   rejected   an instance owner said no, optionally with a note for the uploader
  // Who may move an app between them is in APP_TRANSITIONS below.
  //
  // What a draft is NOT: access control on the files. A bundle is served from
  // /app-bundles/<bundle_dir>/ to anyone who has that path, signed in or not. The path is long and
  // random, and nothing here hands it to anyone but the uploader and the instance owners (or the
  // people in a voice room the uploader starts it in), so an unpublished app is hidden from the
  // directory — it is not secret from someone who has been given its url.
  const APP_COLUMNS = "id, name, description, url, icon_url, created_by, created_at, COALESCE(kind, 'link') AS kind, bundle_dir, COALESCE(embed, 0) AS embed, status, review_note, reviewed_by, reviewed_at, submitted_at";
  const REVIEW_NOTE_MAX = 500;
  const bundleUrl = (dir) => `/app-bundles/${dir}/`;
  // Where a request says LAN Party lives, plus where the configuration says it does.
  const ownKeysFor = (req) => ownHostKeys(req.headers, ownOrigins);
  // Whether this request reached a LAN Party running on the requester's own machine, the only case
  // in which a plain http://localhost app address is allowed (services/hostedApps.js).
  const whereFor = (req) => ({ loopback: servedFromLoopback(req.headers) });

  // The shape a given viewer gets. The review fields exist only for the people the review concerns:
  // the uploader and the instance owners. Which instance owner decided is for instance owners alone.
  function appView(row, viewer, viewerIsOwner) {
    const isBundle = row.kind === 'bundle' && !!row.bundle_dir;
    const hosted = isHostedApp(row);
    /** @type {Record<string, any>} */
    const view = {
      id: row.id,
      name: row.name,
      description: row.description,
      url: isBundle ? bundleUrl(row.bundle_dir) : row.url,
      iconUrl: row.icon_url,
      createdBy: row.created_by,
      createdAt: row.created_at,
      kind: row.kind,
      embeddable: isBundle,
      hosted,
      status: row.status,
    };
    if (viewerIsOwner || row.created_by === viewer) {
      view.reviewNote = row.review_note || '';
      view.submittedAt = row.submitted_at || null;
      view.reviewedAt = row.reviewed_at || null;
    }
    if (viewerIsOwner) view.reviewedBy = row.reviewed_by || null;
    return view;
  }
  // Published apps for everyone, plus the caller's own in any status; an instance owner gets all.
  async function listApps(viewer, viewerIsOwner) {
    const rows = viewerIsOwner
      ? await db.all(`SELECT ${APP_COLUMNS} FROM apps ORDER BY created_at DESC`)
      : await db.all(`SELECT ${APP_COLUMNS} FROM apps WHERE status = 'published' OR created_by = ? ORDER BY created_at DESC`, viewer);
    return rows.map((r) => appView(r, viewer, viewerIsOwner));
  }
  // The app a per-app route is about, or the response that ends the request. An app the caller may
  // not see gets the very same 404 as an id that was never used, on every route and before any
  // other check, so nothing about an unpublished app (not even that it exists) can be read off the
  // status codes.
  async function loadApp(req, res) {
    const id = parseInt(req.params.id, 10);
    if (!id) { res.status(400).json({ error: 'Invalid app id' }); return null; }
    const me = req.user.username;
    const isOwner = await isInstanceOwner(me);
    const row = await db.get(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`, id);
    const isUploader = !!row && row.created_by === me;
    if (!row || !(row.status === 'published' || isUploader || isOwner)) {
      res.status(404).json({ error: 'App not found' });
      return null;
    }
    return { id, row, me, isOwner, isUploader };
  }
  async function appResponse(id, me, isOwner) {
    const row = await db.get(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`, id);
    return { success: true, app: row ? appView(row, me, isOwner) : null, apps: await listApps(me, isOwner) };
  }
  // A bundle's folder, removed. Resolved and confirmed to sit strictly inside appBundlesDir first:
  // the name comes from the database, and this is a recursive delete.
  function removeBundleDir(dir) {
    if (!dir) return;
    const target = path.resolve(appBundlesDir, dir);
    const rel = path.relative(appBundlesDir, target);
    const contained = !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    if (contained) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  }
  const newBundleDir = () => `${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;

  // Notifications ride the per-user socket rooms and carry the app's id, name and status, nothing
  // else: enough to show a toast or refetch GET /apps, which is where the details (and the
  // visibility rules) live.
  //   app:submitted     -> instance owners: an app is waiting for review
  //   app:review-queue  -> instance owners: something they list changed some other way
  //                        (withdrawn, decided, unpublished, bundle replaced, address edited,
  //                        deleted)
  //   app:reviewed      -> the uploader: an instance owner approved, rejected or unpublished it
  async function tellOwners(event, payload) {
    const owners = await instanceOwners();
    if (owners.length) io.to(owners.map((u) => `user:${u}`)).emit(event, payload);
  }
  const tellUploader = (row, payload) => { if (row.created_by) io.to(`user:${row.created_by}`).emit('app:reviewed', payload); };

  // An upload by an instance owner needs nobody's approval but their own, so it skips the queue.
  const initialStatus = (uploaderIsOwner) => (uploaderIsOwner ? 'published' : 'draft');

  // Add a link-style app (external URL). A draft until an instance owner publishes it.
  // With `embed: true` it is a hosted app from the start, and its address has to pass the checks
  // for one; without it the url is kept as typed, as it always was.
  app.post('/apps', authMiddleware, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'App name is required' });
    const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, 500) : '';
    let url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const iconUrl = typeof req.body?.iconUrl === 'string' && req.body.iconUrl.startsWith('/uploads/') ? req.body.iconUrl : '';
    // true or false and nothing else: a setting that decides whether a site is framed inside the
    // app is not guessed from "1" or "yes".
    const embed = req.body?.embed;
    if (embed !== undefined && typeof embed !== 'boolean') return res.status(400).json({ error: 'Invalid embed setting' });
    if (embed) {
      const checked = checkHostedUrl(req.body?.url, ownKeysFor(req), whereFor(req));
      if (!checked.ok) return res.status(400).json({ error: checked.problem });
      url = checked.url;
    }
    const me = req.user.username;
    const isOwner = await isInstanceOwner(me);
    const created = await db.run(
      "INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind, embed, status) VALUES (?, ?, ?, ?, ?, ?, 'link', ?, ?)",
      name.slice(0, 80), description, url, iconUrl, me, Date.now(), embed ? 1 : 0, initialStatus(isOwner)
    );
    return res.json(await appResponse(created.lastID, me, isOwner));
  });

  app.get('/apps', authMiddleware, async (req, res) => {
    const me = req.user.username;
    const isOwner = await isInstanceOwner(me);
    return res.json({ apps: await listApps(me, isOwner), instanceOwner: isOwner });
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
      const dir = newBundleDir();
      const destDir = path.join(appBundlesDir, dir);
      try {
        extractBundle(req.file, destDir); // throws on unsafe/invalid archive; requires an index.html
      } catch (e) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        return res.status(400).json({ error: e.message || 'Could not process the bundle' });
      }
      const me = req.user.username;
      const isOwner = await isInstanceOwner(me);
      const created = await db.run(
        "INSERT INTO apps (name, description, url, icon_url, created_by, created_at, kind, bundle_dir, status) VALUES (?, ?, '', ?, ?, ?, 'bundle', ?, ?)",
        name.slice(0, 80), description, iconUrl, me, Date.now(), dir, initialStatus(isOwner)
      );
      return res.json(await appResponse(created.lastID, me, isOwner));
    });
  });

  // Edit an app's name, description or icon — its uploader only, in any status. The status stays
  // as it is: what gets reviewed is what the app runs, and these fields change none of that.
  //
  // A link app's address (`url`) and whether it runs inside LAN Party (`embed`) can be edited here
  // too, and those ARE what was reviewed: where the link goes, and whether it is framed in a voice
  // room with the bridge or merely opened in a tab. So a change to either is treated like a bundle
  // replace. The app goes back to 'draft', whatever it was; an instance owner editing their own has
  // nobody else to ask and keeps its status; and any room running it is told it ended, because it
  // is running the old address. A review in progress is not fooled either: approve has to name what
  // it is about (see the handler).
  app.patch('/apps/:id', authMiddleware, async (req, res) => {
    const found = await loadApp(req, res);
    if (!found) return;
    const { id, row, me, isOwner, isUploader } = found;
    if (!isUploader) return res.status(403).json({ error: 'You can only edit apps you uploaded' });
    const body = req.body || {};
    let { name, description, icon_url: iconUrl } = row;
    let changed = false;
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return res.status(400).json({ error: 'App name is required' });
      name = body.name.trim().slice(0, 80);
      changed = true;
    }
    if (body.description !== undefined) {
      if (typeof body.description !== 'string') return res.status(400).json({ error: 'Invalid description' });
      description = body.description.trim().slice(0, 500);
      changed = true;
    }
    if (body.iconUrl !== undefined) {
      // An empty string clears the icon; anything else has to be a file this server stored.
      if (typeof body.iconUrl !== 'string' || (body.iconUrl !== '' && !body.iconUrl.startsWith('/uploads/'))) return res.status(400).json({ error: 'Invalid icon url' });
      iconUrl = body.iconUrl;
      changed = true;
    }
    let url = row.url;
    let embed = !!row.embed;
    if (body.url !== undefined || body.embed !== undefined) {
      if (row.kind !== 'link') return res.status(400).json({ error: 'Only a link app has an address to change or can be set to run inside LAN Party' });
      if (body.url !== undefined) {
        if (typeof body.url !== 'string') return res.status(400).json({ error: 'Invalid app url' });
        url = body.url.trim();
      }
      if (body.embed !== undefined) {
        if (typeof body.embed !== 'boolean') return res.status(400).json({ error: 'Invalid embed setting' });
        embed = body.embed;
      }
      changed = true;
    }
    if (!changed) return res.status(400).json({ error: 'Nothing to change' });
    // Asked on every edit of a hosted app, including one that only renames it: the answer depends
    // on where LAN Party is served from, and that can have changed since the address was saved.
    if (embed) {
      const checked = checkHostedUrl(url, ownKeysFor(req), whereFor(req));
      if (!checked.ok) return res.status(400).json({ error: checked.problem });
      url = checked.url;
    }
    if (url === row.url && embed === !!row.embed) {
      await db.run('UPDATE apps SET name = ?, description = ?, icon_url = ? WHERE id = ?', name, description, iconUrl, id);
      return res.json(await appResponse(id, me, isOwner));
    }
    // Names the address it read, so two edits racing for the same app cannot both win. And as with
    // a bundle replace, an instance owner's app keeps its status by this update not touching it:
    // writing back the status read above would undo another owner's reject that landed in between.
    const reset = isOwner ? '' : ", status = 'draft'";
    const done = await db.run(
      `UPDATE apps SET name = ?, description = ?, icon_url = ?, url = ?, embed = ?${reset} WHERE id = ? AND url IS ? AND COALESCE(embed, 0) = ?`,
      name, description, iconUrl, url, embed ? 1 : 0, id, row.url, row.embed ? 1 : 0
    );
    if (!done.changes) return res.status(409).json({ error: 'This app was changed by someone else; reload and try again' });
    // Rooms running it are on the address it had — also when the status did not change.
    endAppActivities(id);
    const answer = await appResponse(id, me, isOwner);
    const status = answer.app ? answer.app.status : row.status;
    if (status !== row.status || status === 'pending') await tellOwners('app:review-queue', { id, name, status });
    return res.json(answer);
  });

  // Status changes. `by` says who may ask, `from` which statuses it is valid in, `to` where the app
  // ends up. Order of the answers: 404 for an app the caller cannot see, then 403 for the wrong
  // person, then 409 for the wrong status — so the 409 only ever tells someone who was allowed to
  // ask what state the app is in.
  const APP_TRANSITIONS = {
    submit: { by: 'uploader', from: ['draft', 'rejected'], to: 'pending', denied: 'Only the uploader can submit an app for review' },
    withdraw: { by: 'uploader', from: ['pending'], to: 'draft', denied: 'Only the uploader can withdraw an app from review' },
    // No 'pending' required: an instance owner may publish an app straight from draft or rejected.
    // For a bundle or a hosted app the request must also name what was looked at; see the handler.
    approve: { by: 'owner', from: ['pending', 'draft', 'rejected'], to: 'published', denied: 'Only an instance owner can publish an app' },
    reject: { by: 'owner', from: ['pending', 'published'], to: 'rejected', denied: 'Only an instance owner can reject an app' },
    unpublish: { by: 'either', from: ['published'], to: 'draft', denied: 'Only the uploader or an instance owner can unpublish an app' },
  };
  for (const [action, rule] of Object.entries(APP_TRANSITIONS)) {
    app.post(`/apps/:id/${action}`, authMiddleware, async (req, res) => {
      const found = await loadApp(req, res);
      if (!found) return;
      const { id, row, me, isOwner, isUploader } = found;
      const allowed = rule.by === 'uploader' ? isUploader : rule.by === 'owner' ? isOwner : (isUploader || isOwner);
      if (!allowed) return res.status(403).json({ error: rule.denied });
      let note = null;
      if (action === 'reject' && req.body?.note !== undefined && req.body.note !== null) {
        // Refused rather than cut short: a note that silently lost its ending is worse than a
        // reviewer being asked to shorten it.
        if (typeof req.body.note !== 'string') return res.status(400).json({ error: 'Invalid note' });
        note = req.body.note.trim();
        if (note.length > REVIEW_NOTE_MAX) return res.status(400).json({ error: `Note is longer than ${REVIEW_NOTE_MAX} characters` });
        if (!note) note = null;
      }
      // Approving a bundle approves particular files, and its uploader can swap them at any moment
      // (PUT /apps/:id/bundle) — after the reviewer opened the app, even after submitting it again
      // under the same name. So the request says which files were reviewed, as the url the reviewer
      // was shown, and anything but the bundle being served right now publishes nothing.
      //
      // A hosted app is held to the same: its uploader can edit the address, or turn "run inside
      // LAN Party" on for what was reviewed as a plain link (PATCH /apps/:id). So approving one has
      // to say both things the reviewer saw — `url`, and `embed: true` — and anything but the app
      // as it stands publishes nothing.
      //
      // A plain link is held to it too: `url`, the address the reviewer read, and `embed: false`.
      // Its uploader can repoint it, or turn it into a hosted app and back, between the reviewer
      // reading the row and clicking; an approval that names nothing would publish whatever it had
      // become. (The client has always sent both, so this only turns away requests that leave one
      // out.) A value that is there but does not match what the app is now is a 409, as for a bundle.
      const isBundle = row.kind === 'bundle' && !!row.bundle_dir;
      const hosted = !isBundle && isHostedApp(row);
      const named = req.body || {};
      if (action === 'approve' && isBundle && typeof named.url !== 'string') {
        return res.status(400).json({ error: 'Say which bundle you reviewed: send the url the app had when you opened it' });
      }
      if (action === 'approve' && !isBundle && (typeof named.url !== 'string' || named.embed === undefined)) {
        return res.status(400).json({ error: 'Say what you reviewed: send the url the app had when you opened it, and whether it runs inside LAN Party (embed: true or false)' });
      }
      if (!rule.from.includes(row.status)) return res.status(409).json({ error: `This app is ${row.status}; it cannot be changed that way` });
      if (action === 'approve' && isBundle && named.url !== bundleUrl(row.bundle_dir)) {
        return res.status(409).json({ error: 'The bundle was replaced since you opened it. Open the app again and review the new files before publishing.' });
      }
      if (action === 'approve' && !isBundle) {
        const urlMoved = named.url !== (row.url || '');
        const embedMoved = named.embed !== hosted;
        if (urlMoved || embedMoved) {
          return res.status(409).json({ error: 'The address of this app, or whether it runs inside LAN Party, was changed since you opened it. Open the app again and review it before publishing.' });
        }
        // Publishing is the moment a hosted app becomes everyone's to start, so the rule that
        // carries the weight is asked again, of the request of the person deciding: the address
        // may have been saved through a name for this server that their browser does not use.
        if (hosted) {
          const checked = checkHostedUrl(row.url, ownKeysFor(req), whereFor(req));
          if (!checked.ok) return res.status(409).json({ error: checked.problem });
        }
      }
      const now = Date.now();
      // Each update names the status it expects to replace, so two requests racing for the same app
      // cannot both win: the second finds nothing to change and is told so.
      let done;
      if (action === 'submit') {
        // The last rejection's note stays until the next decision: it is what the reviewer asked for.
        done = await db.run('UPDATE apps SET status = ?, submitted_at = ? WHERE id = ? AND status = ?', rule.to, now, id, row.status);
      } else if (action === 'approve') {
        // ...and names the bundle as well: a replace landing between the check above and this
        // update must not be published by it. (IS, so that a link's NULL matches itself.) The same
        // goes for a link's address and its embed setting, which an edit can move.
        done = await db.run(
          'UPDATE apps SET status = ?, review_note = NULL, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = ? AND bundle_dir IS ? AND url IS ? AND COALESCE(embed, 0) = ?',
          rule.to, me, now, id, row.status, row.bundle_dir, row.url, row.embed ? 1 : 0
        );
      } else if (action === 'reject') {
        done = await db.run('UPDATE apps SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = ?', rule.to, note, me, now, id, row.status);
      } else {
        done = await db.run('UPDATE apps SET status = ? WHERE id = ? AND status = ?', rule.to, id, row.status);
      }
      if (!done.changes) return res.status(409).json({ error: 'This app was changed by someone else; reload and try again' });

      // A room running an app that just stopped being everyone's to start is told it ended, the way
      // a deleted app's rooms are. (After a withdraw the uploader may still run their own draft.)
      if (action === 'reject' || action === 'unpublish') endAppActivities(id);
      // The other way round: rooms already running it as "not yet approved" lose the warning.
      if (action === 'approve') approveAppActivities(id);

      const payload = { id, name: row.name, status: rule.to };
      if (action === 'submit') await tellOwners('app:submitted', payload);
      else await tellOwners('app:review-queue', payload);
      // The uploader hears about a decision made by someone else — never about their own action
      // (an instance owner publishing their own app, an uploader unpublishing theirs).
      const decided = !isUploader && (action === 'approve' || action === 'reject' || action === 'unpublish');
      if (decided) tellUploader(row, payload);
      return res.json(await appResponse(id, me, isOwner));
    });
  }

  // Replace a bundle app's files with a new upload (same checks and limits as a first upload). The
  // app goes back to 'draft': what was approved is no longer what is being served. An instance
  // owner replacing their own app has nobody else to ask, so theirs keeps its status. Either way a
  // review still in progress is not fooled: approve has to name the bundle it is about.
  //
  // The new files get a new folder, so the app's url changes with them. The old one is deleted
  // rather than overwritten in place: these files are cacheable, and a browser (or a room) still
  // holding the old url must stop getting an app at it, not get a mix of old and new files.
  app.put('/apps/:id/bundle', authMiddleware, async (req, res) => {
    // Who is asking is settled before the upload is read, so a stranger cannot make the server
    // buffer 15 MB for an app that is not theirs.
    const found = await loadApp(req, res);
    if (!found) return;
    if (!found.isUploader) return res.status(403).json({ error: 'You can only replace the bundle of an app you uploaded' });
    if (found.row.kind !== 'bundle' || !found.row.bundle_dir) return res.status(400).json({ error: 'Only an uploaded bundle can be replaced' });
    const { id, me } = found;
    bundleUpload.single('bundle')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Bundle is larger than 15 MB' });
        return res.status(400).json({ error: err.message || 'Upload failed' });
      }
      if (!req.file) return res.status(400).json({ error: 'Missing bundle file' });
      const dir = newBundleDir();
      const destDir = path.join(appBundlesDir, dir);
      try {
        extractBundle(req.file, destDir);
      } catch (e) {
        // Nothing else has been touched yet: the app keeps its old files and its status.
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        return res.status(400).json({ error: e.message || 'Could not process the bundle' });
      }
      // Read again: the upload took a while, and the app may have been deleted, reviewed or
      // replaced from another window in the meantime.
      const row = await db.get(`SELECT ${APP_COLUMNS} FROM apps WHERE id = ?`, id);
      const isOwner = await isInstanceOwner(me);
      // An instance owner's app keeps its status by this update not touching it. Writing back the
      // status read above would undo a reject or unpublish by ANOTHER instance owner that landed
      // in between — they would have been answered "rejected", and the app would be published.
      const done = !(row && row.created_by === me && row.bundle_dir) ? null
        : isOwner ? await db.run('UPDATE apps SET bundle_dir = ? WHERE id = ? AND bundle_dir = ?', dir, id, row.bundle_dir)
          : await db.run("UPDATE apps SET bundle_dir = ?, status = 'draft' WHERE id = ? AND bundle_dir = ?", dir, id, row.bundle_dir);
      if (!done || !done.changes) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
        if (!row || row.created_by !== me) return res.status(404).json({ error: 'App not found' });
        return res.status(409).json({ error: 'This app was changed by someone else; reload and try again' });
      }
      // Rooms running the old files are told it ended before those files go — also when the status
      // did not change, because the url they were given is about to 404.
      endAppActivities(id);
      removeBundleDir(row.bundle_dir);
      // What it is now is read back, not assumed. Owners are told whenever their list could be
      // showing something stale: the status moved, or an app in their queue has new files.
      const answer = await appResponse(id, me, isOwner);
      const status = answer.app ? answer.app.status : row.status;
      if (status !== row.status || status === 'pending') await tellOwners('app:review-queue', { id, name: row.name, status });
      return res.json(answer);
    });
  });

  // Remove an app — its uploader or an instance owner. For bundles, delete the hosted files too.
  app.delete('/apps/:id', authMiddleware, async (req, res) => {
    const found = await loadApp(req, res);
    if (!found) return;
    const { id, row, me, isOwner, isUploader } = found;
    if (!isUploader && !isOwner) return res.status(403).json({ error: 'You can only remove apps you uploaded' });
    await db.run('DELETE FROM apps WHERE id = ?', id);
    // Any voice room running this app as its activity is told it ended, before the files go.
    endAppActivities(id);
    if (row.kind === 'bundle') removeBundleDir(row.bundle_dir);
    // 'deleted' is not a status an app can have; it is how the people listing it learn to drop it.
    const payload = { id, name: row.name, status: 'deleted' };
    await tellOwners('app:review-queue', payload);
    if (!isUploader) tellUploader(row, payload);
    return res.json({ success: true, apps: await listApps(me, isOwner) });
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
