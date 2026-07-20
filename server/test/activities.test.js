// Pure unit tests for the activity state machine (no server boot needed). These lock in the initial
// shapes each activity starts from, and the Sketch & Guess rule that the secret word is only ever
// sent to the player currently drawing.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { createActivities } = require('../services/activities');

// Minimal io stub — activityInit/activityViewFor don't emit, they just read room membership.
const fakeIo = () => ({ to: () => ({ emit() {} }), sockets: { adapter: { rooms: new Map() } }, emit() {} });

describe('activities', () => {
  test('every advertised type initialises to a usable state', () => {
    const a = createActivities({ io: fakeIo(), clients: {} });
    assert.deepEqual(a.ACTIVITY_TYPES, ['watch', 'whiteboard', 'poll', 'ttt', 'sketch', 'music']);
    for (const type of a.ACTIVITY_TYPES) {
      assert.ok(a.activityInit(type), `${type} should initialise`);
    }
  });

  test('initial shapes match what the client expects', () => {
    const a = createActivities({ io: fakeIo(), clients: {} });
    assert.equal(a.activityInit('ttt').board.length, 9);
    assert.equal(a.activityInit('ttt').turn, 'X');
    assert.equal(a.activityInit('poll').closed, false);
    assert.equal(a.activityInit('sketch').phase, 'lobby');
    assert.equal(a.activityInit('music').dj, null, 'music starts with nobody as DJ');
    assert.equal(a.activityInit('music').index, -1);
    assert.equal(a.activityInit('watch').playing, false);
  });

  test('unknown activity types fall back to an empty state rather than throwing', () => {
    const a = createActivities({ io: fakeIo(), clients: {} });
    assert.deepEqual(a.activityInit('not-a-real-activity'), {});
  });

  describe('Sketch & Guess word secrecy', () => {
    const sketchInPlay = {
      type: 'sketch',
      state: { phase: 'play', word: 'dragon', players: [{ name: 'alice' }, { name: 'bob' }], turnIdx: 0 },
    };

    test('the drawer receives the word', () => {
      const a = createActivities({ io: fakeIo(), clients: { sock1: { name: 'alice' } } });
      assert.equal(a.activityViewFor(sketchInPlay, 'sock1').state.word, 'dragon');
    });

    test('guessers never receive the word', () => {
      const a = createActivities({ io: fakeIo(), clients: { sock2: { name: 'bob' } } });
      assert.equal(a.activityViewFor(sketchInPlay, 'sock2').state.word, null);
    });

    test('an unknown socket never receives the word', () => {
      const a = createActivities({ io: fakeIo(), clients: {} });
      assert.equal(a.activityViewFor(sketchInPlay, 'stranger').state.word, null);
    });

    test('the word is not withheld outside the play phase', () => {
      const a = createActivities({ io: fakeIo(), clients: {} });
      const lobby = { type: 'sketch', state: { phase: 'lobby', word: null, players: [], turnIdx: 0 } };
      assert.equal(a.activityViewFor(lobby, 'anyone'), lobby);
    });

    test('other activities pass through untouched', () => {
      const a = createActivities({ io: fakeIo(), clients: {} });
      const poll = { type: 'poll', state: { question: 'pizza?', options: [], closed: false } };
      assert.equal(a.activityViewFor(poll, 'anyone'), poll);
    });
  });
});
