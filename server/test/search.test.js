// Message search. It reads across every conversation at once, which makes it the easiest place to
// leak one, so most of this file is about what search must NOT return: a private channel's messages
// to a member without access, another server's, somebody else's DMs, a group the caller is not in.
// The rest is the matching (substring, case-insensitive, % and _ literal) and the paging.
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { startServer, apiFor, makeUser, dbAll } = require('./helpers');
const { SEARCH_MAX_PER_MINUTE } = require('../routes/search');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const found = (res) => res.data.results.map((r) => r.message.text);
const key = (r) => `${r.kind}:${r.message.id}`;

describe('message search', () => {
  let server, call, tok, serverId, generalId, privateId, otherServerId, otherGeneralId, groupId, otherGroupId;
  const sockets = [];

  // Search is rate limited per account (that test is at the bottom of the file). Each person here
  // also searches from an address of their own, as they would in life; the limit must not care.
  const search = async (token, params) => {
    const who = Object.keys(tok).findIndex((name) => tok[name] === token);
    const headers = { 'X-Forwarded-For': `192.0.2.${who + 1}` };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${server.base}/search?${new URLSearchParams(params)}`, { headers });
    return { status: res.status, data: await res.json() };
  };

  // A socket sitting in one server, able to post to any channel of it that its user may use.
  const joined = async (name, sid) => {
    const socket = io(server.base, { transports: ['websocket'], forceNew: true, auth: { token: tok[name] } });
    await once(socket, 'connect');
    sockets.push(socket);
    const state = once(socket, 'server:state');
    socket.emit('join', { serverId: sid, name });
    return { socket, state: await state };
  };
  // The echo only reaches sockets in the channel's room, so be in it (and wait to be) before posting.
  const say = async (socket, sid, channelId, text) => {
    const entered = once(socket, 'channel:joined', (p) => p.channelId === channelId);
    socket.emit('joinChannel', { serverId: sid, channelId });
    await entered;
    const stored = once(socket, 'message', (m) => m.text === text && m.channelId === channelId);
    socket.emit('message', { serverId: sid, channelId, text });
    await stored;
  };
  const dm = async (from, to, text) => assert.equal((await call('POST', '/messages/send', { toUsername: to, text }, tok[from])).status, 200);
  const groupSay = async (from, gid, text) => assert.equal((await call('POST', `/groups/${gid}/messages`, { text }, tok[from])).status, 200);

  let annSocket;

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    tok = {};
    for (const name of ['ann', 'ben', 'cat', 'dan', 'eve']) tok[name] = await makeUser(call, name);

    // ann owns a server; ben, cat and eve are members; only ben is let into the private channel.
    // dan is a stranger to all of them, with a server of his own.
    serverId = (await call('POST', '/servers', { name: 'Search Test' }, tok.ann)).data.server.id;
    for (const name of ['ben', 'cat', 'eve']) await call('POST', `/servers/${serverId}/invite`, { username: name }, tok.ann);
    privateId = (await call('POST', `/servers/${serverId}/channels`, { name: 'officers', privacy: 'private', members: ['ben'] }, tok.ann)).data.channel.id;
    otherServerId = (await call('POST', '/servers', { name: 'Elsewhere' }, tok.dan)).data.server.id;

    // Two groups: ann is in the first and not in the second.
    const g1 = await call('POST', '/groups', { name: 'with ann', members: ['ben', 'cat'] }, tok.ann);
    assert.equal(g1.status, 200, JSON.stringify(g1.data));
    groupId = g1.data.group.id;
    const g2 = await call('POST', '/groups', { name: 'without ann', members: ['cat', 'eve'] }, tok.ben);
    assert.equal(g2.status, 200, JSON.stringify(g2.data));
    otherGroupId = g2.data.group.id;

    const ann = await joined('ann', serverId);
    annSocket = ann.socket;
    generalId = ann.state.server.channels.find((c) => c.name === 'general').id;
    const dan = await joined('dan', otherServerId);
    otherGeneralId = dan.state.server.channels.find((c) => c.name === 'general').id;

    // The "pizza" messages, one per place a message can live. Spaced out so that each has its own
    // timestamp and "newest first" has exactly one right answer.
    const pizza = [
      () => say(annSocket, serverId, generalId, 'Pizza night is ON'),
      () => dm('ann', 'ben', 'pizza in a DM'),
      () => groupSay('ann', groupId, 'group PIZZA order'),
      () => say(annSocket, serverId, privateId, 'secret pizza budget'),
      () => dm('ben', 'cat', 'pizza gossip about ann'),
      () => groupSay('ben', otherGroupId, 'pizza without ann'),
      () => say(dan.socket, otherServerId, otherGeneralId, 'pizza at the other place'),
      () => say(annSocket, serverId, generalId, 'who wants pizza'),
      () => dm('ben', 'ann', 'yes to piZZa'),
    ];
    for (const post of pizza) { await post(); await sleep(8); }

    // For the wildcard tests: each literal has a decoy that only a wildcard would match.
    for (const text of ['100% sure', '1000 points', 'snake_case rules', 'snakeXcase nope', 'back\\slash here', 'backslash there']) {
      await say(annSocket, serverId, generalId, text);
    }
  });
  after(async () => { for (const s of sockets) s.close(); await server.stop(); });

  test('finds a substring, whatever its case, and says where each result lives', async () => {
    const res = await search(tok.ann, { q: 'pIzZa', scope: 'channel', serverId, channelId: generalId });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(found(res), ['who wants pizza', 'Pizza night is ON'], 'newest first');
    assert.equal(res.data.hasMore, false);
    assert.equal(res.data.nextCursor, null);

    const hit = res.data.results[0];
    assert.deepEqual(Object.keys(hit).sort(), ['channelId', 'channelName', 'groupId', 'groupName', 'kind', 'message', 'peer', 'serverId', 'serverName']);
    assert.deepEqual({ ...hit, message: null }, {
      kind: 'channel', serverId, serverName: 'Search Test', channelId: generalId, channelName: 'general',
      peer: null, groupId: null, groupName: null, message: null,
    });
    assert.deepEqual(Object.keys(hit.message).sort(), ['attachment', 'author', 'id', 'text', 'ts']);
    assert.equal(hit.message.author, 'ann');
    assert.equal(hit.message.attachment, null);

    // In the middle of a word, and trimmed.
    assert.deepEqual(found(await search(tok.ann, { q: '  izz  ', scope: 'channel', serverId, channelId: generalId })), ['who wants pizza', 'Pizza night is ON']);
    assert.deepEqual(found(await search(tok.ann, { q: 'no such words', scope: 'all' })), []);
  });

  test('% and _ in the query are the characters themselves, not wildcards', async () => {
    const inGeneral = (q) => search(tok.ann, { q, scope: 'channel', serverId, channelId: generalId });
    assert.deepEqual(found(await inGeneral('100%')), ['100% sure']);
    assert.deepEqual(found(await inGeneral('0% s')), ['100% sure']);
    assert.deepEqual(found(await inGeneral('e_c')), ['snake_case rules']);
    assert.deepEqual(found(await inGeneral('k\\s')), ['back\\slash here']);
    assert.deepEqual(found(await inGeneral('%%')), [], 'not "match anything"');
    assert.deepEqual(found(await inGeneral('__')), []);
  });

  test("a private channel's messages only reach people who can open it", async () => {
    // cat is in the server but not in the private channel.
    for (const params of [{ scope: 'all' }, { scope: 'server', serverId }, {}]) {
      const res = await search(tok.cat, { q: 'secret', ...params });
      assert.equal(res.status, 200);
      assert.deepEqual(found(res), [], JSON.stringify(params));
    }
    const direct = await search(tok.cat, { q: 'secret', scope: 'channel', serverId, channelId: privateId });
    assert.equal(direct.status, 403);
    assert.equal(direct.data.results, undefined);
    // Nor does a broader query that happens to match it.
    assert.ok(!found(await search(tok.cat, { q: 'pizza', scope: 'server', serverId })).includes('secret pizza budget'));

    // ben was granted access; ann owns the server.
    for (const who of ['ben', 'ann']) {
      for (const params of [{ scope: 'all' }, { scope: 'server', serverId }, { scope: 'channel', serverId, channelId: privateId }]) {
        const res = await search(tok[who], { q: 'secret', ...params });
        assert.deepEqual(found(res), ['secret pizza budget'], `${who} ${JSON.stringify(params)}`);
        assert.equal(res.data.results[0].channelName, 'officers');
      }
    }
  });

  test('access to a private channel is read at search time, not remembered', async () => {
    await call('POST', `/servers/${serverId}/channels/${privateId}/members`, { username: 'eve' }, tok.ann);
    assert.deepEqual(found(await search(tok.eve, { q: 'secret', scope: 'all' })), ['secret pizza budget']);
    await call('DELETE', `/servers/${serverId}/channels/${privateId}/members/eve`, undefined, tok.ann);
    assert.deepEqual(found(await search(tok.eve, { q: 'secret', scope: 'all' })), []);
    assert.equal((await search(tok.eve, { q: 'secret', scope: 'channel', serverId, channelId: privateId })).status, 403);
  });

  test('a server you are not in is refused by id and absent from everything else', async () => {
    assert.equal((await search(tok.dan, { q: 'pizza', scope: 'server', serverId })).status, 403);
    assert.equal((await search(tok.dan, { q: 'pizza', scope: 'channel', serverId, channelId: generalId })).status, 403);
    assert.equal((await search(tok.ann, { q: 'pizza', scope: 'channel', serverId: otherServerId, channelId: otherGeneralId })).status, 403);
    assert.deepEqual(found(await search(tok.dan, { q: 'pizza', scope: 'all' })), ['pizza at the other place']);
    assert.ok(!found(await search(tok.ann, { q: 'pizza', scope: 'all' })).includes('pizza at the other place'));

    assert.equal((await search(tok.ann, { q: 'pizza', scope: 'server', serverId: 'srv-nope' })).status, 404);
    assert.equal((await search(tok.ann, { q: 'pizza', scope: 'channel', serverId, channelId: 'ch-nope' })).status, 404);
    // A channel named under a server it does not belong to is not a channel.
    assert.equal((await search(tok.dan, { q: 'pizza', scope: 'channel', serverId: otherServerId, channelId: generalId })).status, 404);
  });

  test("direct messages: only the caller's own conversations", async () => {
    // ben and cat talked about ann. ann must not find it by any route.
    for (const params of [{ scope: 'all' }, { scope: 'dm', with: 'ben' }, { scope: 'dm', with: 'cat' }]) {
      const res = await search(tok.ann, { q: 'gossip', ...params });
      assert.equal(res.status, 200);
      assert.deepEqual(found(res), [], JSON.stringify(params));
    }
    assert.deepEqual(found(await search(tok.cat, { q: 'gossip', scope: 'all' })), ['pizza gossip about ann']);

    // One conversation, seen from each end: `peer` is the other person.
    const mine = await search(tok.ann, { q: 'pizza', scope: 'dm', with: 'ben' });
    assert.deepEqual(found(mine), ['yes to piZZa', 'pizza in a DM']);
    assert.deepEqual(mine.data.results.map((r) => [r.kind, r.peer, r.message.author]), [['dm', 'ben', 'ben'], ['dm', 'ben', 'ann']]);
    const theirs = await search(tok.ben, { q: 'pizza', scope: 'dm', with: 'ann' });
    assert.deepEqual(theirs.data.results.map((r) => r.peer), ['ann', 'ann']);
    // ben is in two DM conversations; asking for one does not include the other.
    assert.deepEqual(found(await search(tok.ben, { q: 'pizza', scope: 'dm', with: 'cat' })), ['pizza gossip about ann']);

    // A stranger cannot open a conversation with ann, so cannot search one either.
    assert.equal((await search(tok.dan, { q: 'pizza', scope: 'dm', with: 'ann' })).status, 403);
    assert.equal((await search(tok.ann, { q: 'pizza', scope: 'dm', with: 'nobody-here' })).status, 404);
    assert.equal((await search(tok.ann, { q: 'pizza', scope: 'dm' })).status, 400);
  });

  test('groups: only the ones the caller is in', async () => {
    for (const params of [{ scope: 'all' }, {}]) {
      assert.deepEqual(found(await search(tok.ann, { q: 'without', ...params })), []);
    }
    const direct = await search(tok.ann, { q: 'without', scope: 'group', groupId: otherGroupId });
    assert.equal(direct.status, 404, 'the same answer as a group that does not exist');
    assert.equal(direct.data.results, undefined);
    assert.equal((await search(tok.ann, { q: 'without', scope: 'group', groupId: 'grp-0000000000000000' })).status, 404);
    assert.equal((await search(tok.ann, { q: 'without', scope: 'group' })).status, 400);

    const res = await search(tok.eve, { q: 'pizza', scope: 'group', groupId: otherGroupId });
    assert.deepEqual(found(res), ['pizza without ann']);
    assert.deepEqual({ ...res.data.results[0], message: null }, {
      kind: 'group', serverId: null, serverName: null, channelId: null, channelName: null, peer: null,
      groupId: otherGroupId, groupName: 'without ann', message: null,
    });
    // cat is in both groups; asking for one does not include the other.
    assert.deepEqual(found(await search(tok.cat, { q: 'pizza', scope: 'group', groupId })), ['group PIZZA order']);
  });

  test('scope=all merges channels, DMs and groups, newest first', async () => {
    const res = await search(tok.ann, { q: 'pizza', scope: 'all' });
    assert.deepEqual(found(res), [
      'yes to piZZa',         // dm
      'who wants pizza',      // channel
      'secret pizza budget',  // private channel (ann owns the server)
      'group PIZZA order',    // group
      'pizza in a DM',        // dm
      'Pizza night is ON',    // channel
    ]);
    assert.deepEqual(res.data.results.map((r) => r.kind), ['dm', 'channel', 'channel', 'group', 'dm', 'channel']);
    const ts = res.data.results.map((r) => r.message.ts);
    assert.deepEqual(ts, [...ts].sort((a, b) => b - a));
    // No scope means all.
    assert.deepEqual(found(await search(tok.ann, { q: 'pizza' })), found(res));

    // The same query as cat: no private channel, none of ann's DMs, but both of cat's groups.
    assert.deepEqual(found(await search(tok.cat, { q: 'pizza', scope: 'all' })), [
      'who wants pizza', 'pizza without ann', 'pizza gossip about ann', 'group PIZZA order', 'Pizza night is ON',
    ]);
  });

  test('the cursor pages through everything once: no duplicates, nothing skipped', async () => {
    for (let i = 1; i <= 20; i++) {
      await say(annSocket, serverId, generalId, `needle c${i}`);
      await dm('ann', 'ben', `needle d${i}`);
      await groupSay('ann', groupId, `needle g${i}`);
    }
    // Force the hard case: many results sharing a timestamp, within a conversation and across the
    // three kinds. A tie is where a cursor that only compared timestamps would repeat or drop one.
    const base = Date.now();
    await dbAll(server.dataDir, "UPDATE messages SET ts = ? + (id % 3) WHERE text LIKE 'needle %'", [base]);
    await dbAll(server.dataDir, "UPDATE direct_messages SET created_at = ? + (id % 3) WHERE body LIKE 'needle %'", [base]);
    await dbAll(server.dataDir, "UPDATE group_messages SET created_at = ? + (id % 3) WHERE body LIKE 'needle %'", [base]);
    const whole = await search(tok.ann, { q: 'needle', scope: 'all', limit: '50' });
    assert.equal(whole.data.results.length, 50);
    assert.equal(whole.data.hasMore, true);
    assert.equal(typeof whole.data.nextCursor, 'string');

    const seen = [];
    let cursor;
    for (let page = 0; ; page++) {
      const res = await search(tok.ann, { q: 'needle', scope: 'all', limit: '7', ...(cursor ? { cursor } : {}) });
      assert.equal(res.status, 200, JSON.stringify(res.data));
      seen.push(...res.data.results.map(key));
      if (!res.data.hasMore) { assert.equal(res.data.nextCursor, null); break; }
      assert.equal(res.data.results.length, 7);
      cursor = res.data.nextCursor;
      if (page > 20) throw new Error('paging did not terminate');
    }
    assert.equal(seen.length, 60);
    assert.equal(new Set(seen).size, 60, 'no result twice');
    assert.deepEqual(seen.slice(0, 50), whole.data.results.map(key), 'the pages are the one list, cut up');

    // Default page size, and the cap on a requested one.
    assert.equal((await search(tok.ann, { q: 'needle' })).data.results.length, 25);
    assert.equal((await search(tok.ann, { q: 'needle', limit: '100000' })).data.results.length, 50);
    // A cursor works within one conversation too.
    const first = await search(tok.ann, { q: 'needle', scope: 'group', groupId, limit: '15' });
    const second = await search(tok.ann, { q: 'needle', scope: 'group', groupId, limit: '15', cursor: first.data.nextCursor });
    assert.equal(first.data.results.length, 15);
    assert.deepEqual([...found(first), ...found(second)].sort(), Array.from({ length: 20 }, (_, i) => `needle g${i + 1}`).sort());
    assert.equal(second.data.hasMore, false);
  });

  test('leaving a group takes its messages out of your results', async () => {
    assert.ok(found(await search(tok.cat, { q: 'PIZZA order' })).includes('group PIZZA order'));
    assert.equal((await call('DELETE', `/groups/${groupId}/members/cat`, undefined, tok.ann)).status, 200);
    assert.deepEqual(found(await search(tok.cat, { q: 'PIZZA order' })), []);
    assert.equal((await search(tok.cat, { q: 'PIZZA order', scope: 'group', groupId })).status, 404);
  });

  test('being removed from a server takes its messages out of your results', async () => {
    assert.ok(found(await search(tok.eve, { q: 'who wants' })).includes('who wants pizza'));
    assert.equal((await call('DELETE', `/servers/${serverId}/members/eve`, undefined, tok.ann)).status, 200);
    assert.deepEqual(found(await search(tok.eve, { q: 'who wants' })), []);
    assert.equal((await search(tok.eve, { q: 'who wants', scope: 'server', serverId })).status, 403);
  });

  test('bad input is a 400, and no token is a 401', async () => {
    const bad = [
      {}, { q: '' }, { q: 'a' }, { q: '   a   ' }, { q: 'x'.repeat(101) },
      { q: 'pizza', scope: 'everything' },
      { q: 'pizza', scope: 'channel' }, { q: 'pizza', scope: 'channel', serverId }, { q: 'pizza', scope: 'server' },
      { q: 'pizza', limit: '0' }, { q: 'pizza', limit: '-3' }, { q: 'pizza', limit: 'many' },
      { q: 'pizza', cursor: 'not-a-cursor' }, { q: 'pizza', cursor: '' },
      { q: 'pizza', cursor: Buffer.from('[1,2]').toString('base64url') },
      { q: 'pizza', cursor: Buffer.from('["a",0,1]').toString('base64url') },
      { q: 'pizza', cursor: Buffer.from('[1,7,1]').toString('base64url') },
    ];
    for (const params of bad) {
      const res = await search(tok.ann, params);
      assert.equal(res.status, 400, `${JSON.stringify(params)} -> ${res.status}`);
      assert.equal(res.data.results, undefined);
    }
    assert.equal((await call('GET', '/search?q=pizza&q=night', undefined, tok.ann)).status, 400);
    assert.equal((await search(tok.ann, { q: 'x'.repeat(100) })).status, 200);
    assert.equal((await search(tok.ann, { q: 'zz' })).status, 200);
    assert.equal((await search(undefined, { q: 'pizza' })).status, 401);
  });
});

// Its own server, so the counter starts at zero and the tests above are not competing for it.
describe('message search rate limit', () => {
  let server, call, token;
  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    token = await makeUser(call, 'searcher');
  });
  after(async () => { await server.stop(); });

  test('one client cannot hammer it', async () => {
    for (let i = 0; i < SEARCH_MAX_PER_MINUTE; i++) {
      const res = await call('GET', '/search?q=anything', undefined, token);
      if (res.status !== 200) assert.fail(`request ${i + 1} -> ${res.status}`);
    }
    const res = await call('GET', '/search?q=anything', undefined, token);
    assert.equal(res.status, 429);
    assert.ok(res.data.retryAfter > 0);
    // Requests that would have been refused anyway count too, so they are not a way around it.
    assert.equal((await call('GET', '/search?q=a', undefined, token)).status, 429);
  });

  // The count is per account. It used to be per address, and the address is read from a header the
  // caller writes, so a new X-Forwarded-For on every request meant never being limited at all.
  test('a different forwarded address is not a fresh allowance, and one account does not spend another\'s', async () => {
    const from = async (address, t) => (await fetch(`${server.base}/search?q=anything`, {
      headers: { Authorization: `Bearer ${t}`, 'X-Forwarded-For': address, 'CF-Connecting-IP': address },
    })).status;
    assert.equal(await from('198.51.100.7', token), 429);
    assert.equal(await from('198.51.100.8', token), 429);
    // Somebody else, from the very address that was just refused.
    const other = await makeUser(call, 'bystander');
    assert.equal(await from('198.51.100.7', other), 200);
    assert.equal((await call('GET', '/search?q=anything', undefined, other)).status, 200);
  });
});

// Channel search names every channel it may read in its WHERE clause. Written as one query that was
// an expression SQLite refuses once the caller is in about a thousand servers, and the refusal was
// an unhandled rejection: the process died, for everyone, at one request from one account.
describe('message search across a great many servers', () => {
  const SERVERS = 1100;
  let server, call, token;
  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    token = await makeUser(call, 'collector');
  });
  after(async () => { await server.stop(); });

  test('still answers, and still finds the newest matches wherever they are', async () => {
    const ids = [];
    for (let i = 0; i < SERVERS; i += 25) {
      const made = await Promise.all(Array.from({ length: Math.min(25, SERVERS - i) }, (_, j) => call('POST', '/servers', { name: `s${i + j}` }, token)));
      for (const res of made) { assert.equal(res.status, 200); ids.push(res.data.server.id); }
    }
    // One match in each of five servers spread across the whole list, so they land in different
    // queries, plus one in a server the caller is not in. Written straight to the table: a socket
    // round trip per message adds nothing here.
    const picked = [0, 250, 500, 800, SERVERS - 1].map((n) => ids[n]);
    const marks = picked.map(() => '?').join(', ');
    const channels = await dbAll(server.dataDir, `SELECT id, server_id FROM channels WHERE type = 'text' AND server_id IN (${marks})`, picked);
    assert.equal(channels.length, picked.length);
    const stranger = await makeUser(call, 'elsewhere');
    const theirs = (await call('POST', '/servers', { name: 'not yours' }, stranger)).data.server.id;
    channels.push((await dbAll(server.dataDir, "SELECT id, server_id FROM channels WHERE type = 'text' AND server_id = ?", [theirs]))[0]);
    for (const [n, ch] of channels.entries()) {
      await dbAll(server.dataDir, 'INSERT INTO messages (server_id, channel_id, author, text, ts) VALUES (?, ?, ?, ?, ?)',
        [ch.server_id, ch.id, 'collector', `needle ${n}`, 1000 + n]);
    }

    const all = await call('GET', '/search?q=needle', undefined, token);
    assert.equal(all.status, 200, JSON.stringify(all.data));
    assert.deepEqual(all.data.results.map((r) => r.message.text), ['needle 4', 'needle 3', 'needle 2', 'needle 1', 'needle 0']);
    assert.deepEqual(all.data.results.map((r) => r.serverId).sort(), [...picked].sort());
    assert.equal(all.data.hasMore, false);

    // Paged two at a time, the batches still add up to the same list.
    const seen = [];
    let cursor = null;
    do {
      const page = await call('GET', `/search?q=needle&limit=2${cursor ? `&cursor=${cursor}` : ''}`, undefined, token);
      assert.equal(page.status, 200);
      seen.push(...page.data.results.map((r) => r.message.text));
      cursor = page.data.nextCursor;
    } while (cursor);
    assert.deepEqual(seen, ['needle 4', 'needle 3', 'needle 2', 'needle 1', 'needle 0']);

    // And the server is still there.
    assert.equal((await call('GET', '/servers', undefined, token)).status, 200);
  });
});
