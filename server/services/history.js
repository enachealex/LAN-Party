// @ts-check
// History paging, shared by the three kinds of conversation (channel, DM, group).
//
// A conversation used to be sent whole every time it was opened, which grows without bound. Now it
// is read a page at a time, keyed on the message row id: ids are AUTOINCREMENT, so id order is
// arrival order, and unlike a timestamp an id is never shared by two messages, so a cursor can never
// skip or repeat one. Pages are always handed back oldest-first, whichever way they were walked.
//
// The three routes differ only in which rows belong to the conversation, so each describes that as a
// HistorySource and the windowing lives here once.

const PAGE_DEFAULT = 50;
const PAGE_MAX = 100;

/**
 * @typedef {{ all: (sql: string, ...params: any[]) => Promise<any[]>, get: (sql: string, ...params: any[]) => Promise<any> }} Db
 * @typedef {{ mode: 'latest' | 'before' | 'after' | 'around', id: number, limit: number }} PageRequest
 * @typedef {{
 *   columns: string,   // SELECT list, in the shape mapMessageRow reads
 *   from: string,      // table(s), with any JOINs
 *   where: string,     // which rows are this conversation; code-controlled, values go in params
 *   params: any[],
 *   idCol: string,     // the message id column, qualified if `from` joins
 * }} HistorySource
 * @typedef {{ rows: any[], hasMore: boolean, hasMoreAfter: boolean }} Page
 */

// Digits only: Number() alone would wave through '', ' 7 ', '1e3' and '0x10'.
/** @param {unknown} value @returns {number | null} */
function positiveInt(value) {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 ? n : null;
}

/**
 * Read before/after/around/limit off a query string. A cursor that is not a positive integer is an
 * error rather than "no cursor": quietly falling back to the newest page would hand a client that
 * sent a broken cursor the wrong messages, and it would splice them into the wrong place.
 * @param {Record<string, any>} query
 * @returns {{ error: string } | PageRequest}
 */
function parsePageQuery(query) {
  const q = query || {};
  let limit = PAGE_DEFAULT;
  if (q.limit !== undefined) {
    const n = positiveInt(q.limit);
    if (n == null) return { error: 'limit must be a positive whole number' };
    limit = Math.min(n, PAGE_MAX);
  }
  const given = /** @type {const} */ (['before', 'after', 'around']).filter((k) => q[k] !== undefined);
  if (given.length > 1) return { error: 'Use only one of before, after or around' };
  if (!given.length) return { mode: 'latest', id: 0, limit };
  const id = positiveInt(q[given[0]]);
  if (id == null) return { error: `${given[0]} must be a message id` };
  return { mode: given[0], id, limit };
}

/**
 * One page of a conversation.
 *
 * hasMore / hasMoreAfter say whether messages exist beyond the page's old / new edge. Each is found
 * by asking for one row more than the page holds (or, for the edge the cursor sits on, by probing
 * for a single row), never by counting the conversation.
 * @param {Db} db @param {HistorySource} source @param {PageRequest} page
 * @returns {Promise<Page>}
 */
async function fetchPage(db, source, page) {
  const { columns, from, where, params, idCol } = source;
  const select = `SELECT ${columns} FROM ${from} WHERE (${where})`;

  // Up to n rows on one side of `id`, nearest first, plus whether there were more than n.
  /** @param {string} op @param {'ASC' | 'DESC'} dir @param {number | null} id @param {number} n */
  const side = async (op, dir, id, n) => {
    const rows = id == null
      ? await db.all(`${select} ORDER BY ${idCol} ${dir} LIMIT ?`, ...params, n + 1)
      : await db.all(`${select} AND ${idCol} ${op} ? ORDER BY ${idCol} ${dir} LIMIT ?`, ...params, id, n + 1);
    const more = rows.length > n;
    return { rows: more ? rows.slice(0, n) : rows, more };
  };
  /** @param {string} op @param {number} id */
  const exists = async (op, id) =>
    !!(await db.get(`SELECT 1 AS one FROM ${from} WHERE (${where}) AND ${idCol} ${op} ? LIMIT 1`, ...params, id));

  if (page.mode === 'after') {
    const newer = await side('>', 'ASC', page.id, page.limit);
    // <= so the cursor message itself counts: the caller already holds it, but it is older than this page.
    return { rows: newer.rows, hasMore: await exists('<=', page.id), hasMoreAfter: newer.more };
  }
  if (page.mode === 'around') {
    // About half before, then the target and the rest after it. The newer side is ">=" so the target
    // rides along with it; if it has been deleted since, the window still lands where it used to be.
    const beforeCount = Math.floor((page.limit - 1) / 2);
    const older = beforeCount > 0
      ? await side('<', 'DESC', page.id, beforeCount)
      : { rows: [], more: await exists('<', page.id) };
    const newer = await side('>=', 'ASC', page.id, page.limit - beforeCount);
    return { rows: [...older.rows.reverse(), ...newer.rows], hasMore: older.more, hasMoreAfter: newer.more };
  }
  const older = await side('<', 'DESC', page.mode === 'before' ? page.id : null, page.limit);
  return {
    rows: older.rows.reverse(),
    hasMore: older.more,
    hasMoreAfter: page.mode === 'before' ? await exists('>=', page.id) : false,
  };
}

/**
 * A channel's messages. Lives here because both the socket layer ('messages:init') and the HTTP
 * route page over it and have to agree on the columns.
 * @param {string} serverId @param {string} channelId
 * @returns {HistorySource}
 */
function channelHistory(serverId, channelId) {
  return {
    columns: 'id, author, text, ts, attachment_json, reactions_json, quotes_json, edited_at, pinned_at, pinned_by',
    from: 'messages',
    where: 'server_id = ? AND channel_id = ?',
    params: [serverId, channelId],
    idCol: 'id',
  };
}

module.exports = { PAGE_DEFAULT, PAGE_MAX, parsePageQuery, fetchPage, channelHistory };
