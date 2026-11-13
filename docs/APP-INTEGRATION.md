# Building apps for LAN Party

An **app** is a small web page somebody uploads to the App Directory: a single `.html` file, or a
`.zip` with an `index.html` and its assets. LAN Party hosts it and runs it in a sandbox.

An uploaded app can be started as a **Thing To Do** in a voice channel, where everyone who joins
it shares one piece of state. Whoever uploaded it can do that straight away; it is listed for
everybody else once an instance owner has approved it (see
[Drafts, review and publishing](#drafts-review-and-publishing)). To take part in that, the app loads a small script — the **bridge
SDK** — which tells it who is looking, who else has joined, and gives it a shared object and a way
to send short messages. Nothing has to be changed on the server to add an app.

- [Upload an app](#upload-an-app)
- [Drafts, review and publishing](#drafts-review-and-publishing)
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

1. Open the **App Directory**, go to the **Developer** tab and choose **Upload an app → Upload a
   mini-app**.
2. Give it a name, a description and (optionally) an icon.
3. Pick a `.html` file, or a `.zip` that contains `index.html`. If there is none at the top level
   of the zip (you zipped a folder, say), the `index.html` nearest the top is used and **its folder
   becomes the app**: files outside that folder are not kept, so keep everything the app needs
   beside or below its `index.html`. Uploads are limited to 15 MB; a zip may hold up to 300 files
   and 60 MB unpacked.
4. Upload. The app is saved as a **draft**: it is listed under **My apps** in the Developer tab,
   and under **Community apps** in the **Things To Do** menu — for you only. When it is ready for
   everyone, choose **Submit for review**.

There are two ways to run it:

- **In a voice channel.** Someone picks it from Things To Do. Everyone in the channel sees a card
  with the app's name, who started it, who uploaded it and who is in, and a **Join** button. The app
  only loads for the people who press Join (the person who started it is in from the start).
  **Leave** closes it for you; **End** closes it for everyone. Looking at another channel while
  still in the call also closes it for you — the app only runs while its panel is on screen — and
  you get the card again when you come back.
- **On your own.** *Open* in the App Directory runs the same app by itself. The SDK still works —
  you are the only participant and the state is yours alone, kept until you close the viewer.

You can delete an app you uploaded. If it is running somewhere at that moment, it ends there.

## Drafts, review and publishing

Anyone can upload an app and use it themselves. Making it visible to everyone takes the approval
of an **instance owner** — a person who runs this LAN Party server.

Every app is in one of four states:

| Status | Shown as | Who sees it in the directory | Who can start it in a voice channel |
| --- | --- | --- | --- |
| `draft` | Draft | its uploader, instance owners | its uploader, instance owners¹ |
| `pending` | In review | its uploader, instance owners | its uploader, instance owners |
| `published` | Published | everyone | everyone |
| `rejected` | Changes requested | its uploader, instance owners | nobody, while it is in this state² |

¹ The server accepts it, but the **Things To Do** menu only lists somebody else's app for an
instance owner once it is **in review**. An owner who wants to try another person's draft opens it
on its own from the Review tab.

² Rejected is a status, not a ban. The uploader can submit the app again, withdraw it or replace
its bundle; it is then in review or a draft like any other, and theirs to start in a voice channel
again (marked as not approved). An instance owner who wants an app gone deletes it — and nothing
stops the same file being uploaded again as a new draft, which only its uploader can start.

A new upload is a draft. (An instance owner's own upload is published at once: there is nobody
else to ask.) Apps that existed before review was introduced stayed published.

A **link** app needs a full web address (`http://` or `https://`); the upload form refuses
anything else. The address is shown in full to the uploader and the reviewer, and cannot be
changed after uploading — delete the app and add it again.

**What the uploader can do**, from the Developer tab:

- **Open** it on its own, in any status, and **start it in a voice channel** they are in while it
  is a draft or in review.
- **Submit for review** (draft or changes requested → in review) and **Withdraw** (back to draft).
  An uploader who is an instance owner has nobody to submit to: they get **Publish** instead.
- **Edit details** — name, description, icon — in any status. This never changes the status.
- **Replace bundle** — upload new files for the same app, with the same checks and limits as a
  first upload. The app goes back to **Draft**, because what was reviewed is no longer what would
  run; submit it again. The old files are deleted and the app gets a new address, so a room running
  it is ended. If the new upload is refused, the old files and the status stay as they were.
- **Unpublish** a published app (back to draft), and **Delete** it.
- **Check app** — loads the bundle out of sight for a few seconds and reports three things: did the
  page load, did it say hello to the bridge, did it set any state. It is a diagnostic for the
  developer. It is not a review, and it says nothing about whether the app will be approved.

**What an instance owner can do**, from the **Review** tab (which only they are shown):

- open any app to test it;
- **Approve** an app that is in review — or publish a draft or a sent-back app directly. Approving
  a bundle approves the files the owner was shown: the request names them (`POST /apps/:id/approve`
  with `{ "url": "<the app's url as listed>" }`), and if the uploader has replaced the bundle since,
  the server refuses with 409 and nothing is published. The Review tab marks such an app and asks
  for it to be opened again first. A link needs no `url`;
- **Reject** an app that is in review or published, with an optional note (up to 500 characters)
  that the uploader sees next to the app;
- **Unpublish** or **Delete** anyone's app.

The uploader is told when their app is approved, sent back, unpublished or removed; instance
owners are told when an app is submitted.

**An unapproved app in a voice channel.** When an uploader starts their draft, the other people in
the channel get the same card as for any app, with one difference: it says clearly that the app is
**not approved yet**, and by whom it was started. Nothing loads for anyone who does not press
Join. If the app is approved while it is running, the warning goes away; if it is rejected,
unpublished, replaced or deleted while it is running, it ends for the room.

**What a draft is not.** A draft is hidden from the directory, and nobody else can find out that it
exists. But an app's files are served from an address that is long and random, not from one that
asks who you are — so "draft" is not access control on the files themselves. Somebody you start a
draft with, or give the address to, can load it.

**Who is an instance owner.** By default, the oldest account on the server (the first one that was
created). The person running the server can name the owners instead, with the `INSTANCE_OWNERS`
environment variable: usernames separated by commas. When it names at least one username it
replaces the default — the oldest account is then an owner only if it is on the list. Left unset,
or set to nothing but commas and spaces, the default stands.

The names are matched exactly, capitals included, and the accounts must exist before they are
listed:

- a listed name that no account has makes nobody an owner (the server says so in its log at every
  start), so a typo can leave an instance with nobody to review apps;
- a listed name cannot be registered or renamed into, in any capitalisation — otherwise the role
  would go to whoever took the name;
- the list does not follow a rename, so an account that is an owner by name cannot change its
  username until the list is changed.

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

To try it with other people before it is published, upload it and start it yourself in a voice
channel: a draft is yours to run, and the others see it marked as not approved and choose whether
to join. **Check app** in the Developer tab is the quickest way to see whether the uploaded copy
reaches the SDK at all.

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
- **Storage that outlives a session**, per app or per player.

## For people working on LAN Party itself

| Piece | Where |
| --- | --- |
| The SDK the app loads | `server/sdk/lanparty.js`, served at `GET /sdk/lanparty.js` |
| Host side of the bridge (iframe ↔ LAN Party) | `client/src/appBridge.ts` |
| The Join card and the frame in a voice channel | `client/src/components/AppActivity.tsx` |
| The solo viewer | `client/src/components/AppViewer.jsx` |
| The directory: Browse, Developer and Review tabs | `client/src/components/AppDirectoryModal.jsx`, `AppDeveloperTab.tsx`, `AppReviewTab.tsx`, `AppDirectoryDialog.tsx` |
| "Check app" | `client/src/appCheck.ts` |
| Statuses, transitions, who may see and change an app | `server/routes/library.js` |
| Who is an instance owner | `server/services/instanceOwners.js` |
| Server rules: limits, joined list, rate limit | `server/services/activities.js` (`applyAppEvent`), socket handlers in `server/index.js` |
| Tests | `server/test/appActivity.test.js`, `server/test/appApproval.test.js` |

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
