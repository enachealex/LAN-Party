// In-call activities: watch party, whiteboard, poll, tic-tac-toe, Sketch & Guess and the shared
// music queue. Reducer-style — applyActivityEvent takes the current state plus an event and
// returns the next state, which keeps the socket layer a thin transport.
//
// A factory because the sketch/music rules need to know who is in the room (io) and which display
// name a socket belongs to (clients).

/** @param {{ io: any, clients: Record<string, any> }} deps */
function createActivities({ io, clients }) {
  const ACTIVITY_TYPES = ['watch', 'whiteboard', 'poll', 'ttt', 'sketch', 'music'];
  const SKETCH_WORDS = ['pizza', 'dragon', 'controller', 'headset', 'wizard', 'castle', 'laptop', 'zombie', 'racecar', 'treasure', 'ninja', 'robot', 'campfire', 'spaceship', 'sword', 'shield', 'potion', 'dungeon', 'goblin', 'keyboard', 'trophy', 'boss fight', 'power up', 'game over', 'rage quit', 'speedrun', 'loot box', 'health bar', 'respawn', 'lan party', 'energy drink', 'mechanical keyboard', 'graphics card', 'blue screen', 'lag spike', 'victory royale', 'minecart', 'creeper', 'portal', 'joystick', 'arcade', 'pixel', 'avatar', 'guild', 'quest', 'checkpoint', 'combo', 'headshot', 'stealth', 'sniper', 'race track', 'finish line', 'monster truck', 'alien', 'meteor', 'volcano', 'pirate ship', 'skeleton', 'campaign', 'final boss'];
  function activityInit(type) {
    if (type === 'watch') return { videoId: null, playing: false, time: 0, ts: Date.now() };
    if (type === 'whiteboard') return { strokes: [] };
    if (type === 'poll') return { question: '', options: [], closed: false };
    if (type === 'ttt') return { board: Array(9).fill(''), turn: 'X', players: {}, winner: null, scores: {}, draws: 0, round: 1 };
    if (type === 'sketch') return { phase: 'lobby', players: [], turnIdx: 0, totalTurns: 0, word: null, wordMask: '', strokes: [], guesses: [], solvedBy: [], lastResult: null };
    // music: shared queue + synced playback (pos anchored to server time ts, like 'watch').
    // dj: null = everyone controls; a claimed DJ is the only one who can drive playback.
    if (type === 'music') return { queue: [], index: -1, playing: false, pos: 0, ts: Date.now(), history: [], dj: null };
    return {};
  }

  // --- Sketch & Guess helpers ---
  const sketchNorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  function sketchDrawer(s) { return s.players.length ? s.players[s.turnIdx % s.players.length].name : null; }
  function sketchNewTurn(s) {
    if (s.turnIdx >= s.totalTurns) { s.phase = 'end'; s.word = null; s.wordMask = ''; return; }
    s.word = SKETCH_WORDS[Math.floor(Math.random() * SKETCH_WORDS.length)];
    s.wordMask = s.word.replace(/[a-z0-9]/gi, '_');
    s.strokes = [];
    s.guesses = [];
    s.solvedBy = [];
  }
  function sketchAdvance(s, resultMsg) {
    s.lastResult = resultMsg;
    s.turnIdx += 1;
    sketchNewTurn(s);
  }
  function tttWinner(b) {
    const L = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (const [a, c, d] of L) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
    return b.every((x) => x) ? 'draw' : null;
  }
  // Music track validation + sanitization, shared by the activity reducer and the playlist API.
  // Only YouTube video ids and Spotify track URIs are accepted; text fields are length-capped.
  const musicTrackValid = (t) => t && typeof t.id === 'string' &&
    (/^[a-zA-Z0-9_-]{6,20}$/.test(t.id) || /^spotify:track:[a-zA-Z0-9]{22}$/.test(t.id));
  const musicTrackClean = (t) => ({
    id: t.id,
    service: t.id.startsWith('spotify:') ? 'spotify' : 'youtube',
    title: String(t.title || '').slice(0, 120),
    artist: String(t.artist || '').slice(0, 80),
    thumbnail: String(t.thumbnail || '').slice(0, 300),
    durationMs: Number.isFinite(Number(t.durationMs)) ? Number(t.durationMs) : undefined,
  });
  function applyActivityEvent(act, ev, user, ctx) {
    const s = act.state;
    if (act.type === 'watch') {
      if (ev.kind === 'load' && typeof ev.videoId === 'string') { s.videoId = ev.videoId.slice(0, 20); s.playing = true; s.time = 0; s.ts = Date.now(); }
      else if (ev.kind === 'play') { s.playing = true; s.time = Number(ev.time) || 0; s.ts = Date.now(); }
      else if (ev.kind === 'pause') { s.playing = false; s.time = Number(ev.time) || 0; s.ts = Date.now(); }
      else if (ev.kind === 'seek') { s.time = Number(ev.time) || 0; s.ts = Date.now(); }
    } else if (act.type === 'whiteboard') {
      if (ev.kind === 'stroke' && ev.seg && typeof ev.seg === 'object') { s.strokes.push(ev.seg); if (s.strokes.length > 20000) s.strokes.splice(0, s.strokes.length - 20000); }
      else if (ev.kind === 'clear') s.strokes = [];
    } else if (act.type === 'poll') {
      if (ev.kind === 'create') { s.question = String(ev.question || '').slice(0, 140); s.options = (Array.isArray(ev.options) ? ev.options : []).slice(0, 6).map((t) => ({ text: String(t).slice(0, 60), votes: [] })); s.closed = false; }
      else if (ev.kind === 'vote' && !s.closed && s.options[ev.index]) { s.options.forEach((o) => { o.votes = o.votes.filter((u) => u !== user); }); s.options[ev.index].votes.push(user); }
      else if (ev.kind === 'close') s.closed = true;
    } else if (act.type === 'ttt') {
      if (ev.kind === 'join') { if (!s.players.X) s.players.X = user; else if (!s.players.O && s.players.X !== user) s.players.O = user; }
      else if (ev.kind === 'move' && s.winner == null) {
        const mark = s.players.X === user ? 'X' : (s.players.O === user ? 'O' : null);
        if (mark && mark === s.turn && ev.i >= 0 && ev.i < 9 && !s.board[ev.i]) {
          s.board[ev.i] = mark; s.turn = mark === 'X' ? 'O' : 'X'; s.winner = tttWinner(s.board);
          // Round just ended — put it on the scoreboard (moves are rejected once winner is set,
          // so this runs exactly once per round).
          if (s.winner === 'X' || s.winner === 'O') { const name = s.players[s.winner]; if (name) s.scores[name] = (s.scores[name] || 0) + 1; }
          else if (s.winner === 'draw') s.draws = (s.draws || 0) + 1;
        }
      } else if (ev.kind === 'reset') { s.board = Array(9).fill(''); s.turn = 'X'; s.winner = null; s.round = (s.round || 1) + 1; }
    } else if (act.type === 'sketch') {
      const drawer = sketchDrawer(s);
      if (ev.kind === 'join' && s.phase === 'lobby' && s.players.length < 8 && !s.players.some((p) => p.name === user)) {
        s.players.push({ name: user, score: 0 });
      } else if (ev.kind === 'start' && s.phase === 'lobby' && s.players.length >= 2) {
        s.phase = 'play';
        s.turnIdx = 0;
        s.totalTurns = s.players.length * 2; // everyone draws twice
        s.lastResult = null;
        sketchNewTurn(s);
      } else if (ev.kind === 'stroke' && s.phase === 'play' && user === drawer && ev.seg && typeof ev.seg === 'object') {
        s.strokes.push(ev.seg);
        if (s.strokes.length > 20000) s.strokes.splice(0, s.strokes.length - 20000);
      } else if (ev.kind === 'clear' && s.phase === 'play' && user === drawer) {
        s.strokes = [];
      } else if (ev.kind === 'guess' && s.phase === 'play' && user !== drawer && !s.solvedBy.includes(user)) {
        const text = String(ev.text || '').slice(0, 60).trim();
        if (!text) return;
        if (sketchNorm(text) === sketchNorm(s.word)) {
          s.solvedBy.push(user);
          const guesser = s.players.find((p) => p.name === user);
          const dp = s.players.find((p) => p.name === drawer);
          if (guesser) guesser.score += 100;
          if (dp) dp.score += 25;
          s.guesses.push({ by: user, text: null, correct: true }); // never leak the word
          const nonDrawers = s.players.filter((p) => p.name !== drawer).map((p) => p.name);
          if (nonDrawers.every((n) => s.solvedBy.includes(n))) {
            sketchAdvance(s, `Everyone guessed it! The word was "${s.word}".`);
          }
        } else {
          s.guesses.push({ by: user, text, correct: false });
          if (s.guesses.length > 200) s.guesses.splice(0, s.guesses.length - 200);
        }
      } else if (ev.kind === 'skip' && s.phase === 'play' && user === drawer) {
        sketchAdvance(s, `${drawer} skipped — the word was "${s.word}".`);
      } else if (ev.kind === 'reset' && s.phase === 'end') {
        s.players.forEach((p) => { p.score = 0 });
        s.phase = 'lobby';
        s.turnIdx = 0;
        s.word = null; s.wordMask = ''; s.strokes = []; s.guesses = []; s.solvedBy = []; s.lastResult = null;
      }
    } else if (act.type === 'music') {
      const now = Date.now();
      const validTrack = musicTrackValid;
      const cleanTrack = (t) => ({ ...musicTrackClean(t), addedBy: user });
      // With a DJ on deck, only they drive playback — including 'next' (auto-advance), so a
      // non-DJ can't force-skip by emitting it. The DJ's own client still fires next on track end.
      // Adding song requests stays open to everyone.
      const DJ_ONLY = ['play', 'pause', 'seek', 'skip', 'jump', 'remove', 'clear', 'shuffle', 'playNow', 'loadList', 'next'];
      if (s.dj && user !== s.dj && DJ_ONLY.includes(ev.kind)) return;
      if (ev.kind === 'djClaim') {
        // Free seat, or the current DJ left the voice room — take over.
        const room = ctx && ctx.room;
        const djStillHere = s.dj && room && [...(io.sockets.adapter.rooms.get(room) || [])].some((id) => clients[id]?.name === s.dj);
        if (!s.dj || !djStillHere) s.dj = user;
        return;
      }
      if (ev.kind === 'djRelease') { if (s.dj === user) s.dj = null; return; }
      const pushHistory = (t) => { if (!t) return; s.history.unshift({ id: t.id, title: t.title, artist: t.artist, thumbnail: t.thumbnail, playedAt: now }); if (s.history.length > 100) s.history.length = 100; };
      const startAt = (i) => {
        if (i >= 0 && i < s.queue.length) { s.index = i; s.pos = 0; s.ts = now; s.playing = true; }
        else { s.index = -1; s.pos = 0; s.ts = now; s.playing = false; }
      };
      if (ev.kind === 'add' && validTrack(ev.track) && s.queue.length < 200) {
        s.queue.push(cleanTrack(ev.track));
        if (s.index === -1) startAt(s.queue.length - 1); // nothing playing → start what was just added
      } else if (ev.kind === 'loadList' && Array.isArray(ev.tracks)) {
        const before = s.queue.length;
        for (const t of ev.tracks.slice(0, 200)) {
          if (s.queue.length >= 200) break;
          if (validTrack(t)) s.queue.push(cleanTrack(t));
        }
        if (s.index === -1 && s.queue.length > before) startAt(before); // idle → start the loaded list
      } else if (ev.kind === 'playNow' && validTrack(ev.track)) {
        pushHistory(s.queue[s.index]);
        s.queue.splice(s.index + 1, 0, cleanTrack(ev.track));
        startAt(s.index + 1);
      } else if (ev.kind === 'jump' && Number.isInteger(ev.i) && ev.i >= 0 && ev.i < s.queue.length) {
        pushHistory(s.queue[s.index]);
        startAt(ev.i);
      } else if (ev.kind === 'remove' && Number.isInteger(ev.i) && ev.i >= 0 && ev.i < s.queue.length) {
        const removingCurrent = ev.i === s.index;
        s.queue.splice(ev.i, 1);
        if (ev.i < s.index) s.index -= 1;
        else if (removingCurrent) startAt(s.index < s.queue.length ? s.index : -1);
      } else if (ev.kind === 'clear') {
        // Clear upcoming + played; keep only what's on right now.
        const current = s.queue[s.index];
        s.queue = current ? [current] : [];
        s.index = current ? 0 : -1;
        if (!current) { s.playing = false; s.pos = 0; s.ts = now; }
      } else if (ev.kind === 'shuffle' && s.queue.length > s.index + 2) {
        // Shuffle only the not-yet-played tail so history/current stay put.
        const tail = s.queue.splice(s.index + 1);
        for (let i = tail.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [tail[i], tail[j]] = [tail[j], tail[i]]; }
        s.queue.push(...tail);
      } else if (ev.kind === 'skip' || ev.kind === 'next') {
        // 'next' comes from every client's audio 'ended' event — the fromId guard makes sure
        // only the first one advances the queue (the rest see a changed track and no-op).
        if (ev.kind === 'next' && (!s.queue[s.index] || s.queue[s.index].id !== ev.fromId)) return;
        pushHistory(s.queue[s.index]);
        startAt(s.index + 1 < s.queue.length ? s.index + 1 : -1);
      } else if (ev.kind === 'play') {
        if (s.index !== -1) { s.playing = true; s.pos = Number(ev.pos) || 0; s.ts = now; }
      } else if (ev.kind === 'pause') {
        s.playing = false; s.pos = Number(ev.pos) || 0; s.ts = now;
      } else if (ev.kind === 'seek') {
        s.pos = Math.max(0, Number(ev.pos) || 0); s.ts = now;
      }
      warmMusicQueue(s.queue, s.index); // pre-resolve upcoming audio so skips start instantly
    }
  }

  // What a given socket is allowed to see of an activity: in Sketch & Guess the secret word only
  // goes to the current drawer — everyone else gets a redacted copy (mask only).
  function activityViewFor(act, socketId) {
    if (!act || act.type !== 'sketch') return act;
    const s = act.state;
    if (s.phase !== 'play' || !s.word) return act;
    if (clients[socketId]?.name === sketchDrawer(s)) return act;
    return { ...act, state: { ...s, word: null } };
  }
  function broadcastActivity(room, act) {
    if (!act) { io.to(room).emit('activity:update', null); return; }
    const ids = io.sockets.adapter.rooms.get(room) || new Set();
    for (const id of ids) io.to(id).emit('activity:update', activityViewFor(act, id));
  }

  // Only these are used outside this module; the sketch/ttt helpers stay private.
  return { ACTIVITY_TYPES, activityInit, applyActivityEvent, activityViewFor, broadcastActivity };
}

module.exports = { createActivities };
