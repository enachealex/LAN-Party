// @ts-check
// Who runs this LAN Party instance. Roles everywhere else are per server (owner/admin/member of one
// community); a few decisions belong to the whole installation instead — today, which uploaded apps
// are published to everyone (routes/library.js).
//
// By default that is the OLDEST account: whoever set the instance up registered first, and a row's
// id never changes, so a rename keeps the role. INSTANCE_OWNERS (comma-separated usernames) replaces
// that default entirely when it names anyone. The names are matched exactly, and a name with no
// account matches nobody — so the role would go to whoever TOOK a listed name: by registering it
// before its owner did, by renaming into it after its owner renamed away or deleted the account, or
// by registering a spelling that differs only in case from a real account when the list has the
// other spelling (usernames are case-sensitive). Three things close that:
//   - a listed name is reserved, whatever its case: nobody can register it or rename into it
//     (isReservedName, asked by /auth/register and POST /user/username), so the accounts have to
//     exist BEFORE they are listed;
//   - an account that holds the role by name cannot rename away from it (isListedName) — the list
//     does not follow a rename, and the role would be lost without a word;
//   - configProblems() is logged at boot: every listed name that no account has, exactly as written.
//
// Asked on every use rather than cached: the default depends on the users table (the oldest account
// can be deleted, and the next oldest then holds the role), and the answer gates what people may
// do, so it must never be a stale one.

/**
 * @param {string | undefined | null} raw the INSTANCE_OWNERS value
 * @returns {string[]} the usernames it names, trimmed, without empty entries or repeats
 */
function parseInstanceOwners(raw) {
  const names = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set(names)];
}

/**
 * @param {{ db: { get: (sql: string, ...params: any[]) => Promise<any> }, env?: Record<string, string | undefined> }} deps
 */
function createInstanceOwners({ db, env = process.env }) {
  const configured = parseInstanceOwners(env.INSTANCE_OWNERS);
  const configuredLower = configured.map((n) => n.toLowerCase());

  /** @returns {Promise<string[]>} usernames of the instance owners (empty only when nobody has registered) */
  async function instanceOwners() {
    if (configured.length) return configured;
    const first = await db.get('SELECT username FROM users ORDER BY id ASC LIMIT 1');
    return first ? [first.username] : [];
  }

  /**
   * @param {string | null | undefined} username taken from a verified token, never from a request body
   * @returns {Promise<boolean>}
   */
  async function isInstanceOwner(username) {
    if (typeof username !== 'string' || !username) return false;
    return (await instanceOwners()).includes(username);
  }

  /**
   * Whether INSTANCE_OWNERS lists this name in any spelling of its case. Such a name is not
   * available to register or rename into.
   * @param {unknown} name
   * @returns {boolean}
   */
  function isReservedName(name) {
    return typeof name === 'string' && configuredLower.includes(name.toLowerCase());
  }

  /**
   * Whether INSTANCE_OWNERS lists exactly this name: the account called this holds the role by name.
   * @param {unknown} name
   * @returns {boolean}
   */
  function isListedName(name) {
    return typeof name === 'string' && configured.includes(name);
  }

  /**
   * What is wrong with the INSTANCE_OWNERS list as it stands, one line per name, for the boot log.
   * @returns {Promise<string[]>}
   */
  async function configProblems() {
    const problems = [];
    for (const listed of configured) {
      if (await db.get('SELECT id FROM users WHERE username = ?', listed)) continue;
      const near = await db.get('SELECT username FROM users WHERE LOWER(username) = LOWER(?)', listed);
      problems.push(near
        ? `INSTANCE_OWNERS lists "${listed}", but the account is spelled "${near.username}". Names are matched exactly, so that account is NOT an instance owner. Fix the spelling in INSTANCE_OWNERS.`
        : `INSTANCE_OWNERS lists "${listed}", and no account has that name. Nobody holds the role under it, and the name cannot be registered while it is listed: create the account first, then list it.`);
    }
    return problems;
  }

  return { instanceOwners, isInstanceOwner, isReservedName, isListedName, configProblems };
}

module.exports = { createInstanceOwners, parseInstanceOwners };
