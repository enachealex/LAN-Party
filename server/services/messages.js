// Message plumbing: parsing/normalising the JSON blobs stored alongside a message (attachments,
// reactions, quoted replies) and turning a raw DB row into the shape the client renders.
//
// Shared by channel messages and DMs, which is why the reaction/pin helpers take a table name.

/** @param {{ db: any }} deps */
function createMessages({ db }) {
  function parseAttachment(value) {
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function normalizeAttachment(value) {
    if (!value || typeof value !== 'object') return null;
    const url = typeof value.url === 'string' ? value.url : '';
    const name = typeof value.name === 'string' ? value.name : 'Attachment';
    // Allow ephemeral uploads and persistent GIF-library files.
    if (!url || !(url.startsWith('/uploads/') || url.startsWith('/gifs/'))) return null;
    return {
      url,
      name,
      size: Number(value.size) || 0,
      type: typeof value.type === 'string' ? value.type : 'application/octet-stream',
    };
  }

  // Raw stored reactions: { emoji: [username, ...] }.
  function parseReactions(value) {
    if (!value) return {};
    try {
      const obj = JSON.parse(value);
      return obj && typeof obj === 'object' ? obj : {};
    } catch {
      return {};
    }
  }

  // Format raw reactions for a given viewer: { emoji: { count, mine } }, dropping empties.
  function formatReactions(raw, forUsername) {
    const out = {};
    for (const [emoji, users] of Object.entries(raw || {})) {
      const list = Array.isArray(users) ? users : [];
      if (list.length === 0) continue;
      out[emoji] = { count: list.length, mine: forUsername ? list.includes(forUsername) : false };
    }
    return out;
  }

  // Quoted replies on a message: sanitize client-supplied quotes on write. Each quote is a
  // snapshot { id, author, ts, text } of the message being replied to; capped and de-duplicated
  // (the same message can't be quoted twice in one reply).
  function sanitizeQuotes(quotes) {
    if (!Array.isArray(quotes)) return null;
    const out = [];
    const seen = new Set();
    for (const q of quotes.slice(0, 10)) {
      if (!q || typeof q !== 'object') continue;
      const id = q.id != null ? String(q.id).slice(0, 64) : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const author = typeof q.author === 'string' ? q.author.slice(0, 64) : '';
      const text = typeof q.text === 'string' ? q.text.slice(0, 300) : '';
      if (!author && !text) continue;
      out.push({ id, author, ts: Number.isFinite(q.ts) ? q.ts : null, text });
    }
    return out.length ? out : null;
  }
  function parseQuotes(value) {
    if (!value) return null;
    try {
      const arr = JSON.parse(value);
      return Array.isArray(arr) && arr.length ? arr : null;
    } catch {
      return null;
    }
  }

  function mapMessageRow(row, forUsername) {
    return {
      id: row.id,
      author: row.author,
      text: row.text || '',
      ts: row.ts,
      attachment: parseAttachment(row.attachment_json),
      reactions: formatReactions(parseReactions(row.reactions_json), forUsername),
      quotes: parseQuotes(row.quotes_json),
      pinnedAt: row.pinned_at || null,
      pinnedBy: row.pinned_by || null,
    };
  }

  // Pinned messages of a channel, newest pin first (so pins[0] is what the pinned bar shows).
  async function channelPins(serverId, channelId, forUsername) {
    const rows = await db.all(
      'SELECT id, author, text, ts, attachment_json, reactions_json, quotes_json, pinned_at, pinned_by FROM messages WHERE server_id = ? AND channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC',
      serverId, channelId
    );
    return (rows || []).map((m) => mapMessageRow(m, forUsername));
  }

  // Toggle a user's reaction on a message row (table = 'messages' | 'direct_messages').
  // Returns the raw reactions object after toggling.
  async function toggleReaction(table, id, username, emoji) {
    const idCol = 'id';
    const row = await db.get(`SELECT reactions_json FROM ${table} WHERE ${idCol} = ?`, id);
    if (!row) return null;
    const raw = parseReactions(row.reactions_json);
    const list = Array.isArray(raw[emoji]) ? raw[emoji] : [];
    const idx = list.indexOf(username);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(username);
    if (list.length === 0) delete raw[emoji];
    else raw[emoji] = list;
    await db.run(`UPDATE ${table} SET reactions_json = ? WHERE ${idCol} = ?`, JSON.stringify(raw), id);
    return raw;
  }

  return {
    parseAttachment, normalizeAttachment, parseReactions, formatReactions,
    sanitizeQuotes, parseQuotes, mapMessageRow, channelPins, toggleReaction,
  };
}

module.exports = { createMessages };
