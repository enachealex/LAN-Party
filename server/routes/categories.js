// Channel categories and channel order: create, rename, delete and reorder categories, file a
// channel under one, and move a channel up or down its list. The storage and the ordering rule are
// services/channels.js.
//
// Every route needs manage_channels (services/permissions.js), in a real server: the commons has
// no staff and no categories, and is refused by name.
//
// A CATEGORY IS PRESENTATION ONLY. Nothing here changes who can open a channel: a private channel
// keeps its own access list whichever category it is filed under, deleting a category never
// deletes (or opens) its channels, and nobody is shown a category unless it holds a channel they
// can see. So none of these routes can take access away, and none of them rotates app room keys.
const { rateLimit } = require('../rateLimit');
const { AUDIT } = require('../services/moderation');
const { MAX_CATEGORIES, CATEGORY_NAME_MAX } = require('../services/channels');

// Counted per account: arranging a channel list is a run of small moves, so this is roomy, and
// still a ceiling for a script rewriting the list (each move is a broadcast to the whole server).
const keyOf = (/** @type {any} */ req) => req.user && req.user.username;
const LAYOUT_WRITE_LIMIT = { id: 'channel-layout-write', windowMs: 5 * 60_000, max: 240, message: 'Too many changes to the channel list just now. Wait a few minutes.', keyOf };

/**
 * A category name as it is stored: text, trimmed, 1..CATEGORY_NAME_MAX characters.
 * @param {unknown} value
 * @returns {{ name: string } | { error: string }}
 */
function parseCategoryName(value) {
  if (typeof value !== 'string') return { error: 'A category needs a name' };
  const name = value.trim();
  if (name.length < 1 || name.length > CATEGORY_NAME_MAX) return { error: `A category name must be 1 to ${CATEGORY_NAME_MAX} characters` };
  return { name };
}

/** @param {Record<string, any>} deps */
function registerCategoryRoutes({ app, db, authMiddleware, DEMO_ID, newId, permissions, channelLists, moderation, broadcastServerState }) {
  const audit = moderation.audit;

  // Express 4 does not catch a rejected async handler, and an unhandled rejection ends the process.
  const safely = (handler) => async (req, res) => {
    try {
      return await handler(req, res);
    } catch (e) {
      console.error('[categories] error:', e);
      if (!res.headersSent) return res.status(500).json({ error: 'Server error' });
      return undefined;
    }
  };

  // The gate every route passes first: a real server, not the commons, and the caller manages
  // channels in THIS server. Answers the request itself when it fails.
  async function channelManager(req, res) {
    const serverId = req.params.serverId;
    if (serverId === DEMO_ID) { res.status(400).json({ error: 'The public server has no categories' }); return null; }
    const srv = await db.get('SELECT id FROM servers WHERE id = ?', serverId);
    if (!srv) { res.status(404).json({ error: 'Server not found' }); return null; }
    if (!(await permissions.can(serverId, req.user.username, 'manage_channels'))) { res.status(403).json({ error: 'Only server admins can arrange channels' }); return null; }
    return { serverId };
  }
  const categoryOf = (serverId, categoryId) => db.get('SELECT id, name FROM channel_categories WHERE id = ? AND server_id = ?', categoryId, serverId);
  const channelOf = (serverId, channelId) => db.get('SELECT id, name FROM channels WHERE id = ? AND server_id = ?', channelId, serverId);
  const directionOf = (req) => ((req.body || {}).direction === 'up' || (req.body || {}).direction === 'down' ? (req.body || {}).direction : null);

  // --- Categories ---

  app.post('/servers/:serverId/categories', authMiddleware, rateLimit(LAYOUT_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await channelManager(req, res);
    if (!ctx) return undefined;
    const { serverId } = ctx;
    const named = parseCategoryName((req.body || {}).name);
    if ('error' in named) return res.status(400).json({ error: named.error });
    const existing = await channelLists.listCategories(serverId);
    if (existing.length >= MAX_CATEGORIES) return res.status(400).json({ error: `A server can have at most ${MAX_CATEGORIES} categories` });
    const id = newId('cat');
    const position = existing.reduce((max, c) => Math.max(max, c.position), 0) + 1; // a new one goes last
    await db.run('INSERT INTO channel_categories (id, server_id, name, position) VALUES (?, ?, ?, ?)', id, serverId, named.name, position);
    await broadcastServerState(serverId);
    await audit(serverId, req.user.username, AUDIT.categoryCreated, null, { categoryId: id, name: named.name });
    return res.json({ category: { id, name: named.name, position } });
  }));

  app.patch('/servers/:serverId/categories/:categoryId', authMiddleware, rateLimit(LAYOUT_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await channelManager(req, res);
    if (!ctx) return undefined;
    const { serverId } = ctx;
    const category = await categoryOf(serverId, req.params.categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    const named = parseCategoryName((req.body || {}).name);
    if ('error' in named) return res.status(400).json({ error: named.error });
    await db.run('UPDATE channel_categories SET name = ? WHERE id = ? AND server_id = ?', named.name, category.id, serverId);
    await broadcastServerState(serverId);
    if (named.name !== category.name) await audit(serverId, req.user.username, AUDIT.categoryRenamed, null, { categoryId: category.id, from: category.name, to: named.name });
    return res.json({ category: { id: category.id, name: named.name } });
  }));

  // Deleting a category moves its channels back to "no category". It never deletes them, their
  // messages or their access lists.
  app.delete('/servers/:serverId/categories/:categoryId', authMiddleware, rateLimit(LAYOUT_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await channelManager(req, res);
    if (!ctx) return undefined;
    const { serverId } = ctx;
    const category = await categoryOf(serverId, req.params.categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    const held = await db.get('SELECT COUNT(*) AS n FROM channels WHERE server_id = ? AND category_id = ?', serverId, category.id);
    await channelLists.deleteCategory(serverId, category.id);
    await broadcastServerState(serverId);
    await audit(serverId, req.user.username, AUDIT.categoryDeleted, null, { categoryId: category.id, name: category.name, channels: held?.n || 0 });
    return res.json({ success: true });
  }));

  app.post('/servers/:serverId/categories/:categoryId/move', authMiddleware, rateLimit(LAYOUT_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await channelManager(req, res);
    if (!ctx) return undefined;
    const { serverId } = ctx;
    const direction = directionOf(req);
    if (!direction) return res.status(400).json({ error: 'direction must be "up" or "down"' });
    const category = await categoryOf(serverId, req.params.categoryId);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    const moved = await channelLists.moveCategory(serverId, category.id, direction);
    if (moved) {
      await broadcastServerState(serverId);
      await audit(serverId, req.user.username, AUDIT.categoryMoved, null, { categoryId: category.id, name: category.name, direction });
    }
    return res.json({ success: true, moved: !!moved });
  }));

  // --- Channels: which category, and where in its list ---

  // File a channel under a category, or (categoryId: null) under none. It lands at the end of
  // the list it joins.
  app.put('/servers/:serverId/channels/:channelId/category', authMiddleware, rateLimit(LAYOUT_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await channelManager(req, res);
    if (!ctx) return undefined;
    const { serverId } = ctx;
    const channel = await channelOf(serverId, req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const wanted = (req.body || {}).categoryId;
    if (wanted !== null && typeof wanted !== 'string') return res.status(400).json({ error: 'categoryId must be a category id, or null for no category' });
    const category = wanted === null ? null : await categoryOf(serverId, wanted);
    if (wanted !== null && !category) return res.status(404).json({ error: 'Category not found' });
    const changed = await channelLists.setChannelCategory(serverId, channel.id, category ? category.id : null);
    if (changed) {
      await broadcastServerState(serverId);
      await audit(serverId, req.user.username, AUDIT.channelFiled, null, { channelId: channel.id, channel: channel.name, categoryId: category ? category.id : null, category: category ? category.name : null });
    }
    return res.json({ success: true, categoryId: category ? category.id : null });
  }));

  app.post('/servers/:serverId/channels/:channelId/move', authMiddleware, rateLimit(LAYOUT_WRITE_LIMIT), safely(async (req, res) => {
    const ctx = await channelManager(req, res);
    if (!ctx) return undefined;
    const { serverId } = ctx;
    const direction = directionOf(req);
    if (!direction) return res.status(400).json({ error: 'direction must be "up" or "down"' });
    const channel = await channelOf(serverId, req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const moved = await channelLists.moveChannel(serverId, channel.id, direction);
    if (moved) {
      await broadcastServerState(serverId);
      await audit(serverId, req.user.username, AUDIT.channelMoved, null, { channelId: channel.id, channel: channel.name, direction });
    }
    return res.json({ success: true, moved: !!moved });
  }));
}

module.exports = { registerCategoryRoutes, parseCategoryName };
