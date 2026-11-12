// Message search: one endpoint over channel messages, direct messages and group chats.
//
// The rule everything here serves: a result is only ever a message the caller could open through the
// normal routes right now. Search reads across every conversation at once, so it is the easiest
// place in the server to leak one. That is why it never decides access for itself. It first works
// out which conversations the caller may open, using the same checks the routes that open them use
// (roleOf / canAccessChannel / visibleChannelsFor for channels, canDirectMessage for DMs, a
// group_members row for groups), and only then matches text inside that set. Asking for one
// conversation by id and not being allowed in is a refusal, never an empty list that looks like
// "no matches".
//
// Cost: the match is a LIKE, which has to read every message in the conversations searched. Fine at
// this app's size, and bounded two ways: every query carries a LIMIT, and the route is rate limited.
const { rateLimit } = require('../rateLimit');

// Counted per account, not per address: the address comes from a forwarded header, and a signed-in
// caller who is not behind the tunnel could send a new one with every request and never be limited.
const SEARCH_LIMIT = {
  id: 'search', windowMs: 60_000, max: 90, message: 'Too many searches — wait a moment.',
  keyOf: (req) => req.user && req.user.username,
};
// How many channels one channel query names. SQLite refuses an expression nested deeper than 1000,
// and every server searched adds an OR term, so someone in a great many servers is searched in
// several queries rather than one that cannot run.
const CHANNELS_PER_QUERY = 400;
const Q_MIN = 2;
const Q_MAX = 100;
const LIMIT_DEFAULT = 25;
const LIMIT_MAX = 50;
const SCOPES = ['channel', 'server', 'dm', 'group', 'all'];
// Where a kind sorts among messages with the same timestamp. Any fixed order would do; it only has
// to be the same on every page, or a cursor landing on a tie would repeat or skip a result.
const KIND_RANK = { channel: 0, dm: 1, group: 2 };

// % and _ are wildcards to LIKE. Someone searching for "100%" or "snake_case" means those
// characters, so they are escaped (and the escape character with them).
const likePattern = (q) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const placeholders = (n) => new Array(n).fill('?').join(', ');

// The cursor is the sort key of the last result handed out. Opaque to the client, but it comes back
// from the client, so it is validated like any other input.
const encodeCursor = (r) => Buffer.from(JSON.stringify([r.message.ts, KIND_RANK[r.kind], r.message.id])).toString('base64url');
function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  try {
    const arr = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(arr) || arr.length !== 3 || !arr.every((n) => Number.isSafeInteger(n) && n >= 0) || arr[1] > 2) return null;
    return { ts: arr[0], rank: arr[1], id: arr[2] };
  } catch {
    return null;
  }
}

// "Sorts after the cursor", for one kind's table. Results are ordered by time (newest first), then
// kind, then id (newest first); a kind that sorts after the cursor's kind may still have rows AT the
// cursor's timestamp, one that sorts before it may not.
function afterCursor(cursor, rank, tsCol, idCol) {
  if (!cursor) return { sql: '', params: [] };
  if (rank > cursor.rank) return { sql: ` AND ${tsCol} <= ?`, params: [cursor.ts] };
  if (rank < cursor.rank) return { sql: ` AND ${tsCol} < ?`, params: [cursor.ts] };
  return { sql: ` AND (${tsCol} < ? OR (${tsCol} = ? AND ${idCol} < ?))`, params: [cursor.ts, cursor.ts, cursor.id] };
}

/** @param {Record<string, any>} deps */
function registerSearchRoutes({ app, db, authMiddleware, roleOf, canAccessChannel, visibleChannelsFor, getUserByUsername, canDirectMessage, parseAttachment }) {
  const fail = (status, error) => ({ status, error });
  const one = (value) => (typeof value === 'string' ? value : '');

  const result = (kind, row, where) => ({
    kind,
    serverId: null, serverName: null, channelId: null, channelName: null, peer: null, groupId: null, groupName: null,
    ...where,
    message: { id: row.id, author: row.author, text: row.text || '', ts: row.ts, attachment: parseAttachment(row.attachment_json) },
  });

  // --- Which conversations may be searched. Each returns { error } or the set to search. ---

  // Channels, as [{ id, name, channels: [{ id, name }] }] per server.
  async function channelTargets(scope, query, username) {
    const channelsOf = (serverId) =>
      db.all("SELECT id, name, type, COALESCE(privacy, 'public') AS privacy FROM channels WHERE server_id = ?", serverId);

    if (scope === 'channel') {
      const serverId = one(query.serverId);
      const channelId = one(query.channelId);
      if (!serverId || !channelId) return fail(400, 'serverId and channelId are required for scope=channel');
      const ch = await db.get("SELECT id, name, COALESCE(privacy, 'public') AS privacy FROM channels WHERE id = ? AND server_id = ?", channelId, serverId);
      if (!ch) return fail(404, 'Channel not found');
      const role = await roleOf(serverId, username);
      if (!(await canAccessChannel(serverId, channelId, username, ch.privacy, role))) return fail(403, 'You do not have access to this channel');
      const srv = await db.get('SELECT name FROM servers WHERE id = ?', serverId);
      return { servers: [{ id: serverId, name: srv ? srv.name : '', channels: [ch] }] };
    }
    if (scope === 'server') {
      const serverId = one(query.serverId);
      if (!serverId) return fail(400, 'serverId is required for scope=server');
      const srv = await db.get('SELECT id, name FROM servers WHERE id = ?', serverId);
      if (!srv) return fail(404, 'Server not found');
      const role = await roleOf(serverId, username);
      if (!role) return fail(403, 'You are not a member of this server');
      return { servers: [{ id: srv.id, name: srv.name, channels: await visibleChannelsFor(serverId, await channelsOf(serverId), username, role) }] };
    }
    // scope=all: the servers on the caller's rail, i.e. real membership rows, like GET /servers and
    // GET /unreads. The role comes from the row just read, so it is as current as the query.
    const mine = await db.all(
      'SELECT s.id, s.name, m.role FROM server_members m JOIN servers s ON s.id = m.server_id WHERE m.username = ?',
      username
    );
    const servers = [];
    for (const s of mine) {
      servers.push({ id: s.id, name: s.name, channels: await visibleChannelsFor(s.id, await channelsOf(s.id), username, s.role) });
    }
    return { servers };
  }

  // DMs, as the peers [{ id, username }] whose conversation with the caller may be searched.
  async function dmTargets(scope, query, me) {
    if (scope === 'dm') {
      const withName = one(query.with).trim();
      if (!withName) return fail(400, 'with is required for scope=dm');
      const peer = await getUserByUsername(withName);
      if (!peer) return fail(404, 'User not found');
      if (!(await canDirectMessage(me.id, me.username, peer.id, peer.username))) {
        return fail(403, 'You can only message friends or people you share a server with');
      }
      return { peers: [peer] };
    }
    // Everyone the caller has exchanged a message with, minus the conversations GET /messages/with
    // would refuse to open today (unfriended since, and no server in common any more).
    const everyone = await db.all(
      `SELECT u.id, u.username FROM users u
        WHERE u.id IN (SELECT recipient_id FROM direct_messages WHERE sender_id = ?
                       UNION SELECT sender_id FROM direct_messages WHERE recipient_id = ?)`,
      me.id, me.id
    );
    const peers = [];
    for (const p of everyone) {
      if (await canDirectMessage(me.id, me.username, p.id, p.username)) peers.push(p);
    }
    return { peers };
  }

  // Groups the caller is in right now, as [{ id, name }].
  async function groupTargets(scope, query, me) {
    if (scope === 'group') {
      const groupId = one(query.groupId);
      if (!groupId) return fail(400, 'groupId is required for scope=group');
      const group = await db.get(
        'SELECT g.id, g.name FROM group_members gm JOIN group_chats g ON g.id = gm.group_id WHERE gm.group_id = ? AND gm.user_id = ?',
        groupId, me.id
      );
      // 404, not 403, like every other group route: guessing ids must not reveal that a group exists.
      if (!group) return fail(404, 'Group not found');
      return { groups: [group] };
    }
    return { groups: await db.all('SELECT g.id, g.name FROM group_members gm JOIN group_chats g ON g.id = gm.group_id WHERE gm.user_id = ?', me.id) };
  }

  // --- The matching itself. Each takes limit + 1 so the caller can tell whether more exist. ---

  async function searchChannels(servers, pattern, cursor, take) {
    const searched = servers.filter((s) => s.channels.length);
    if (!searched.length) return [];
    const after = afterCursor(cursor, KIND_RANK.channel, 'm.ts', 'm.id');
    // Batches of at most CHANNELS_PER_QUERY channels, each still paired with its own server.
    const batches = [[]];
    let size = 0;
    for (const s of searched) {
      for (let i = 0; i < s.channels.length; i += CHANNELS_PER_QUERY) {
        const ids = s.channels.slice(i, i + CHANNELS_PER_QUERY).map((c) => c.id);
        if (size + ids.length > CHANNELS_PER_QUERY) { batches.push([]); size = 0; }
        batches[batches.length - 1].push({ id: s.id, ids });
        size += ids.length;
      }
    }
    let rows = [];
    for (const batch of batches) {
      rows.push(...await db.all(
        `SELECT m.id, m.author, m.text, m.ts, m.attachment_json, m.server_id, m.channel_id
           FROM messages m
          WHERE (${batch.map((b) => `(m.server_id = ? AND m.channel_id IN (${placeholders(b.ids.length)}))`).join(' OR ')})
            AND m.text LIKE ? ESCAPE '\\'${after.sql}
          ORDER BY m.ts DESC, m.id DESC LIMIT ?`,
        ...batch.flatMap((b) => [b.id, ...b.ids]), pattern, ...after.params, take
      ));
    }
    // Each batch brought its own newest `take`; the newest `take` overall are among them.
    if (batches.length > 1) {
      rows.sort((a, b) => b.ts - a.ts || b.id - a.id);
      rows = rows.slice(0, take);
    }
    const byServer = new Map(searched.map((s) => [s.id, { name: s.name, channels: new Map(s.channels.map((c) => [c.id, c.name])) }]));
    return rows.map((r) => {
      const srv = byServer.get(r.server_id);
      return result('channel', r, { serverId: r.server_id, serverName: srv.name, channelId: r.channel_id, channelName: srv.channels.get(r.channel_id) });
    });
  }

  async function searchDms(peers, me, pattern, cursor, take) {
    if (!peers.length) return [];
    const after = afterCursor(cursor, KIND_RANK.dm, 'dm.created_at', 'dm.id');
    const ids = peers.map((p) => p.id);
    const marks = placeholders(ids.length);
    const rows = await db.all(
      `SELECT dm.id, dm.body AS text, dm.created_at AS ts, dm.attachment_json, s.username AS author, dm.sender_id, dm.recipient_id
         FROM direct_messages dm JOIN users s ON s.id = dm.sender_id
        WHERE ((dm.sender_id = ? AND dm.recipient_id IN (${marks})) OR (dm.recipient_id = ? AND dm.sender_id IN (${marks})))
          AND dm.body LIKE ? ESCAPE '\\'${after.sql}
        ORDER BY dm.created_at DESC, dm.id DESC LIMIT ?`,
      me.id, ...ids, me.id, ...ids, pattern, ...after.params, take
    );
    const nameOf = new Map(peers.map((p) => [p.id, p.username]));
    return rows.map((r) => result('dm', r, { peer: nameOf.get(r.sender_id === me.id ? r.recipient_id : r.sender_id) }));
  }

  async function searchGroups(groups, pattern, cursor, take) {
    if (!groups.length) return [];
    const after = afterCursor(cursor, KIND_RANK.group, 'gm.created_at', 'gm.id');
    const rows = await db.all(
      `SELECT gm.id, gm.body AS text, gm.created_at AS ts, gm.attachment_json, u.username AS author, gm.group_id
         FROM group_messages gm JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id IN (${placeholders(groups.length)})
          AND gm.body LIKE ? ESCAPE '\\'${after.sql}
        ORDER BY gm.created_at DESC, gm.id DESC LIMIT ?`,
      ...groups.map((g) => g.id), pattern, ...after.params, take
    );
    const nameOf = new Map(groups.map((g) => [g.id, g.name || '']));
    return rows.map((r) => result('group', r, { groupId: r.group_id, groupName: nameOf.get(r.group_id) }));
  }

  // Auth runs first so the limiter knows whose bucket to count in; it still runs ahead of
  // validation, so a request that is going to be a 400 is counted like any other.
  app.get('/search', authMiddleware, rateLimit(SEARCH_LIMIT), async (req, res) => {
    // Express 4 does not catch a rejected async handler: without this, one SQL error here would be
    // an unhandled rejection and take the whole process (every socket, every call) down with it.
    try {
      return await runSearch(req, res);
    } catch (e) {
      console.error('[search] error:', e);
      return res.status(500).json({ error: 'Server error' });
    }
  });

  async function runSearch(req, res) {
    const q = one(req.query.q).trim();
    if (q.length < Q_MIN || q.length > Q_MAX) {
      return res.status(400).json({ error: `Search for between ${Q_MIN} and ${Q_MAX} characters` });
    }
    const scope = req.query.scope === undefined ? 'all' : req.query.scope;
    if (!SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of: ${SCOPES.join(', ')}` });
    let limit = LIMIT_DEFAULT;
    if (req.query.limit !== undefined) {
      if (typeof req.query.limit !== 'string' || !/^\d{1,9}$/.test(req.query.limit) || Number(req.query.limit) < 1) {
        return res.status(400).json({ error: 'limit must be a positive whole number' });
      }
      limit = Math.min(Number(req.query.limit), LIMIT_MAX);
    }
    let cursor = null;
    if (req.query.cursor !== undefined) {
      cursor = decodeCursor(req.query.cursor);
      if (!cursor) return res.status(400).json({ error: 'Invalid cursor' });
    }
    const me = await getUserByUsername(req.user.username);
    if (!me) return res.status(404).json({ error: 'User not found' });

    // Resolve every target before running any match, so a refusal can never carry results with it.
    const wantChannels = scope === 'channel' || scope === 'server' || scope === 'all';
    const wantDms = scope === 'dm' || scope === 'all';
    const wantGroups = scope === 'group' || scope === 'all';
    const channels = wantChannels ? await channelTargets(scope, req.query, me.username) : { servers: [] };
    if (channels.error) return res.status(channels.status).json({ error: channels.error });
    const dms = wantDms ? await dmTargets(scope, req.query, me) : { peers: [] };
    if (dms.error) return res.status(dms.status).json({ error: dms.error });
    const groups = wantGroups ? await groupTargets(scope, req.query, me) : { groups: [] };
    if (groups.error) return res.status(groups.status).json({ error: groups.error });

    const pattern = likePattern(q);
    const take = limit + 1;
    const found = [
      ...(await searchChannels(channels.servers, pattern, cursor, take)),
      ...(await searchDms(dms.peers, me, pattern, cursor, take)),
      ...(await searchGroups(groups.groups, pattern, cursor, take)),
    ];
    // Each kind arrived newest-first on its own; this is the merge. The order has to be the one
    // afterCursor assumes.
    found.sort((a, b) => b.message.ts - a.message.ts || KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.message.id - a.message.id);
    const hasMore = found.length > limit;
    const results = hasMore ? found.slice(0, limit) : found;
    return res.json({ results, hasMore, nextCursor: hasMore ? encodeCursor(results[results.length - 1]) : null });
  }
}

module.exports = { registerSearchRoutes, SEARCH_MAX_PER_MINUTE: SEARCH_LIMIT.max };
