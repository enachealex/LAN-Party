/*
 * LAN Party app bridge SDK — served at /sdk/lanparty.js.
 *
 *   <script src="/sdk/lanparty.js"></script>
 *   const lp = await LANParty.connect();
 *
 * An uploaded app runs in a sandboxed frame with an opaque origin: it has no cookies, no session
 * and no access to the LAN Party API. This file is its only line to the app around it, and that
 * line carries four things: who is looking (public name and avatar), who else has joined, one
 * shared JSON object, and short-lived messages. See docs/APP-INTEGRATION.md.
 *
 * Plain ES2017 on purpose — it is loaded as-is by whatever HTML someone uploads, with no build step
 * on either side.
 */
(function (root) {
  'use strict';

  // Loaded twice (two <script> tags, a bundler copy next to the hosted one): keep the first, so
  // there is one connection and one set of listeners per page.
  if (root.LANParty && typeof root.LANParty.connect === 'function') return;

  var PROTOCOL = 1;
  // Mirrors the server's limits (server/services/activities.js). Checking here as well is what lets
  // setState() say "no" straight away instead of showing a change that the server then throws out.
  // burst / perSecond are the event rate (30 at once, 15 a second sustained). They are not enforced
  // in this file; they are here so an app can pace itself from LANParty.limits.
  var LIMITS = { sharedBytes: 64 * 1024, keys: 200, keyLength: 64, messageBytes: 8 * 1024, depth: 32, burst: 30, perSecond: 15 };
  var FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];
  var DEFAULT_TIMEOUT_MS = 1500;
  var HELLO_RETRY_MS = 250;
  // How long an unanswered change stays applied locally. The host acknowledges every change; this
  // only matters if that answer is lost, and then the change is dropped rather than kept forever.
  var PENDING_MS = 4000;
  var EVENTS = ['state', 'participants', 'message', 'closed'];

  function warn(text) {
    if (root.console && typeof root.console.warn === 'function') root.console.warn('[LANParty] ' + text);
  }
  function isPlainObject(v) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
    var proto = Object.getPrototypeOf(v);
    // A plain object from another realm (a frame, a test sandbox) has that realm's Object.prototype,
    // so compare by shape rather than identity: a prototype whose own prototype is null.
    return proto === null || Object.getPrototypeOf(proto) === null;
  }
  function jsonSafe(v, depth) {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return isFinite(v);
    if (typeof v !== 'object' || depth >= LIMITS.depth) return false;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) if (!jsonSafe(v[i], depth + 1)) return false;
      return true;
    }
    if (!isPlainObject(v)) return false;
    var keys = Object.keys(v);
    for (var k = 0; k < keys.length; k++) {
      if (FORBIDDEN_KEYS.indexOf(keys[k]) !== -1) return false;
      if (!jsonSafe(v[keys[k]], depth + 1)) return false;
    }
    return true;
  }
  function keyOk(k) {
    return typeof k === 'string' && k.length >= 1 && k.length <= LIMITS.keyLength && FORBIDDEN_KEYS.indexOf(k) === -1;
  }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  // Bytes once encoded as UTF-8, which is what the server counts.
  function utf8Length(text) {
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; } // surrogate pair
      else n += 3;
    }
    return n;
  }
  // Whatever arrives as "shared" becomes a plain object of our own. Keys are copied one by one
  // (never merged wholesale) so nothing the other side sent can end up on a prototype.
  function plainCopy(obj) {
    var out = {};
    if (!isPlainObject(obj) || !jsonSafe(obj, 0)) return out;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) if (keyOk(keys[i])) out[keys[i]] = clone(obj[keys[i]]);
    return out;
  }
  function applyOp(base, op) {
    var out = {};
    var keys;
    var i;
    if (op.kind === 'set') {
      keys = Object.keys(base);
      for (i = 0; i < keys.length; i++) out[keys[i]] = base[keys[i]];
    }
    keys = Object.keys(op.value);
    for (i = 0; i < keys.length; i++) {
      if (op.value[keys[i]] === null) delete out[keys[i]];
      else out[keys[i]] = clone(op.value[keys[i]]);
    }
    return out;
  }
  function person(p) {
    p = p && typeof p === 'object' ? p : {};
    var username = typeof p.username === 'string' ? p.username : '';
    return {
      username: username,
      displayName: typeof p.displayName === 'string' && p.displayName ? p.displayName : username,
      avatarUrl: typeof p.avatarUrl === 'string' ? p.avatarUrl : '',
    };
  }
  function people(list) {
    var out = [];
    if (Array.isArray(list)) for (var i = 0; i < list.length && out.length < 500; i++) out.push(person(list[i]));
    return out;
  }

  var session = null;

  function connect(options) {
    if (session) return session; // one connection per page; later calls get the same one

    var timeoutMs = options && typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    var host = root.parent;
    var framed = !!host && host !== root;

    var standalone = false;
    var closed = false;
    var me = person(null);
    var participants = [];
    var confirmed = {};   // the last state the host told us about
    var pending = [];     // our own changes the host has not answered yet, oldest first
    var view = {};        // confirmed with pending applied — what lp.state hands out copies of
    var rev = 0;
    var nextId = 1;
    var handlers = { state: [], participants: [], message: [], closed: [] };

    function rebuild() {
      var next = clone(confirmed);
      for (var i = 0; i < pending.length; i++) next = applyOp(next, pending[i]);
      var changed = JSON.stringify(next) !== JSON.stringify(view);
      view = next;
      return changed;
    }
    // Handlers and lp.state are given a copy of the state, never `view` itself. With the real object
    // in an app's hands, an in-place edit (lp.state.items.push(x)) would look as if it had worked:
    // under a host until the next update threw it away, and standalone for good, because there the
    // next setState builds on `view`. An app must behave the same in both, so neither gets the chance.
    function fireState(info) { fire('state', clone(view), info); }
    function fire(type, a, b) {
      var list = handlers[type].slice();
      for (var i = 0; i < list.length; i++) {
        // One handler throwing must not stop the others, or the bridge itself.
        try { list[i](a, b); } catch (err) {
          if (root.console && typeof root.console.error === 'function') root.console.error(err);
        }
      }
    }
    function post(message) {
      message.lanparty = PROTOCOL;
      // '*' because this frame cannot name its host's origin (and has no origin of its own to be
      // answered at). Nothing sent here is secret: it is this app's own state and messages.
      host.postMessage(message, '*');
    }
    function settle(id) {
      for (var i = 0; i < pending.length; i++) {
        if (pending[i].id === id) { clearTimeout(pending[i].timer); pending.splice(i, 1); return true; }
      }
      return false;
    }

    function change(kind, value) {
      if (closed) return false;
      if (!isPlainObject(value)) { warn(kind + ': expected a plain object'); return false; }
      var keys = Object.keys(value);
      for (var i = 0; i < keys.length; i++) {
        if (!keyOk(keys[i])) { warn(kind + ': key "' + keys[i] + '" is not allowed (1-' + LIMITS.keyLength + ' characters; not __proto__, constructor or prototype)'); return false; }
      }
      if (!jsonSafe(value, 0)) { warn(kind + ': values must be plain JSON (no functions, dates, NaN, or anything nested deeper than ' + LIMITS.depth + ')'); return false; }
      var op = { id: nextId++, kind: kind, value: clone(value), timer: null };
      var candidate = applyOp(view, op);
      if (Object.keys(candidate).length > LIMITS.keys) { warn(kind + ': shared state is limited to ' + LIMITS.keys + ' keys'); return false; }
      if (utf8Length(JSON.stringify(candidate)) > LIMITS.sharedBytes) { warn(kind + ': shared state is limited to ' + (LIMITS.sharedBytes / 1024) + ' KB'); return false; }

      if (standalone) {
        confirmed = candidate;
        rev += 1;
        rebuild();
        fireState({ rev: rev, by: me.username, local: true });
        return true;
      }
      // Optimistic: show it now, let the host confirm or refuse it.
      op.timer = setTimeout(function () {
        if (settle(op.id) && rebuild()) fireState({ rev: rev, by: null, local: false, rejected: true, reason: 'timeout' });
      }, PENDING_MS);
      pending.push(op);
      rebuild();
      var message = { type: kind, id: op.id };
      message[kind === 'set' ? 'patch' : 'shared'] = op.value;
      post(message);
      fireState({ rev: rev, by: me.username, local: true });
      return true;
    }

    var api = {
      setState: function (patch) { return change('set', patch); },
      replaceState: function (obj) { return change('replace', obj); },
      emit: function (data) {
        if (closed) return false;
        if (data === undefined || !jsonSafe(data, 0)) { warn('emit: data must be plain JSON'); return false; }
        if (utf8Length(JSON.stringify(data)) > LIMITS.messageBytes) { warn('emit: a message is limited to ' + (LIMITS.messageBytes / 1024) + ' KB'); return false; }
        if (!standalone) post({ type: 'emit', data: clone(data) }); // alone, there is nobody to tell
        return true;
      },
      on: function (type, handler) {
        if (EVENTS.indexOf(type) === -1) throw new TypeError('LANParty.on: unknown event "' + type + '"');
        if (typeof handler !== 'function') throw new TypeError('LANParty.on: handler must be a function');
        handlers[type].push(handler);
        return function unsubscribe() {
          var i = handlers[type].indexOf(handler);
          if (i !== -1) handlers[type].splice(i, 1);
        };
      },
    };
    Object.defineProperties(api, {
      standalone: { enumerable: true, get: function () { return standalone; } },
      closed: { enumerable: true, get: function () { return closed; } },
      me: { enumerable: true, get: function () { return person(me); } },
      participants: { enumerable: true, get: function () { return people(participants); } },
      // A fresh copy on every read: writing to it changes nothing for anyone, this page included.
      state: { enumerable: true, get: function () { return clone(view); } },
      rev: { enumerable: true, get: function () { return rev; } },
    });

    session = new Promise(function (resolve) {
      var resolved = false;
      var helloTimer = null;
      var giveUpTimer = null;

      function goStandalone() {
        if (resolved) return;
        resolved = true;
        standalone = true;
        clearInterval(helloTimer);
        clearTimeout(giveUpTimer);
        if (framed) root.removeEventListener('message', onMessage);
        // A stand-in identity, so an app opened straight from disk has a "me" to render.
        me = { username: 'you', displayName: 'You', avatarUrl: '' };
        participants = [me];
        resolve(api);
      }

      function onMessage(event) {
        // The one check that matters. Origins are useless here (ours is opaque, and the host's is
        // whatever LAN Party instance embedded us), but only the real parent window can BE the
        // parent window — so anything from another frame or a popup is dropped unread.
        if (!event || event.source !== host) return;
        var m = event.data;
        if (!m || typeof m !== 'object' || m.lanparty !== PROTOCOL || typeof m.type !== 'string') return;

        if (m.type === 'welcome') {
          me = person(m.me);
          participants = people(m.participants);
          confirmed = plainCopy(m.shared);
          rev = typeof m.rev === 'number' ? m.rev : 0;
          var changed = rebuild();
          if (!resolved) {
            resolved = true;
            clearInterval(helloTimer);
            clearTimeout(giveUpTimer);
            resolve(api);
          } else {
            // A second welcome (the host answered a repeated hello, or re-attached): treat it as a
            // refresh rather than ignoring fresher data.
            fire('participants', people(participants));
            if (changed) fireState({ rev: rev, by: null, local: false });
          }
          return;
        }
        if (!resolved || standalone) return; // nothing means anything before the welcome

        if (m.type === 'state') {
          confirmed = plainCopy(m.shared);
          if (typeof m.rev === 'number') rev = m.rev;
          rebuild();
          fireState({ rev: rev, by: typeof m.lastBy === 'string' ? m.lastBy : null, local: false });
        } else if (m.type === 'ack') {
          // The state that includes an accepted change arrives before its ack, so settling an
          // accepted change alters nothing. Settling a refused one takes it back out.
          if (settle(m.id) && rebuild()) {
            fireState({ rev: rev, by: null, local: false, rejected: m.ok !== true, reason: typeof m.reason === 'string' ? m.reason : null });
          }
        } else if (m.type === 'participants') {
          participants = people(m.participants);
          fire('participants', people(participants));
        } else if (m.type === 'message') {
          fire('message', { from: typeof m.from === 'string' ? m.from : '', data: m.data });
        } else if (m.type === 'closed') {
          if (closed) return;
          closed = true;
          for (var i = 0; i < pending.length; i++) clearTimeout(pending[i].timer);
          fire('closed', { reason: typeof m.reason === 'string' ? m.reason : '' });
        }
      }

      if (!framed) { goStandalone(); return; }
      root.addEventListener('message', onMessage);
      var hello = function () { post({ type: 'hello', sdk: PROTOCOL }); };
      hello();
      // Repeated because the host may attach its listener a moment after this frame starts running;
      // a hello posted into that gap would otherwise be lost and the app would wrongly go standalone.
      helloTimer = setInterval(hello, HELLO_RETRY_MS);
      giveUpTimer = setTimeout(goStandalone, timeoutMs);
    });
    return session;
  }

  root.LANParty = { connect: connect, protocol: PROTOCOL, limits: LIMITS };
})(typeof window !== 'undefined' ? window : this);
