// @ts-check
// The order channels are listed in, and the categories they are grouped under.
//
// A CATEGORY IS PRESENTATION ONLY. It is a heading in the channel list and nothing else: it never
// decides who can open a channel. A private channel inside a category keeps its own access list
// (services/permissions.js), and a member is only shown a category that holds at least one channel
// they can see.
//
// ORDER. channels.position is NULL until a channel is first moved; such channels are listed in the
// order they were created, after any that have been placed. That is the order every server had
// before positions existed, so a server nobody has reordered lists its channels as it always did.
// Order only means something inside one list: a category, or (outside any category) the text
// channels and the voice channels, which the client shows as two sections.

const MAX_CATEGORIES = 30;
const CATEGORY_NAME_MAX = 32;

/**
 * @typedef {import('../db/migrate').Db} Db
 * @typedef {{ id: string, name: string, type: string, privacy: string, categoryId: string | null }} Channel
 * @typedef {{ id: string, name: string, position: number }} Category
 * @param {{ db: Db }} deps
 */
function createChannels({ db }) {
  /**
   * A server's channels in listing order. categoryId is null for a channel in no category, and
   * for one whose category no longer exists.
   * @param {string} serverId
   * @returns {Promise<Channel[]>}
   */
  function listChannels(serverId) {
    return db.all(
      `SELECT c.id, c.name, c.type, COALESCE(c.privacy, 'public') AS privacy,
              (SELECT cat.id FROM channel_categories cat WHERE cat.id = c.category_id AND cat.server_id = c.server_id) AS categoryId
         FROM channels c WHERE c.server_id = ?
        ORDER BY (c.position IS NULL), c.position, c.rowid`,
      serverId
    );
  }

  /** @param {string} serverId @returns {Promise<Category[]>} */
  function listCategories(serverId) {
    return db.all('SELECT id, name, position FROM channel_categories WHERE server_id = ? ORDER BY position, rowid', serverId);
  }

  /**
   * The categories to show someone: those holding a channel they can see, or all of them for
   * someone who manages channels (who has to be able to fill an empty one).
   * @param {Category[]} categories @param {{ categoryId: string | null }[]} visibleChannels @param {boolean} managesChannels
   */
  function categoriesFor(categories, visibleChannels, managesChannels) {
    if (managesChannels) return categories;
    const used = new Set(visibleChannels.map((c) => c.categoryId).filter(Boolean));
    return categories.filter((c) => used.has(c.id));
  }

  /**
   * The list a channel is ordered within, in order: its category, or the uncategorised channels
   * of its type.
   * @param {string} serverId @param {{ type: string, categoryId: string | null }} channel
   */
  async function siblingsOf(serverId, channel) {
    const all = await listChannels(serverId);
    return channel.categoryId
      ? all.filter((c) => c.categoryId === channel.categoryId)
      : all.filter((c) => !c.categoryId && c.type === channel.type);
  }

  /** Write 0..n-1 over a list, in the order given. @param {{ id: string }[]} list */
  async function writeChannelOrder(list) {
    for (let i = 0; i < list.length; i++) await db.run('UPDATE channels SET position = ? WHERE id = ?', i, list[i].id);
  }

  /**
   * Swap an item with its neighbour. @template T @param {T[]} list @param {number} index @param {'up' | 'down'} direction
   * @returns {T[] | null} the new order, or null when it is already at that end
   */
  function swapped(list, index, direction) {
    const other = direction === 'up' ? index - 1 : index + 1;
    if (index < 0 || other < 0 || other >= list.length) return null;
    const next = list.slice();
    [next[index], next[other]] = [next[other], next[index]];
    return next;
  }

  /**
   * Move a channel one place up or down its list.
   * @param {string} serverId @param {string} channelId @param {'up' | 'down'} direction
   * @returns {Promise<boolean | null>} whether it moved; null for a channel that is not in this server
   */
  async function moveChannel(serverId, channelId, direction) {
    const channel = (await listChannels(serverId)).find((c) => c.id === channelId);
    if (!channel) return null;
    const list = await siblingsOf(serverId, channel);
    const next = swapped(list, list.findIndex((c) => c.id === channelId), direction);
    if (!next) return false;
    await writeChannelOrder(next);
    return true;
  }

  /**
   * Put a channel in a category (or, with null, in none), at the end of the list it joins.
   * @param {string} serverId @param {string} channelId @param {string | null} categoryId
   * @returns {Promise<boolean>} whether anything changed
   */
  async function setChannelCategory(serverId, channelId, categoryId) {
    const channel = (await listChannels(serverId)).find((c) => c.id === channelId);
    if (!channel || channel.categoryId === categoryId) return false;
    const joining = (await siblingsOf(serverId, { type: channel.type, categoryId })).filter((c) => c.id !== channelId);
    await db.run('UPDATE channels SET category_id = ? WHERE id = ? AND server_id = ?', categoryId, channelId, serverId);
    await writeChannelOrder([...joining, channel]);
    return true;
  }

  /**
   * Move a category one place up or down.
   * @param {string} serverId @param {string} categoryId @param {'up' | 'down'} direction
   * @returns {Promise<boolean | null>} whether it moved; null for a category that is not in this server
   */
  async function moveCategory(serverId, categoryId, direction) {
    const list = await listCategories(serverId);
    const index = list.findIndex((c) => c.id === categoryId);
    if (index < 0) return null;
    const next = swapped(list, index, direction);
    if (!next) return false;
    for (let i = 0; i < next.length; i++) await db.run('UPDATE channel_categories SET position = ? WHERE id = ?', i + 1, next[i].id);
    return true;
  }

  /**
   * Delete a category. Its channels are never deleted with it: they go back to being in none,
   * with their messages and their access lists as they were.
   * @param {string} serverId @param {string} categoryId
   */
  async function deleteCategory(serverId, categoryId) {
    await db.run('UPDATE channels SET category_id = NULL, position = NULL WHERE server_id = ? AND category_id = ?', serverId, categoryId);
    await db.run('DELETE FROM channel_categories WHERE id = ? AND server_id = ?', categoryId, serverId);
  }

  return { listChannels, listCategories, categoriesFor, moveChannel, setChannelCategory, moveCategory, deleteCategory };
}

module.exports = { createChannels, MAX_CATEGORIES, CATEGORY_NAME_MAX };
