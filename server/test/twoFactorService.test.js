// services/twoFactor.js against an in-memory database and a clock the test owns, for what cannot
// be shown through a running server in reasonable time: the edges of the drift window, expiry of a
// pending setup and of a ticket, and the pause ending by itself. The HTTP surface is
// test/twoFactor.test.js.
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { migrate } = require('../db/schema');
const totp = require('../services/totp');
const { createTwoFactor, SETUP_TTL_MS, TICKET_TTL_SECONDS, MAX_FAILURES, LOCK_MS, RECOVERY_CODE_COUNT } = require('../services/twoFactor');
const { deriveKey } = require('../services/hostedApps');

const SECRET = 'a-server-secret';
const STEP = 30_000;

describe('two-factor service', () => {
  /** @type {any} */ let db;
  /** @type {ReturnType<typeof createTwoFactor>} */ let tf;
  let clock = 0;
  const ann = { id: 1, username: 'ann' };
  const ben = { id: 2, username: 'ben' };

  beforeEach(async () => {
    db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await migrate(db);
    await db.run("INSERT INTO users (username, email, password_hash, settings) VALUES ('ann', 'ann@example.com', 'x', '{}'), ('ben', 'ben@example.com', 'x', '{}')");
    clock = 1_700_000_010_000; // ten seconds into a step
    tf = createTwoFactor({ db, secret: SECRET, now: () => clock });
  });

  const codeAt = (secretBase32, offsetSteps = 0) => totp.totp(totp.base32Decode(secretBase32), clock + offsetSteps * STEP);
  /** Set two-factor up for a user and return { secret, recoveryCodes }. */
  async function enable(user) {
    const started = await tf.beginSetup(user);
    assert.ok(started.ok);
    const done = await tf.confirmSetup(user.id, codeAt(started.secret));
    assert.ok(done.ok, 'setup confirmed');
    clock += 2 * STEP; // past every step the confirmation could have used
    return { secret: started.secret, recoveryCodes: done.recoveryCodes };
  }

  test('setup: nothing is on until a current code confirms it, and then ten recovery codes come back', async () => {
    const started = await tf.beginSetup(ann);
    assert.ok(started.ok);
    assert.match(started.secret, /^[A-Z2-7]{32}$/, '160 bits of base32');
    assert.equal(started.otpauthUri, `otpauth://totp/LAN%20Party:ann?secret=${started.secret}&issuer=LAN%20Party&algorithm=SHA1&digits=6&period=30`);
    assert.equal(started.expiresIn, SETUP_TTL_MS / 1000);
    assert.equal(await tf.isEnabled(ann.id), false);
    assert.deepEqual(await tf.statusOf(ann.id), { enabled: false, enabledAt: null, recoveryCodesRemaining: 0, setupPending: true });

    assert.deepEqual(await tf.confirmSetup(ann.id, '000000'), { ok: false, reason: 'bad-code' });
    assert.equal(await tf.isEnabled(ann.id), false, 'a wrong code turns nothing on');

    const done = await tf.confirmSetup(ann.id, codeAt(started.secret));
    assert.ok(done.ok);
    assert.equal(done.recoveryCodes.length, RECOVERY_CODE_COUNT);
    assert.equal(new Set(done.recoveryCodes).size, RECOVERY_CODE_COUNT, 'all different');
    for (const code of done.recoveryCodes) assert.match(code, /^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    assert.deepEqual(await tf.statusOf(ann.id), { enabled: true, enabledAt: clock, recoveryCodesRemaining: RECOVERY_CODE_COUNT, setupPending: false });
    assert.deepEqual(await tf.beginSetup(ann), { ok: false, reason: 'enabled' }, 'cannot be restarted over a live one');
  });

  test('a pending setup expires after 15 minutes and can be restarted with a new secret', async () => {
    const first = await tf.beginSetup(ann);
    assert.ok(first.ok);
    clock += SETUP_TTL_MS + 1;
    assert.deepEqual(await tf.confirmSetup(ann.id, codeAt(first.secret)), { ok: false, reason: 'no-setup' });
    assert.equal((await tf.statusOf(ann.id)).setupPending, false);

    const second = await tf.beginSetup(ann);
    assert.ok(second.ok);
    assert.notEqual(second.secret, first.secret);
    assert.deepEqual(await tf.confirmSetup(ann.id, codeAt(first.secret)), { ok: false, reason: 'bad-code' }, 'the abandoned secret is gone');
    assert.ok((await tf.confirmSetup(ann.id, codeAt(second.secret))).ok);
  });

  test('restarting replaces the pending secret before it expires as well', async () => {
    const first = await tf.beginSetup(ann);
    const second = await tf.beginSetup(ann);
    assert.ok(first.ok && second.ok);
    assert.deepEqual(await tf.confirmSetup(ann.id, codeAt(first.secret)), { ok: false, reason: 'bad-code' });
    assert.ok((await tf.confirmSetup(ann.id, codeAt(second.secret))).ok);
  });

  test('what is stored: the secret encrypted, bound to the account and to the server secret; recovery codes hashed', async () => {
    const started = await tf.beginSetup(ann);
    assert.ok(started.ok);
    const raw = totp.base32Decode(started.secret);
    const holds = (text) => text.includes(started.secret) || text.includes(raw.toString('hex')) || text.includes(raw.toString('base64')) || text.includes(raw.toString('base64url'));

    const pending = await db.get('SELECT * FROM user_two_factor WHERE user_id = 1');
    assert.equal(pending.secret_enc, null);
    assert.match(pending.pending_enc, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(holds(JSON.stringify(pending)), false, 'the pending row does not hold the secret in any plain encoding');

    const done = await tf.confirmSetup(ann.id, codeAt(started.secret));
    assert.ok(done.ok);
    const row = await db.get('SELECT * FROM user_two_factor WHERE user_id = 1');
    assert.equal(row.pending_enc, null);
    assert.equal(holds(JSON.stringify(row)), false, 'nor does the live one');

    // Two encryptions of anything differ (a fresh nonce each time).
    await tf.beginSetup(ben);
    await tf.beginSetup(ben);
    assert.notEqual(row.secret_enc, (await db.get('SELECT pending_enc FROM user_two_factor WHERE user_id = 2')).pending_enc);

    // Copied onto another account, the ciphertext does not open: ben cannot be given ann's secret.
    await db.run('DELETE FROM user_two_factor WHERE user_id = 2');
    await db.run('INSERT INTO user_two_factor (user_id, secret_enc, enabled_at) VALUES (2, ?, ?)', row.secret_enc, clock);
    clock += 2 * STEP;
    assert.deepEqual(await tf.verifySecondFactor(ben.id, { code: codeAt(started.secret) }), { ok: false, reason: 'bad-code' });

    // Under a different server secret it does not open either.
    const elsewhere = createTwoFactor({ db, secret: 'another-secret', now: () => clock });
    assert.deepEqual(await elsewhere.verifySecondFactor(ann.id, { code: codeAt(started.secret) }), { ok: false, reason: 'bad-code' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(started.secret) }), { ok: true, method: 'totp' }, 'while the real one still does');

    // Recovery codes: ten rows of 64 hex characters, none of them a code or a plain hash of one.
    const stored = await db.all('SELECT code_hash, used_at FROM two_factor_recovery_codes WHERE user_id = 1');
    assert.equal(stored.length, RECOVERY_CODE_COUNT);
    const crypto = require('node:crypto');
    for (const s of stored) {
      assert.match(s.code_hash, /^[0-9a-f]{64}$/);
      assert.equal(s.used_at, null);
    }
    const hashes = new Set(stored.map((s) => s.code_hash));
    for (const code of done.recoveryCodes) {
      const bare = code.replace(/-/g, '');
      assert.equal(JSON.stringify(stored).includes(bare), false);
      assert.equal(hashes.has(crypto.createHash('sha256').update(bare).digest('hex')), false, 'keyed, not a bare SHA-256');
      assert.equal(hashes.has(crypto.createHash('sha256').update(code).digest('hex')), false);
    }
  });

  test('drift: the previous and the next step are accepted, two steps away is not', async () => {
    const { secret } = await enable(ann);
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret, -2) }), { ok: false, reason: 'bad-code' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret, 2) }), { ok: false, reason: 'bad-code' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret, -1) }), { ok: true, method: 'totp' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret, 0) }), { ok: true, method: 'totp' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret, 1) }), { ok: true, method: 'totp' });
  });

  test('replay: a code works once, and so does nothing older than the last one accepted', async () => {
    const { secret } = await enable(ann);
    const current = codeAt(secret);
    const previous = codeAt(secret, -1);
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: current }), { ok: true, method: 'totp' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: current }), { ok: false, reason: 'bad-code' }, 'the same code again');
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: previous }), { ok: false, reason: 'bad-code' }, 'an older code that is still inside the window');
    clock += STEP;
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: current }), { ok: false, reason: 'bad-code' }, 'still refused one step later');
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret) }), { ok: true, method: 'totp' }, 'the next code is fine');
  });

  test('replay: the code that confirmed setup cannot then be used to sign in', async () => {
    const started = await tf.beginSetup(ann);
    assert.ok(started.ok);
    const code = codeAt(started.secret);
    assert.ok((await tf.confirmSetup(ann.id, code)).ok);
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code }), { ok: false, reason: 'bad-code' });
  });

  test('two requests racing with the same code: exactly one wins', async () => {
    const { secret } = await enable(ann);
    const code = codeAt(secret);
    const results = await Promise.all([1, 2, 3, 4].map(() => tf.verifySecondFactor(ann.id, { code })));
    assert.equal(results.filter((r) => r.ok).length, 1);
  });

  test('a recovery code works once, in any spelling, and only for its own account', async () => {
    const { recoveryCodes } = await enable(ann);
    await enable(ben);
    const [first, second] = recoveryCodes;
    assert.deepEqual(await tf.verifySecondFactor(ben.id, { recoveryCode: first }), { ok: false, reason: 'bad-code' }, "ann's code is nothing to ben");
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { recoveryCode: first }), { ok: true, method: 'recovery' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { recoveryCode: first }), { ok: false, reason: 'bad-code' }, 'used up');
    assert.equal((await tf.statusOf(ann.id)).recoveryCodesRemaining, RECOVERY_CODE_COUNT - 1);
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { recoveryCode: ` ${second.toLowerCase().replace(/-/g, ' ')} ` }), { ok: true, method: 'recovery' }, 'lower case, spaces for dashes');
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { recoveryCode: recoveryCodes[2] }, { allowRecovery: false }), { ok: false, reason: 'bad-code' }, 'not where only the app will do');
  });

  test('regenerating recovery codes kills the old ones', async () => {
    const { recoveryCodes } = await enable(ann);
    const fresh = await tf.replaceRecoveryCodes(ann.id);
    assert.equal(fresh.length, RECOVERY_CODE_COUNT);
    assert.equal(fresh.some((c) => recoveryCodes.includes(c)), false);
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { recoveryCode: recoveryCodes[0] }), { ok: false, reason: 'bad-code' });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { recoveryCode: fresh[0] }), { ok: true, method: 'recovery' });
  });

  test(`lockout: ${MAX_FAILURES} wrong answers pause the second step, even for the right code, and the pause ends by itself`, async () => {
    const { secret, recoveryCodes } = await enable(ann);
    for (let i = 1; i < MAX_FAILURES; i++) {
      assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: '000000' }), { ok: false, reason: 'bad-code' }, `wrong answer ${i}`);
    }
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: '000000' }), { ok: false, reason: 'locked', retryAfter: LOCK_MS / 1000 });
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret) }), { ok: false, reason: 'locked', retryAfter: LOCK_MS / 1000 }, 'the right code is not even looked at');
    assert.equal((await tf.verifySecondFactor(ann.id, { recoveryCode: recoveryCodes[0] })).reason, 'locked');
    assert.equal((await tf.statusOf(ann.id)).recoveryCodesRemaining, RECOVERY_CODE_COUNT, 'and a recovery code offered meanwhile is not used up');

    clock += LOCK_MS - 1000;
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret) }), { ok: false, reason: 'locked', retryAfter: 1 });
    clock += 1000;
    assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: codeAt(secret) }), { ok: true, method: 'totp' });
  });

  test('a right answer resets the count: four wrong, one right, four wrong is not a lockout', async () => {
    const { recoveryCodes } = await enable(ann);
    for (let i = 0; i < MAX_FAILURES - 1; i++) await tf.verifySecondFactor(ann.id, { code: '000000' });
    assert.ok((await tf.verifySecondFactor(ann.id, { recoveryCode: recoveryCodes[0] })).ok);
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      assert.deepEqual(await tf.verifySecondFactor(ann.id, { code: '000000' }), { ok: false, reason: 'bad-code' });
    }
  });

  test('wrong codes while confirming a setup lock that too', async () => {
    const started = await tf.beginSetup(ann);
    assert.ok(started.ok);
    for (let i = 1; i < MAX_FAILURES; i++) assert.deepEqual(await tf.confirmSetup(ann.id, '000000'), { ok: false, reason: 'bad-code' });
    assert.deepEqual(await tf.confirmSetup(ann.id, '000000'), { ok: false, reason: 'locked', retryAfter: LOCK_MS / 1000 });
    assert.equal((await tf.confirmSetup(ann.id, codeAt(started.secret))).reason, 'locked');
    // Starting again does not lift the pause.
    const again = await tf.beginSetup(ann);
    assert.ok(again.ok);
    assert.equal((await tf.confirmSetup(ann.id, codeAt(again.secret))).reason, 'locked');
    clock += LOCK_MS;
    assert.ok((await tf.confirmSetup(ann.id, codeAt(again.secret))).ok);
  });

  describe('tickets', () => {
    test('a ticket plus a current code signs in once', async () => {
      const { secret } = await enable(ann);
      const { ticket, expiresIn } = await tf.issueTicket(ann, true);
      assert.equal(expiresIn, TICKET_TTL_SECONDS);
      assert.deepEqual(tf.readTicket(ticket) && tf.readTicket(ticket).uid, ann.id);
      assert.deepEqual(await tf.redeemTicket(ticket, { code: codeAt(secret) }), { ok: true, userId: ann.id, remember: true, method: 'totp' });
      clock += STEP;
      assert.deepEqual(await tf.redeemTicket(ticket, { code: codeAt(secret) }), { ok: false, reason: 'invalid' }, 'spent, even with a fresh code');
    });

    test('it is not a session: signed with its own key, and it names no account', async () => {
      await enable(ann);
      const { ticket } = await tf.issueTicket(ann, false);
      assert.throws(() => jwt.verify(ticket, SECRET), /invalid signature/, 'the server secret does not verify it');
      const claims = /** @type {any} */ (jwt.decode(ticket));
      assert.equal(claims.username, undefined);
      assert.equal(claims.purpose, '2fa');
      assert.equal(claims.aud, 'lanparty-2fa');
      assert.equal(claims.exp - claims.iat, TICKET_TTL_SECONDS);
      // And the other way round: a session token is not a ticket.
      const session = jwt.sign({ username: 'ann' }, SECRET, { expiresIn: '7d' });
      assert.equal(tf.readTicket(session), null);
      // Nor is a look-alike signed with the server secret itself rather than the derived key.
      const forged = jwt.sign({ purpose: '2fa', uid: ann.id, jti: 'x' }, SECRET, { audience: 'lanparty-2fa', expiresIn: 300 });
      assert.equal(tf.readTicket(forged), null);
      assert.deepEqual(await tf.redeemTicket(forged, { code: '123456' }), { ok: false, reason: 'invalid' });
    });

    test('a correctly signed ticket with no row is dead (it was used, or never issued)', async () => {
      const { secret } = await enable(ann);
      const key = deriveKey(SECRET, 'lanparty:2fa-ticket:v1');
      const orphan = jwt.sign({ purpose: '2fa', uid: ann.id, remember: false, jti: 'never-issued' }, key, { audience: 'lanparty-2fa', expiresIn: 300 });
      assert.ok(tf.readTicket(orphan), 'the signature holds');
      assert.deepEqual(await tf.redeemTicket(orphan, { code: codeAt(secret) }), { ok: false, reason: 'invalid' });
      // One made out to another account than its row.
      const { ticket } = await tf.issueTicket(ann, false);
      const swapped = jwt.sign({ purpose: '2fa', uid: ben.id, remember: false, jti: tf.readTicket(ticket).jti }, key, { audience: 'lanparty-2fa', expiresIn: 300 });
      assert.deepEqual(await tf.redeemTicket(swapped, { code: codeAt(secret) }), { ok: false, reason: 'invalid' });
    });

    test('it expires after five minutes, by the row even if the signature were still good', async () => {
      const { secret } = await enable(ann);
      const { ticket } = await tf.issueTicket(ann, false);
      clock += TICKET_TTL_SECONDS * 1000 + 1;
      // jwt checks expiry against the real clock, which has not moved: this is the row's expiry.
      assert.ok(tf.readTicket(ticket));
      assert.deepEqual(await tf.redeemTicket(ticket, { code: codeAt(secret) }), { ok: false, reason: 'invalid' });
      // And the signature's own expiry, against the real clock.
      const key = deriveKey(SECRET, 'lanparty:2fa-ticket:v1');
      const stale = jwt.sign({ purpose: '2fa', uid: ann.id, jti: 'stale', iat: Math.floor(Date.now() / 1000) - 600 }, key, { audience: 'lanparty-2fa', expiresIn: 300 });
      assert.equal(tf.readTicket(stale), null);
    });

    test('expired rows are swept when the next ticket is issued', async () => {
      await enable(ann);
      await tf.issueTicket(ann, false);
      clock += TICKET_TTL_SECONDS * 1000 + 1;
      await tf.issueTicket(ann, false);
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM login_tickets')).n, 1);
    });

    test(`${MAX_FAILURES} wrong codes kill the ticket and pause the account; a new ticket does not help until the pause ends`, async () => {
      const { secret } = await enable(ann);
      const { ticket } = await tf.issueTicket(ann, false);
      const other = await tf.issueTicket(ann, false);
      for (let i = 1; i < MAX_FAILURES; i++) assert.deepEqual(await tf.redeemTicket(ticket, { code: '000000' }), { ok: false, reason: 'invalid' });
      assert.deepEqual(await tf.redeemTicket(ticket, { code: '000000' }), { ok: false, reason: 'locked', retryAfter: LOCK_MS / 1000 });
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM login_tickets')).n, 0, 'every outstanding ticket of the account is gone');
      assert.deepEqual(await tf.redeemTicket(ticket, { code: codeAt(secret) }), { ok: false, reason: 'invalid' }, 'the ticket is dead');
      assert.deepEqual(await tf.redeemTicket(other.ticket, { code: codeAt(secret) }), { ok: false, reason: 'invalid' }, 'so is the other one');

      const fresh = await tf.issueTicket(ann, false);
      assert.deepEqual(await tf.redeemTicket(fresh.ticket, { code: codeAt(secret) }), { ok: false, reason: 'locked', retryAfter: LOCK_MS / 1000 });
      clock += LOCK_MS;
      const later = await tf.issueTicket(ann, false);
      assert.equal((await tf.redeemTicket(later.ticket, { code: codeAt(secret) })).ok, true);
    });

    test('wrong codes spread over several tickets still add up on the account', async () => {
      await enable(ann);
      let last;
      for (let i = 0; i < MAX_FAILURES; i++) {
        const { ticket } = await tf.issueTicket(ann, false);
        last = await tf.redeemTicket(ticket, { code: '000000' });
      }
      assert.equal(last.reason, 'locked');
    });

    test('a ticket for an account whose two-factor was removed meanwhile is dead', async () => {
      const { secret } = await enable(ann);
      const { ticket } = await tf.issueTicket(ann, false);
      await tf.remove(ann.id);
      assert.deepEqual(await tf.redeemTicket(ticket, { code: codeAt(secret) }), { ok: false, reason: 'invalid' });
      assert.deepEqual(await tf.statusOf(ann.id), { enabled: false, enabledAt: null, recoveryCodesRemaining: 0, setupPending: false });
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM two_factor_recovery_codes')).n, 0);
    });
  });
});
