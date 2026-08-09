// Voice-chat entrance clips: upload/replace/delete, type + size validation, and the delivery path
// (the joiner's clip url is broadcast to the room from the DB, never trusted from the client).
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser } = require('./helpers');

function once(socket, event, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

// A tiny stand-in for a real recording — the endpoint validates type/extension, not codec internals.
const clip = (name = 'entrance.webm', type = 'audio/webm') =>
  new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])], { type });

describe('entrance sounds', () => {
  let server, call, token, base;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    base = server.base;
    token = await makeUser(call, 'walkon');
  });
  after(async () => { await server.stop(); });

  const upload = (filename = 'entrance.webm', type = 'audio/webm') => {
    const fd = new FormData();
    fd.append('clip', clip(filename, type), filename);
    return call('POST', '/profile/entrance-sound', fd, token);
  };

  test('uploads a clip, serves it, and stores it on the profile', async () => {
    const res = await upload();
    assert.equal(res.status, 200);
    assert.match(res.data.url, /^\/entrances\//);

    const served = await fetch(base + res.data.url);
    assert.equal(served.status, 200, 'clip is served back');
    await served.arrayBuffer();

    // Persisted immediately, so closing the editor without saving doesn't lose it.
    const settings = await call('GET', '/user/settings', undefined, token);
    assert.equal(settings.data.settings.profile.entranceSound, res.data.url);
  });

  test('replacing the clip deletes the old file', async () => {
    const first = await upload();
    const second = await upload();
    assert.notEqual(first.data.url, second.data.url);
    assert.equal((await fetch(base + second.data.url)).status, 200, 'new clip serves');
    assert.equal((await fetch(base + first.data.url)).status, 404, 'old clip is gone');
  });

  test('rejects a non-audio upload', async () => {
    const fd = new FormData();
    fd.append('clip', new Blob(['#!/bin/sh\necho hi'], { type: 'application/x-sh' }), 'evil.sh');
    const res = await call('POST', '/profile/entrance-sound', fd, token);
    assert.equal(res.status, 400);
    assert.match(res.data.error, /audio/i);
  });

  test('requires a file', async () => {
    const res = await call('POST', '/profile/entrance-sound', new FormData(), token);
    assert.equal(res.status, 400);
  });

  test('requires auth', async () => {
    const fd = new FormData();
    fd.append('clip', clip(), 'entrance.webm');
    const res = await call('POST', '/profile/entrance-sound', fd);
    assert.equal(res.status, 401);
  });

  test('delete removes the file and clears the profile field', async () => {
    const up = await upload();
    const del = await call('DELETE', '/profile/entrance-sound', undefined, token);
    assert.equal(del.status, 200);
    assert.equal((await fetch(base + up.data.url)).status, 404, 'file deleted');
    const settings = await call('GET', '/user/settings', undefined, token);
    assert.equal(settings.data.settings.profile.entranceSound, '');
  });

  test('voice:join broadcasts the joiner\'s clip url to the room', async () => {
    const up = await upload();
    const listenerToken = await makeUser(call, 'listener');
    const listener = await connect(base, listenerToken);
    const joiner = await connect(base, token);
    try {
      // Both must be in the server before joining voice.
      listener.emit('join', { serverId: 'demo', name: 'listener' });
      joiner.emit('join', { serverId: 'demo', name: 'walkon' });
      await new Promise((r) => setTimeout(r, 300));

      listener.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      await new Promise((r) => setTimeout(r, 300));

      const joined = once(listener, 'voice:peer-joined');
      joiner.emit('voice:join', { serverId: 'demo', channelId: 'voice1' });
      const payload = await joined;
      assert.equal(payload.entranceSound, up.data.url, 'listener is told which clip to play');
    } finally {
      listener.close();
      joiner.close();
    }
  });

  test('a missing clip 404s instead of leaking the SPA shell', async () => {
    // An <audio> element must get a real 404, not the client HTML with a 200.
    const miss = await fetch(base + '/entrances/does-not-exist.webm');
    assert.equal(miss.status, 404);
    assert.doesNotMatch(await miss.text(), /<!doctype html>/i);
  });

  test('a user with no clip reports an empty url', async () => {
    const otherToken = await makeUser(call, 'silent');
    const a = await connect(base, token);
    const b = await connect(base, otherToken);
    try {
      a.emit('join', { serverId: 'demo', name: 'walkon' });
      b.emit('join', { serverId: 'demo', name: 'silent' });
      await new Promise((r) => setTimeout(r, 300));
      a.emit('voice:join', { serverId: 'demo', channelId: 'voice2' });
      await new Promise((r) => setTimeout(r, 300));
      const joined = once(a, 'voice:peer-joined');
      b.emit('voice:join', { serverId: 'demo', channelId: 'voice2' });
      const payload = await joined;
      assert.equal(payload.entranceSound, '');
    } finally {
      a.close();
      b.close();
    }
  });
});
