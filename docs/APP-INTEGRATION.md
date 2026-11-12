# Building apps for LAN Party

An **app** is a small web page somebody uploads to the App Directory: a single `.html` file, or a
`.zip` with an `index.html` and its assets. LAN Party hosts it and runs it in a sandbox.

Any uploaded app can be started as a **Thing To Do** in a voice channel, where everyone who joins
it shares one piece of state. To take part in that, the app loads a small script — the **bridge
SDK** — which tells it who is looking, who else has joined, and gives it a shared object and a way
to send short messages. Nothing has to be changed on the server to add an app.

- [Upload an app](#upload-an-app)
- [A complete example](#a-complete-example)
- [The SDK](#the-sdk)
- [Limits](#limits)
- [What an app can and cannot see](#what-an-app-can-and-cannot-see)
- [Developing without a room](#developing-without-a-room)
- [Patterns that work](#patterns-that-work)
- [Not yet](#not-yet)

A full, usable sample lives in [`examples/apps/buzzer/index.html`](../examples/apps/buzzer/index.html):
a game-night buzzer with a scoreboard.

## Upload an app

1. Open the **App Directory** and choose **Upload App → Upload a mini-app**.
2. Give it a name, a description and (optionally) an icon.
3. Pick a `.html` file, or a `.zip` that contains `index.html`. If there is none at the top level
   of the zip (you zipped a folder, say), the `index.html` nearest the top is used and **its folder
   becomes the app**: files outside that folder are not kept, so keep everything the app needs
   beside or below its `index.html`. Uploads are limited to 15 MB; a zip may hold up to 300 files
   and 60 MB unpacked.
4. Publish. The app appears in the directory for everyone, and under **Community apps** in the
   **Things To Do** menu of every voice channel.

There are two ways to run it:

- **In a voice channel.** Someone picks it from Things To Do. Everyone in the channel sees a card
  with the app's name, who started it, who uploaded it and who is in, and a **Join** button. The app
  only loads for the people who press Join (the person who started it is in from the start).
  **Leave** closes it for you; **End** closes it for everyone. Looking at another channel while
  still in the call also closes it for you — the app only runs while its panel is on screen — and
  you get the card again when you come back.
- **On your own.** *Open* in the App Directory runs the same app by itself. The SDK still works —
  you are the only participant and the state is yours alone, kept until you close the viewer.

You can remove an app you uploaded from the directory. If it is running somewhere at that moment,
it ends there.

## A complete example

A shared counter. Save it as `index.html` and upload it.

```html
<!doctype html>
<meta charset="utf-8">
<title>Counter</title>
<body style="background:#0d141d;color:#e8eef5;font:16px system-ui;text-align:center;padding:40px">
  <p id="who"></p>
  <button id="add" style="font-size:32px;padding:16px 32px">0</button>
  <p id="last"></p>

  <script src="/sdk/lanparty.js"></script>
  <script>
    LANParty.connect().then(function (lp) {
      var add = document.getElementById('add');

      function render() {
        add.textContent = lp.state.count || 0;
        document.getElementById('who').textContent =
          'You are ' + lp.me.displayName + '. Here: ' +
          lp.participants.map(function (p) { return p.displayName; }).join(', ');
      }

      add.onclick = function () {
        lp.setState({ count: (lp.state.count || 0) + 1 });   // everyone sees it
        lp.emit({ type: 'clicked' });                        // a one-off message to the others
      };

      lp.on('state', render);
      lp.on('participants', render);
      lp.on('message', function (m) {
        document.getElementById('last').textContent = m.from + ' clicked';
      });
      render();
    });
  </script>
</body>
```

Use `textContent`, as above, for anything that came from other people (names, state, messages).
The sandbox protects LAN Party from your app; it does not protect your app's players from each
other if you build HTML out of what they send.

## The SDK

```html
<script src="/sdk/lanparty.js"></script>
```

A plain script, no build step, served by every LAN Party server at that path. It defines one
global, `LANParty`.

### `LANParty.connect(options?)` → `Promise<lp>`

Resolves once LAN Party has answered. It never rejects: if nothing answers (see
[Developing without a room](#developing-without-a-room)) you get a working `lp` in standalone mode.
Calling it again returns the same connection.

| Option | Default | |
| --- | --- | --- |
| `timeoutMs` | `1500` | How long to wait for LAN Party before going standalone. |

### `lp`

| | |
| --- | --- |
| `lp.me` | `{ username, displayName, avatarUrl }` — the person looking at this copy of the app. `avatarUrl` may be `''`. |
| `lp.participants` | The people who have **joined the app**, each `{ username, displayName, avatarUrl }`. Kept up to date. Someone who is in the voice channel but has not pressed Join is not listed. |
| `lp.state` | The shared object — a fresh copy each time you read it, so read it once into a variable if you need it several times. Writing to the copy changes nothing, for you or anyone else: change the state with `setState` / `replaceState`. |
| `lp.setState(patch)` | Shallow merge: each key in `patch` replaces that key in the state; a value of `null` deletes the key. Returns `false` (and warns in the console) if the change was refused on the spot. |
| `lp.replaceState(obj)` | Replace the whole object. |
| `lp.emit(data)` | Send a one-off message to the other participants. Not stored; whoever joins later never sees it. You do not receive your own. |
| `lp.on(type, handler)` | Listen. Returns a function that removes the listener. |
| `lp.standalone` | `true` when there is no LAN Party around the app. |
| `lp.closed` | `true` once the session is over. `setState` and `emit` then return `false`. |
| `lp.rev` | A number that goes up by one with every accepted change. |
| `LANParty.limits` | The numbers from [Limits](#limits), as `{ sharedBytes: 65536, keys: 200, keyLength: 64, messageBytes: 8192, depth: 32, burst: 30, perSecond: 15 }`. The room-wide byte budget is not in it. |

`username` is the stable one — use it for keys and comparisons. `displayName` is for showing.

### Events

| `lp.on(...)` | Handler receives | When |
| --- | --- | --- |
| `'state'` | `(state, info)` | The shared object changed. `state` is a copy, like `lp.state`. `info.by` is the username whose change it was, `info.rev` the new revision. `info.local` is `true` for your own change being shown before the server has confirmed it. `info.rejected` is `true` if a change of yours was refused and has just been undone (`info.reason` says why). |
| `'participants'` | `(list)` | Someone joined or left the app. |
| `'message'` | `({ from, data })` | Another participant called `emit`. `from` is their username, set by the server. |
| `'closed'` | `({ reason })` | The app is being closed for you. Do not rely on it for saving anything: the page is usually removed in the same instant. |

### How changes travel

`setState` shows your change in `lp.state` straight away, then sends it. The server applies changes
in the order they arrive, gives each a revision, and sends the result to everyone who has joined —
one `'state'` event per change, in that order, the same for everybody. If the server refuses yours
(too big, too fast), it is undone locally and you get a `'state'` event with `info.rejected`.

An event whose `info.by` is you confirms your **oldest** change that was still waiting, not
necessarily your latest: make two changes quickly and you get two such events, one for each, in
the order you made them.

Values must be plain JSON: strings, finite numbers, booleans, `null`, arrays and plain objects.

## Limits

Enforced by the server. A change that breaks one is refused whole — the state is left as it was.

| | |
| --- | --- |
| Shared state | 64 KB as JSON, at most 200 top-level keys |
| Key names | 1 to 64 characters; never `__proto__`, `constructor` or `prototype` (at any depth) |
| Nesting | 32 levels |
| One `emit` message | 8 KB as JSON |
| Rate | About 15 changes or messages per second per person, with bursts of up to 30. Anything over that is dropped, not queued. |
| State traffic | Every accepted change sends the whole shared object to everyone who joined, and the room as a whole may send out 256 KB of state per second (512 KB in a burst), counted as the object's size after each change. A change over that budget is refused (`info.reason` is `'rate-limited'`). |

So: do not write to the state on every mouse move. Send what changed when something happens, and
throttle anything continuous (a cursor, a drawing) to ten or so updates a second.

The last row is why a big state has to be a slow one. A few kilobytes can change as often as the
rate allows; a state near the 64 KB limit can change about four times a second **for the whole
room**, not per person. Anything that changes often belongs in a small state or in `emit`.

The state lasts as long as the activity does. When it is ended, or the voice channel empties, it is
gone. There is no storage that outlives a session.

## What an app can and cannot see

Apps are uploaded by members, so LAN Party treats every one as untrusted code.

**An app can see**

- your username, display name and avatar;
- the same for the other people who joined the app;
- its own shared state and its own messages.

**An app cannot**

- read your LAN Party session, cookies or saved data, or act as you — it runs in a sandboxed frame
  with an origin of its own, and the server sends the same restriction as a header, so this holds
  even when the app is opened in a new tab;
- see your messages, friends, servers, or who is in the voice channel but has not joined the app;
- get at your camera or microphone — the frame it runs in is not granted them;
- say who it is. The server stamps every change and message with the sender's real name; nothing an
  app sends can claim to come from someone else;
- reach another channel, or do anything in LAN Party other than change its own state and send its
  own messages. It cannot join anyone, start itself or end itself;
- run in your client because someone else started it. You see a card first, and the app loads only
  if you press Join.

An app can still load things from the internet and show whatever it likes inside its own frame, so
the usual sense applies: do not type a password into a community app.

## Developing without a room

`connect()` always gives you something to work with. With no LAN Party around the page — nothing
answers within `timeoutMs`, or the page is not inside a frame at all — you get **standalone mode**:

- `lp.standalone` is `true`;
- `lp.me` is `{ username: 'you', displayName: 'You', avatarUrl: '' }` and `lp.participants` is just
  that;
- `setState` / `replaceState` work on a local object, with the same limits, and fire `'state'`;
- `emit` does nothing.

Ways to get there:

- **Open in new tab** from the App Directory viewer — the quickest check that standalone works.
- **Serve the file yourself** next to a copy of the SDK. `server/sdk/lanparty.js` is one
  self-contained file; put it where `/sdk/lanparty.js` resolves (for example
  `npx serve` in a folder that has `index.html` and `sdk/lanparty.js`).
- **Double-click the file.** From `file://` the path `/sdk/lanparty.js` does not exist, so
  `LANParty` is undefined. Either point the script tag at your server while developing
  (`https://your-lan-party-host/sdk/lanparty.js` — it is served with open CORS), or do what the
  buzzer sample does and fall back to a few lines of stand-in when `window.LANParty` is missing.

To try it with other people before uploading for everyone, there is no private mode yet: upload it,
test it in a voice channel, and remove it again if it is not ready.

## Patterns that work

- **Give each player their own keys.** `setState` merges per top-level key, and the last write to a
  key wins. If every player writes to `score:<username>` rather than to one shared `scores` object,
  two people changing things at the same moment cannot overwrite each other.
- **Let the server's order decide races.** `'state'` events arrive in the order the server accepted
  the changes, and `info.by` says whose each one was. That is a fair "who was first" — players'
  clocks are not. The buzzer sample is built on this.
- **State for what is true, `emit` for what just happened.** The score is state. The sound it makes
  is a message. Someone who joins late should get the first and has no use for the second.
- **Clean up after yourself.** Set finished rounds' keys to `null`; the 200-key and 64 KB limits are
  for the whole object.
- **Design for people arriving and leaving.** A participant can join at any point and gets the
  current state, not the history. People also drop out and come back all evening without meaning
  anything by it: opening a text channel during the call closes the app for them until they
  return, and their copy of the page starts again from the shared state. Keep nothing that matters
  only in a page's own variables.

## Not yet

Planned, not built — do not design around them:

- **Registered apps with credentials.** Client ids and secrets, and a server-to-server API.
- **Scopes.** Asking for more than name and avatar, with the user's consent.
- **Sign-in with LAN Party** for apps hosted elsewhere.
- **Review before publishing.** Today an upload is visible to everyone at once.
- **Storage that outlives a session**, per app or per player.

## For people working on LAN Party itself

| Piece | Where |
| --- | --- |
| The SDK the app loads | `server/sdk/lanparty.js`, served at `GET /sdk/lanparty.js` |
| Host side of the bridge (iframe ↔ LAN Party) | `client/src/appBridge.ts` |
| The Join card and the frame in a voice channel | `client/src/components/AppActivity.tsx` |
| The solo viewer | `client/src/components/AppViewer.jsx` |
| Server rules: limits, joined list, rate limit | `server/services/activities.js` (`applyAppEvent`), socket handlers in `server/index.js` |
| Tests | `server/test/appActivity.test.js` |

The app and the host talk over `postMessage`. Every message is an object with `lanparty: 1` and a
`type`. App to host: `hello`, `set`, `replace`, `emit`. Host to app: `welcome`, `state`, `ack`,
`participants`, `message`, `closed`. The frame's origin is opaque, so neither side can check an
origin: each accepts a message only from the exact window it expects (the app from its parent, the
host from that iframe), and the host posts with a `'*'` target — which is acceptable only because
nothing secret is ever put on the bridge.

**Who has joined** is tracked by the server, per connection: pressing Join sends a `join` event,
Leave sends `leave` (so does the app's panel going off screen, when the person looks at another
channel), and leaving the voice channel or disconnecting removes you. The activity state carries
the resulting list of usernames (`joined`), which is what `lp.participants` is built from. Only
joined connections are sent the app's state and messages; everyone else in the channel gets just
enough to draw the card. Join and leave are sent by LAN Party's own interface and are not part of
the `postMessage` protocol, so an app cannot join anybody.

A change to that list goes to the room as its own small socket event, `activity:app-joined`
`{ run, joined }`, rather than as a full `activity:update`: only the connection that just joined
(and needs the state) or just left (and must drop it) is sent the activity again. People coming
and going therefore never cost the others a copy of the shared state.

**Each start of an app is a run** with a random id (`state.run`). The client sends it back with
every app event (`app` beside `event` in the `activity:event` payload), and the server answers
`{ ok: false, reason: 'ended' }` to an app event whose run is not the one the room is running — so
an event still on the wire when the activity was replaced cannot land on its replacement. Built-in
activities send no `app` tag; an untagged event never reaches an app, and a tagged one never
reaches a built-in.

When the server answers `not-joined`, `not-in-room` or `ended`, or the socket reconnects (a new
socket is in no voice room), the client takes the frame down and shows the card again.
