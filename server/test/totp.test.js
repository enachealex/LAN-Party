// services/totp.js against the published test vectors: RFC 4648 §10 (base32), RFC 4226 Appendix D
// (HOTP) and RFC 6238 Appendix B (TOTP, SHA-1 rows). If these hold, the codes this server computes
// are the codes every authenticator app computes.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../services/totp');

// The secret both RFCs use for their SHA-1 vectors: the ASCII string "12345678901234567890".
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');

describe('base32 (RFC 4648 §10)', () => {
  const vectors = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  test('encodes the published vectors (unpadded)', () => {
    for (const [plain, encoded] of vectors) assert.equal(totp.base32Encode(Buffer.from(plain)), encoded);
  });
  test('decodes them back, with or without padding, case, spaces and dashes', () => {
    for (const [plain, encoded] of vectors) assert.equal(totp.base32Decode(encoded).toString(), plain);
    assert.equal(totp.base32Decode('MZXW6YQ=').toString(), 'foob');
    assert.equal(totp.base32Decode('mzxw 6ytb-oi').toString(), 'foobar');
  });
  test('refuses a character that is not base32', () => {
    assert.equal(totp.base32Decode('MZXW1'), null);
    assert.equal(totp.base32Decode('MZ!W6'), null);
  });
  test('a 160-bit secret survives the round trip and is 32 characters', () => {
    const secret = totp.newSecret();
    assert.equal(secret.length, 20);
    const text = totp.base32Encode(secret);
    assert.match(text, /^[A-Z2-7]{32}$/);
    assert.deepEqual(totp.base32Decode(text), secret);
  });
});

describe('HOTP (RFC 4226 Appendix D)', () => {
  test('counters 0 to 9 give the published six-digit values', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, counter) => assert.equal(totp.hotp(RFC_SECRET, counter), code, `counter ${counter}`));
  });
});

describe('TOTP (RFC 6238 Appendix B, SHA-1)', () => {
  // [unix seconds, the 8-digit value the RFC prints]
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  test('the published times give the published eight-digit values', () => {
    for (const [seconds, code] of vectors) {
      assert.equal(totp.hotp(RFC_SECRET, totp.stepAt(seconds * 1000), { digits: 8 }), code, `T=${seconds}`);
    }
  });
  test('the six-digit code an app shows is the last six of those', () => {
    for (const [seconds, code] of vectors) assert.equal(totp.totp(RFC_SECRET, seconds * 1000), code.slice(2), `T=${seconds}`);
  });
  test('the time-step is 30 seconds: 59s is step 1, 60s is step 2', () => {
    assert.equal(totp.stepAt(29_999), 0);
    assert.equal(totp.stepAt(59_000), 1);
    assert.equal(totp.stepAt(60_000), 2);
  });
});

describe('matchingStep: the drift window', () => {
  const at = 1_700_000_000_000;
  const step = totp.stepAt(at);
  const codeFor = (s) => totp.hotp(RFC_SECRET, s);

  test('accepts the current step and one either side, and says which', () => {
    assert.equal(totp.matchingStep(RFC_SECRET, codeFor(step), { nowMs: at }), step);
    assert.equal(totp.matchingStep(RFC_SECRET, codeFor(step - 1), { nowMs: at }), step - 1);
    assert.equal(totp.matchingStep(RFC_SECRET, codeFor(step + 1), { nowMs: at }), step + 1);
  });
  test('refuses two steps away in either direction', () => {
    assert.equal(totp.matchingStep(RFC_SECRET, codeFor(step - 2), { nowMs: at }), null);
    assert.equal(totp.matchingStep(RFC_SECRET, codeFor(step + 2), { nowMs: at }), null);
  });
  test('refuses anything that is not six digits, and a code for another secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 345', null, undefined, 123456.5]) {
      assert.equal(totp.matchingStep(RFC_SECRET, /** @type {any} */ (bad), { nowMs: at }), null, String(bad));
    }
    const other = Buffer.from('09876543210987654321', 'ascii');
    assert.equal(totp.matchingStep(other, codeFor(step), { nowMs: at }), null);
  });
});

describe('otpauth URI', () => {
  test('carries the issuer, the account, the secret and the parameters apps expect', () => {
    const uri = totp.otpauthUri({ secretBase32: 'JBSWY3DPEHPK3PXP', account: 'ann b', issuer: 'LAN Party' });
    assert.equal(uri, 'otpauth://totp/LAN%20Party:ann%20b?secret=JBSWY3DPEHPK3PXP&issuer=LAN%20Party&algorithm=SHA1&digits=6&period=30');
  });
});
