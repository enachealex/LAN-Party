// History paging. A conversation is read a page at a time (newest first, then backwards by message
// id), so what matters is that the pages join up: no message twice, none missing, and the two
// "is there more" flags telling the truth at both ends. The same windowing serves channels, DMs and
// groups, so each is walked end to end, and each is checked for who may NOT read it.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');

function once(socket, event, match = () => true, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onEvent = (payload) => {
      if (!match(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    };
    const timer = setTimeout(() => { socket.off(event, onEvent); reject(new Error(`timed out waiting for "${event}"`)); }, timeoutMs);
    socket.on(event, onEvent);
  });
}

const texts = (res) => res.data.messages.map((m) => m.text);
const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

// Read a whole conversation the way a client scrolling up does: newest page, then `before` the
// oldest message held, until the server says there is nothing older.
async function walkBack(get, limit) {
  const pages = [];
  let res = await get(`limit=${limit}`);
  for (;;) {
    assert.equal(res.status, 200, JSON.stringify(res.data));
    pages.unshift(res.data.messages);
    if (!res.data.hasMore) break;
    assert.ok(res.data.messages.length > 0, 'a page that promises more must not be empty');
    res = await get(`limit=${limit}&before=${res.data.messages[0].id}`);
    if (pages.length > 50) throw new Error('paging did not terminate');
  }
  return pages;
}

// The checks every kind of conversation has to pass. `get(query)` reads it, `all` is every message
// in it as stored ({ id, text }, oldest first), read straight from the database so the expectation
// does not come from the code under test.
async function checkPaging(get, all) {
  const n = all.length;
  const allTexts = all.map((m) => m.text);
  assert.ok(n >= 60, 'needs more than one page of history');

  // No cursor: the newest page, oldest-first, and it says older messages exist.
  const newest = await get('');
  assert.equal(newest.status, 200);
  assert.deepEqual(texts(newest), allTexts.slice(n - 50));
  assert.equal(newest.data.hasMore, true);
  assert.equal(newest.data.hasMoreAfter, false);

  // Walking backwards reaches the very first message with no duplicates and no gaps.
  const pages = await walkBack(get, 25);
  assert.deepEqual(pages.flat().map((m) => m.id), all.map((m) => m.id));
  assert.equal(pages.length, Math.ceil(n / 25));

  // around: the target is in the window, about half the page either side of it.
  const mid = Math.floor(n / 2);
  const middle = await get(`around=${all[mid].id}&limit=11`);
  assert.deepEqual(texts(middle), allTexts.slice(mid - 5, mid + 6));
  assert.equal(middle.data.hasMore, true);
  assert.equal(middle.data.hasMoreAfter, true);

  const start = await get(`around=${all[0].id}&limit=11`);
  assert.equal(start.data.messages[0].id, all[0].id);
  assert.deepEqual(texts(start), allTexts.slice(0, 6), 'nothing older to fill the first half with');
  assert.equal(start.data.hasMore, false);
  assert.equal(start.data.hasMoreAfter, true);

  const end = await get(`around=${all[n - 1].id}&limit=11`);
  assert.deepEqual(texts(end), allTexts.slice(n - 6));
  assert.equal(end.data.hasMore, true);
  assert.equal(end.data.hasMoreAfter, false);

  const wide = await get(`around=${all[mid].id}`);
  assert.equal(wide.data.messages.length, 50, 'default page size');
  assert.ok(wide.data.messages.some((m) => m.id === all[mid].id));

  // after: forwards from a message, exclusive.
  const fwd = await get(`after=${all[9].id}&limit=10`);
  assert.deepEqual(texts(fwd), allTexts.slice(10, 20));
  assert.equal(fwd.data.hasMore, true);
  assert.equal(fwd.data.hasMoreAfter, true);
  const tail = await get(`after=${all[n - 4].id}&limit=10`);
  assert.deepEqual(texts(tail), allTexts.slice(n - 3));
  assert.equal(tail.data.hasMoreAfter, false);
  const pastEnd = await get(`after=${all[n - 1].id}`);
  assert.deepEqual(pastEnd.data.messages, []);
  assert.equal(pastEnd.data.hasMore, true, 'everything is older than an empty page past the end');
  assert.equal(pastEnd.data.hasMoreAfter, false);
  const pastStart = await get(`before=${all[0].id}`);
  assert.deepEqual(pastStart.data.messages, []);
  assert.equal(pastStart.data.hasMore, false);
  assert.equal(pastStart.data.hasMoreAfter, true);

  // The limit is the client's to ask for, and the server's to cap.
  assert.equal((await get('limit=1')).data.messages.length, 1);
  assert.equal((await get('limit=100000')).data.messages.length, Math.min(n, 100));

  // A broken cursor is a 400. It must not crash, and must not fall back to "here is everything".
  for (const bad of ['before=abc', 'before=-5', 'after=1.5', 'around=', 'before=0', 'after=1e3', 'around=%207',
    'limit=0', 'limit=-1', 'limit=lots', 'before=1&after=2', 'before=1&before=2', 'before[]=1']) {
    const res = await get(bad);
    assert.equal(res.status, 400, `${bad} -> ${res.status}`);
    assert.equal(res.data.messages, undefined, `${bad} must not return messages`);
  }
}

describe('history paging', () => {
  let server, call, tok, serverId, generalId, privateId, groupId;
  const sockets = [];

  const connect = async (name) => {
    const socket = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token: tok[name] } });
    await once(socket, 'connect');
    sockets.push(socket);
    return socket;
  };
  // Channel messages only exist as socket events; wait for each echo so they are stored in order.
  const say = async (socket, channelId, text) => {
    const echoed = once(socket, 'message', (m) => m.text === text && m.channelId === channelId);
    socket.emit('message', { serverId, channelId, text });
    await echoed;
  };
  const stored = (sql, params) => dbAll(server.dataDir, sql, params);
  const channelGet = (channelId, token) => (query) => call('GET', `/servers/${serverId}/channels/${channelId}/messages?${query}`, undefined, token);

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    tok = {};
    for (const name of ['ann', 'ben', 'cat', 'dan']) tok[name] = await makeUser(call, name);

    // ann owns a server; ben and cat are members; only ben is let into the private channel. dan is a
    // stranger to all of them.
    serverId = (await call('POST', '/servers', { name: 'Paging Test' }, tok.ann)).data.server.id;
    for (const name of ['ben', 'cat']) await call('POST', `/servers/${serverId}/invite`, { username: name }, tok.ann);
    privateId = (await call('POST', `/servers/${serverId}/channels`, { name: 'officers', privacy: 'private', members: ['ben'] }, tok.ann)).data.channel.id;

    const ann = await connect('ann');
    ann.emit('join', { serverId, name: 'ann' });
    generalId = (await once(ann, 'server:state')).server.channels.find((c) => c.name === 'general').id;
    ann.emit('joinChannel', { serverId, channelId: generalId });
    await once(ann, 'messages:init', (p) => p.channelId === generalId);
    for (let i = 1; i <= 120; i++) await say(ann, generalId, `c${i}`);
    ann.emit('joinChannel', { serverId, channelId: privateId });
    await once(ann, 'messages:init', (p) => p.channelId === privateId);
    for (let i = 1; i <= 3; i++) await say(ann, privateId, `p${i}`);

    // A DM between ann and ben, both directions, and a group of ann, ben and cat.
    for (let i = 1; i <= 64; i++) {
      const [from, to] = i % 2 ? ['ann', 'ben'] : ['ben', 'ann'];
      assert.equal((await call('POST', '/messages/send', { toUsername: to, text: `d${i}` }, tok[from])).status, 200);
    }
    const group = await call('POST', '/groups', { name: 'trio', members: ['ben', 'cat'] }, tok.ann);
    assert.equal(group.status, 200, JSON.stringify(group.data));
    groupId = group.data.group.id;
    for (let i = 1; i <= 64; i++) {
      assert.equal((await call('POST', `/groups/${groupId}/messages`, { text: `g${i}` }, tok[i % 2 ? 'ann' : 'ben'])).status, 200);
    }
  });
  after(async () => { for (const s of sockets) s.close(); await server.stop(); });

  describe('channels', () => {
    test("opening a channel sends only the newest page, and says whether there is more", async () => {
      const ben = await connect('ben');
      // 'join' drops the socket into the first text channel, which is general.
      const init = once(ben, 'messages:init', (p) => p.channelId === generalId);
      ben.emit('join', { serverId, name: 'ben' });
      const first = await init;
      assert.deepEqual(first.messages.map((m) => m.text), range('c', 71, 120));
      assert.equal(first.hasMore, true);

      const again = once(ben, 'messages:init', (p) => p.channelId === generalId);
      ben.emit('joinChannel', { serverId, channelId: generalId });
      const second = await again;
      assert.deepEqual(second.messages.map((m) => m.text), range('c', 71, 120));
      assert.equal(second.hasMore, true);

      // A short channel fits in one page.
      const short = once(ben, 'messages:init', (p) => p.channelId === privateId);
      ben.emit('joinChannel', { serverId, channelId: privateId });
      const priv = await short;
      assert.deepEqual(priv.messages.map((m) => m.text), ['p1', 'p2', 'p3']);
      assert.equal(priv.hasMore, false);
    });

    test('the pages join up: newest, before, around, after, limits and bad cursors', async () => {
      const all = await stored('SELECT id, text FROM messages WHERE server_id = ? AND channel_id = ? ORDER BY id', [serverId, generalId]);
      assert.deepEqual(all.map((m) => m.text), range('c', 1, 120));
      await checkPaging(channelGet(generalId, tok.cat), all);
    });

    test('messages come back in the shape the socket sends them', async () => {
      const res = await channelGet(generalId, tok.ben)('limit=1');
      const m = res.data.messages[0];
      assert.equal(m.text, 'c120');
      assert.equal(m.author, 'ann');
      for (const key of ['id', 'ts', 'attachment', 'reactions', 'quotes', 'edited', 'editedAt', 'pinnedAt', 'pinnedBy']) {
        assert.ok(key in m, `message.${key}`);
      }
    });

    test('a cursor from another channel cannot pull that channel in', async () => {
      // Ids are global, so a private channel's id is a valid number to send. It only positions the
      // window; the rows are still this channel's.
      const priv = await stored('SELECT id FROM messages WHERE channel_id = ? ORDER BY id', [privateId]);
      for (const query of [`around=${priv[1].id}`, `before=${priv[2].id}`, `after=${priv[0].id - 30}`]) {
        const res = await channelGet(generalId, tok.cat)(query);
        assert.equal(res.status, 200);
        assert.ok(res.data.messages.every((m) => /^c\d+$/.test(m.text)), query);
      }
    });

    test('refuses a non-member, and a member who is not in the private channel', async () => {
      assert.equal((await channelGet(generalId, tok.dan)('')).status, 403, 'not in the server');
      assert.equal((await channelGet(privateId, tok.dan)('')).status, 403);
      const cat = await channelGet(privateId, tok.cat)('');
      assert.equal(cat.status, 403, 'in the server, not in the channel');
      assert.equal(cat.data.messages, undefined);
      // The people who can open it by joining can page it.
      assert.deepEqual(texts(await channelGet(privateId, tok.ben)('')), ['p1', 'p2', 'p3']);
      assert.deepEqual(texts(await channelGet(privateId, tok.ann)('')), ['p1', 'p2', 'p3']);
      // Access is checked before the cursor, so a refusal never depends on what was asked for.
      assert.equal((await channelGet(privateId, tok.cat)('before=abc')).status, 403);

      assert.equal((await channelGet('ch-nope', tok.ann)('')).status, 404);
      // A real channel id under a server it does not belong to is not a channel.
      assert.equal((await call('GET', `/servers/demo/channels/${privateId}/messages`, undefined, tok.cat)).status, 404);
      assert.equal((await call('GET', `/servers/${serverId}/channels/${generalId}/messages`)).status, 401);
    });

    test('reading history does not mark the channel read', async () => {
      // cat has never opened general, so all of it is unread, and paging through it must not change that.
      const unread = async () => (await call('GET', '/unreads', undefined, tok.cat)).data.unreads[serverId][generalId];
      assert.equal(await unread(), 120);
      await channelGet(generalId, tok.cat)('');
      await channelGet(generalId, tok.cat)('limit=100');
      assert.equal(await unread(), 120);
    });

    // GET /user/sync is the other way channel messages leave the server. It used to hand every
    // server's whole history to anyone with a token, which made the refusals above pointless.
    test('the login sync only carries what the caller may open, a page at a time', async () => {
      const sync = async (name) => {
        const res = await call('GET', '/user/sync', undefined, tok[name]);
        assert.equal(res.status, 200);
        return res.data.servers;
      };
      const texts = (srv, channelId) => srv.messages[channelId].map((m) => m.text);

      // A stranger: the commons, and nothing of ann's server anywhere in the body.
      const dan = await sync('dan');
      assert.deepEqual(Object.keys(dan), ['demo']);
      assert.ok(!JSON.stringify(dan).includes(generalId));

      // A member without the private channel: general's newest page, and no trace of the private one.
      const cat = (await sync('cat'))[serverId];
      assert.deepEqual(texts(cat, generalId), Array.from({ length: 50 }, (_, i) => `c${i + 71}`));
      assert.ok(!cat.channels.some((c) => c.id === privateId));
      assert.equal(cat.messages[privateId], undefined);

      // The member who was let in, and the owner, get it.
      assert.deepEqual(texts((await sync('ben'))[serverId], privateId), ['p1', 'p2', 'p3']);
      assert.deepEqual(texts((await sync('ann'))[serverId], privateId), ['p1', 'p2', 'p3']);
      assert.equal((await call('GET', '/user/sync')).status, 401);
    });
  });

  describe('direct messages', () => {
    const dmGet = (peer, token) => (query) => call('GET', `/messages/with/${peer}?${query}`, undefined, token);

    test('the pages join up, from either side', async () => {
      const all = await stored('SELECT id, body AS text FROM direct_messages ORDER BY id');
      assert.deepEqual(all.map((m) => m.text), range('d', 1, 64));
      await checkPaging(dmGet('ben', tok.ann), all);
      const pages = await walkBack(dmGet('ann', tok.ben), 50);
      assert.deepEqual(pages.flat().map((m) => m.text), range('d', 1, 64));
    });

    test('still reports the unread total, and markRead still marks read', async () => {
      const peek = await dmGet('ben', tok.ann)('limit=5');
      assert.equal(peek.data.totalUnread, 32, 'everything ben sent is unread until asked otherwise');
      // A refused request changes nothing, even if it asked to mark read.
      assert.equal((await dmGet('ben', tok.ann)('markRead=1&before=abc')).status, 400);
      assert.equal((await dmGet('ben', tok.ann)('limit=5')).data.totalUnread, 32);
      const read = await dmGet('ben', tok.ann)('markRead=1&limit=5');
      assert.equal(read.data.totalUnread, 0);
      assert.deepEqual(texts(read), range('d', 60, 64));
    });

    test('a stranger is refused, and a third person sees none of it', async () => {
      const stranger = await dmGet('ann', tok.dan)('');
      assert.equal(stranger.status, 403);
      assert.equal(stranger.data.messages, undefined);
      assert.equal((await dmGet('nobody-here', tok.ann)('')).status, 404);
      // cat shares a server with ann, so the conversation opens, but it is cat's with ann: empty.
      const mine = await stored('SELECT id FROM direct_messages ORDER BY id');
      for (const query of ['', `around=${mine[30].id}`, `before=${mine[63].id}`, `after=${mine[0].id}`]) {
        const res = await dmGet('ann', tok.cat)(query);
        assert.equal(res.status, 200);
        assert.deepEqual(res.data.messages, [], query);
      }
      assert.equal((await dmGet('ann', tok.cat)('')).data.hasMore, false);
    });
  });

  describe('groups', () => {
    const groupGet = (token) => (query) => call('GET', `/groups/${groupId}/messages?${query}`, undefined, token);

    test('the pages join up', async () => {
      const all = await stored('SELECT id, body AS text FROM group_messages WHERE group_id = ? ORDER BY id', [groupId]);
      assert.deepEqual(all.map((m) => m.text), range('g', 1, 64));
      await checkPaging(groupGet(tok.cat), all);
    });

    test('markRead still marks read, and only when the request is good', async () => {
      const unread = async () => (await call('GET', '/groups', undefined, tok.cat)).data.groups.find((g) => g.id === groupId).unreadCount;
      assert.equal(await unread(), 64);
      assert.equal((await groupGet(tok.cat)('markRead=1&around=nope')).status, 400);
      assert.equal(await unread(), 64);
      assert.equal((await groupGet(tok.cat)('markRead=1&limit=3')).status, 200);
      assert.equal(await unread(), 0);
    });

    test('a non-member gets a 404, whatever they ask for', async () => {
      for (const query of ['', 'before=10', 'around=1', 'before=abc']) {
        const res = await groupGet(tok.dan)(query);
        assert.equal(res.status, 404, query);
        assert.equal(res.data.messages, undefined);
      }
    });
  });
});
