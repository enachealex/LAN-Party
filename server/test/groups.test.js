// Group chats used to exist only in the creator's browser tab: nobody else saw them and they vanished
// on reload. These pin down the server side: who can make and join one, that messages reach every
// member live, per-member unread counts, edits/deletes/reactions, and leaving/removal/ownership.
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
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`timed out waiting for "${event}"`));
    }, timeoutMs);
    socket.on(event, onEvent);
  });
}

// Resolves true if the event does NOT arrive within the window.
const never = (socket, event, match = () => true, ms = 600) => once(socket, event, match, ms).then(() => false, () => true);

const connect = async (base, token) => {
  const socket = io(base, { transports: ['websocket'], forceNew: true, auth: { token } });
  await once(socket, 'connect');
  return socket;
};

async function befriend(call, fromToken, toToken, toUsername) {
  const req = await call('POST', '/friends/request', { username: toUsername }, fromToken);
  assert.equal(req.status, 200, `friend request should succeed: ${JSON.stringify(req.data)}`);
  const incoming = await call('GET', '/friends/requests/incoming', undefined, toToken);
  const res = await call('POST', `/friends/requests/${incoming.data.requests[0].id}/accept`, undefined, toToken);
  assert.equal(res.status, 200);
}

describe('group chats', () => {
  let server, call;
  const tok = {};
  const sock = {};

  before(async () => {
    server = await startServer();
    call = apiFor(server.base);
    for (const name of ['gina', 'hank', 'ivy', 'jo', 'kim']) tok[name] = await makeUser(call, name);
    // gina is friends with hank, ivy and jo. kim is a stranger to everyone.
    await befriend(call, tok.gina, tok.hank, 'hank');
    await befriend(call, tok.gina, tok.ivy, 'ivy');
    await befriend(call, tok.gina, tok.jo, 'jo');
    for (const name of ['gina', 'hank', 'ivy', 'jo', 'kim']) sock[name] = await connect(server.base, tok[name]);
  });
  after(async () => {
    for (const s of Object.values(sock)) s.close();
    await server?.stop();
  });

  const create = (token, members, name = '') => call('POST', '/groups', { name, members }, token);
  const list = async (token) => (await call('GET', '/groups', undefined, token)).data.groups;

  test('needs at least two other people, and only people you could DM', async () => {
    assert.equal((await create(tok.gina, ['hank'])).status, 400, 'one other person is a DM, not a group');
    assert.equal((await create(tok.gina, ['hank', 'kim'])).status, 403, 'kim is a stranger to gina');
    assert.equal((await create(tok.gina, ['hank', 'nobody-here'])).status, 404);
    assert.equal((await list(tok.gina)).length, 0, 'a refused create leaves nothing behind');
  });

  test('creating one shows it to every member, live and on reload', async () => {
    const seenByHank = once(sock.hank, 'group:updated');
    const res = await create(tok.gina, ['hank', 'ivy'], '  Friday   raid  ');
    assert.equal(res.status, 200);
    const { group } = res.data;
    assert.match(group.id, /^grp-[0-9a-f]{16}$/);
    assert.equal(group.name, 'Friday raid', 'whitespace is tidied');
    assert.equal(group.ownerUsername, 'gina');
    assert.deepEqual(group.members.map((m) => m.name), ['gina', 'hank', 'ivy']);
    assert.equal((await seenByHank).group.id, group.id);
    for (const name of ['gina', 'hank', 'ivy']) assert.deepEqual((await list(tok[name])).map((g) => g.id), [group.id], name);
    assert.equal((await list(tok.jo)).length, 0, 'jo was not added');
  });

  test('messages reach every member live, count as unread for the others, and clear on read', async () => {
    const [group] = await list(tok.gina);
    const toHank = once(sock.hank, 'group:message', (p) => p.groupId === group.id);
    const toIvy = once(sock.ivy, 'group:message', (p) => p.groupId === group.id);
    const toGina = once(sock.gina, 'group:message', (p) => p.groupId === group.id); // the sender's other windows
    const res = await call('POST', `/groups/${group.id}/messages`, { text: 'who is bringing snacks' }, tok.gina);
    assert.equal(res.status, 200);
    for (const p of [await toHank, await toIvy, await toGina]) {
      assert.equal(p.message.text, 'who is bringing snacks');
      assert.equal(p.message.author, 'gina');
      assert.equal(p.message.id, res.data.message.id);
    }
    assert.equal(await never(sock.jo, 'group:message'), true, 'a non-member hears nothing');

    const unread = async (name) => (await list(tok[name])).find((g) => g.id === group.id).unreadCount;
    assert.equal(await unread('gina'), 0, 'your own message is not unread');
    assert.equal(await unread('hank'), 1);
    assert.equal((await list(tok.hank))[0].lastMessage.text, 'who is bringing snacks');

    const readElsewhere = once(sock.hank, 'group:read', (p) => p.groupId === group.id);
    const history = await call('GET', `/groups/${group.id}/messages?markRead=1`, undefined, tok.hank);
    assert.deepEqual(history.data.messages.map((m) => m.text), ['who is bringing snacks']);
    await readElsewhere;
    assert.equal(await unread('hank'), 0);
    assert.equal(await unread('ivy'), 1, 'reading is per person');
  });

  test('non-members get a 404 for everything, so ids cannot be probed', async () => {
    const [group] = await list(tok.gina);
    assert.equal((await call('GET', `/groups/${group.id}/messages`, undefined, tok.jo)).status, 404);
    assert.equal((await call('POST', `/groups/${group.id}/messages`, { text: 'hi' }, tok.jo)).status, 404);
    assert.equal((await call('PATCH', `/groups/${group.id}`, { name: 'mine now' }, tok.jo)).status, 404);
    assert.equal((await call('POST', `/groups/${group.id}/members`, { usernames: ['jo'] }, tok.jo)).status, 404);
    assert.equal((await call('GET', '/groups/grp-0000000000000000/messages', undefined, tok.gina)).status, 404);
  });

  test('only the sender can edit or delete, and every member sees it', async () => {
    const [group] = await list(tok.gina);
    const sent = (await call('POST', `/groups/${group.id}/messages`, { text: 'typo hree' }, tok.hank)).data.message;
    assert.equal((await call('PATCH', `/groups/${group.id}/messages/${sent.id}`, { text: 'nope' }, tok.gina)).status, 403);

    const edited = once(sock.ivy, 'group:message-edited', (p) => p.id === sent.id);
    assert.equal((await call('PATCH', `/groups/${group.id}/messages/${sent.id}`, { text: 'typo here' }, tok.hank)).status, 200);
    const p = await edited;
    assert.equal(p.groupId, group.id);
    assert.equal(p.text, 'typo here');
    const after = (await call('GET', `/groups/${group.id}/messages`, undefined, tok.ivy)).data.messages.find((m) => m.id === sent.id);
    assert.equal(after.text, 'typo here');
    assert.equal(after.edited, true);

    assert.equal((await call('DELETE', `/groups/${group.id}/messages/${sent.id}`, undefined, tok.ivy)).status, 403);
    const deleted = once(sock.gina, 'group:message-deleted', (d) => d.id === sent.id);
    assert.equal((await call('DELETE', `/groups/${group.id}/messages/${sent.id}`, undefined, tok.hank)).status, 200);
    await deleted;
    const texts = (await call('GET', `/groups/${group.id}/messages`, undefined, tok.gina)).data.messages.map((m) => m.text);
    assert.equal(texts.includes('typo here'), false);
  });

  test('reactions reach every member; a non-member cannot react', async () => {
    const [group] = await list(tok.gina);
    const msg = (await call('POST', `/groups/${group.id}/messages`, { text: 'react to me' }, tok.gina)).data.message;
    const reacted = once(sock.hank, 'reaction:updated', (p) => p.scope === 'group' && p.messageId === msg.id);
    sock.ivy.emit('reaction:toggle', { scope: 'group', messageId: msg.id, emoji: '🔥' });
    const p = await reacted;
    assert.equal(p.groupId, group.id);
    assert.deepEqual(p.reactions, { '🔥': ['ivy'] });

    sock.kim.emit('reaction:toggle', { scope: 'group', messageId: msg.id, emoji: '💀' });
    assert.equal(await never(sock.gina, 'reaction:updated', (u) => u.messageId === msg.id), true);
    const stored = (await call('GET', `/groups/${group.id}/messages`, undefined, tok.gina)).data.messages.find((m) => m.id === msg.id);
    assert.deepEqual(Object.keys(stored.reactions), ['🔥'], 'the stranger’s reaction was not saved');
  });

  test('any member can rename and add people they know; adding a stranger is refused', async () => {
    const [group] = await list(tok.gina);
    const renamed = once(sock.ivy, 'group:updated', (p) => p.group.name === 'Snack council');
    assert.equal((await call('PATCH', `/groups/${group.id}`, { name: 'Snack council' }, tok.hank)).status, 200);
    await renamed;

    assert.equal((await call('POST', `/groups/${group.id}/members`, { usernames: ['kim'] }, tok.gina)).status, 403);
    // hank is not friends with jo, so hank can't add jo — but gina can.
    assert.equal((await call('POST', `/groups/${group.id}/members`, { usernames: ['jo'] }, tok.hank)).status, 403);
    const joinedJo = once(sock.jo, 'group:updated', (p) => p.group.id === group.id);
    const added = await call('POST', `/groups/${group.id}/members`, { usernames: ['jo'] }, tok.gina);
    assert.equal(added.status, 200);
    await joinedJo;
    assert.deepEqual(added.data.group.members.map((m) => m.name), ['gina', 'hank', 'ivy', 'jo']);
    const joGroup = (await list(tok.jo)).find((g) => g.id === group.id);
    assert.equal(joGroup.unreadCount, 0, 'a new member sees the history but it is not all unread');
    assert.ok((await call('GET', `/groups/${group.id}/messages`, undefined, tok.jo)).data.messages.length > 0);
  });

  test('only the owner removes others; leaving hands ownership on; the last one out deletes it', async () => {
    const [group] = await list(tok.gina);
    assert.equal((await call('DELETE', `/groups/${group.id}/members/ivy`, undefined, tok.hank)).status, 403);

    const ivyRemoved = once(sock.ivy, 'group:removed', (p) => p.groupId === group.id);
    assert.equal((await call('DELETE', `/groups/${group.id}/members/ivy`, undefined, tok.gina)).status, 200);
    await ivyRemoved;
    assert.equal((await list(tok.ivy)).length, 0);
    assert.equal((await call('GET', `/groups/${group.id}/messages`, undefined, tok.ivy)).status, 404, 'removed means no more history');

    // The owner leaves: hank joined next, so hank owns it now.
    const hankUpdated = once(sock.hank, 'group:updated', (p) => p.group.id === group.id && p.group.ownerUsername === 'hank');
    assert.equal((await call('DELETE', `/groups/${group.id}/members/gina`, undefined, tok.gina)).status, 200);
    await hankUpdated;
    assert.equal((await list(tok.gina)).length, 0);

    assert.equal((await call('DELETE', `/groups/${group.id}/members/hank`, undefined, tok.hank)).status, 200);
    assert.equal((await call('DELETE', `/groups/${group.id}/members/jo`, undefined, tok.jo)).status, 200);
    for (const name of ['gina', 'hank', 'ivy', 'jo']) assert.equal((await list(tok[name])).length, 0, name);
    const left = await dbAll(server.dataDir, 'SELECT (SELECT COUNT(*) FROM group_chats) AS chats, (SELECT COUNT(*) FROM group_messages) AS msgs');
    assert.deepEqual(left[0], { chats: 0, msgs: 0 }, 'an empty group and its history are deleted');
  });
});
