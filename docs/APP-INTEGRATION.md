# Building apps for LAN Party

An **app** is a small web page somebody uploads to the App Directory: a single `.html` file, or a
`.zip` with an `index.html` and its assets. LAN Party hosts it and runs it in a sandbox.

An uploaded app can be started as a **Thing To Do** in a voice channel, where everyone who joins
it shares one piece of state. Whoever uploaded it can do that straight away; it is listed for
everybody else once an instance owner has approved it (see
[Drafts, review and publishing](#drafts-review-and-publishing)). To take part in that, the app loads a small script — the **bridge
SDK** — which tells it who is looking, who else has joined, and gives it a shared object and a way
to send short messages. Nothing has to be changed on the server to add an app.

An app can also be a site that lives **on its own server**: a link app with **Run inside LAN
Party** turned on. LAN Party frames it from its own address instead of hosting its files, and it
uses a copy of the same SDK. That is a [hosted app](#hosted-apps), and it has a section of its own;
everything else in this document is written for uploaded apps and says so where a hosted app
differs.

- [Upload an app](#upload-an-app)
- [Drafts, review and publishing](#drafts-review-and-publishing)
- [A complete example](#a-complete-example)
- [The SDK](#the-sdk)
- [Limits](#limits)
- [What an app can and cannot see](#what-an-app-can-and-cannot-see)
- [Developing without a room](#developing-without-a-room)
- [Hosted apps](#hosted-apps)
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
anything else. The address is shown in full to the uploader and the reviewer. A link either opens
in a new browser tab, or — with **Run inside LAN Party** on — runs in a frame like an uploaded app
(a [hosted app](#hosted-apps), which asks more of the address). Both the address and that setting
can be changed later under **Edit details**, and both are what a reviewer approved: changing
either sends the app back to **Draft** and ends it in any voice channel running it, exactly as
replacing a bundle does.

**What the uploader can do**, from the Developer tab:

- **Open** it on its own, in any status, and **start it in a voice channel** they are in while it
  is a draft or in review.
- **Submit for review** (draft or changes requested → in review) and **Withdraw** (back to draft).
  An uploader who is an instance owner has nobody to submit to: they get **Publish** instead.
- **Edit details** — name, description, icon — in any status. This never changes the status.
  For a link app the same dialog holds the address and **Run inside LAN Party**; changing either
  of those two does reset the status to Draft (an instance owner's own app keeps its status) and
  ends the app in any voice channel running it. The dialog says so before you save.
- **Replace bundle** — upload new files for the same app, with the same checks and limits as a
  first upload. The app goes back to **Draft**, because what was reviewed is no longer what would
  run; submit it again. The old files are deleted and the app gets a new address, so a room running
  it is ended. If the new upload is refused, the old files and the status stay as they were.
- **Unpublish** a published app (back to draft), and **Delete** it.
- **Check app** — loads the bundle out of sight for a few seconds and reports three things: did the
  page load, did it say hello to the bridge, did it set any state. It is a diagnostic for the
  developer. It is not a review, and it says nothing about whether the app will be approved.
  It is offered for bundles only: the check runs the app with no origin and no storage, which is
  how a bundle really runs and not how a hosted site does, so its answers about a hosted app would
  be wrong. Test a hosted app with **Open**, and in a voice channel.

**What an instance owner can do**, from the **Review** tab (which only they are shown):

- open any app to test it;
- **Approve** an app that is in review — or publish a draft or a sent-back app directly. Approving
  a bundle approves the files the owner was shown: the request names them (`POST /apps/:id/approve`
  with `{ "url": "<the app's url as listed>" }`), and if the uploader has replaced the bundle since,
  the server refuses with 409 and nothing is published. The Review tab marks such an app and asks
  for it to be opened again first. A hosted app is held to the same, on both things that were
  reviewed: the request must name its address and say that it runs inside
  (`{ "url": "<its address as listed>", "embed": true }`), and an edit to either since then is
  refused with 409. A plain link is held to it too (`{ "url": "<its address as listed>", "embed":
  false }`): its uploader can repoint it, or switch it to run inside and back, while it is being
  looked at. A request that leaves out `url` or `embed` for any link app is refused with 400; one
  that names something other than the app as it stands, with 409. The client always sends both, as
  `{ url, embed }`, for what it showed the reviewer;
- **Reject** an app that is in review or published, with an optional note (up to 500 characters)
  that the uploader sees next to the app;
- **Unpublish** or **Delete** anyone's app.

The uploader is told when their app is approved, sent back, unpublished or removed; instance
owners are told when an app is submitted.

**An unapproved app in a voice channel.** When an uploader starts their draft, the other people in
the channel get the same card as for any app, with one difference: it says clearly that the app is
**not approved yet**, and by whom it was started. Nothing loads for anyone who does not press
Join. If the app is approved while it is running, the warning goes away; if it is rejected,
unpublished, replaced or deleted while it is running — or, for a link app, its address or its
**Run inside LAN Party** setting is edited — it ends for the room.

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

It is served with `Cache-Control: no-cache`: a browser may keep a copy, but checks it with the
server every time before using it (a `304` with no body when nothing changed). So an uploaded app
gets a corrected SDK the next time it loads, with no cache lifetime to wait out.

### `LANParty.connect(options?)` → `Promise<lp>`

Resolves once LAN Party has answered. It never rejects: if nothing answers (see
[Developing without a room](#developing-without-a-room)) you get a working `lp` in standalone mode.
Calling it again returns the same connection.

| Option | Default | |
| --- | --- | --- |
| `timeoutMs` | `1500` | How long to wait for LAN Party before going standalone. |
| `hostOrigins` | not set | For [hosted apps](#hosted-apps). The only origins the page accepts as its host, for example `['https://lanparty.example.com']`. Leave it out in an uploaded app. |

### `lp`

| | |
| --- | --- |
| `lp.me` | `{ username, displayName, avatarUrl }` — the person looking at this copy of the app. `avatarUrl` may be `''`. |
| `lp.room` | `{ id }` in a voice channel, `null` when the app is open on its own or standalone. `id` is an opaque name for *this app in this voice channel*: 32 lower-case hex characters, the same every time the app runs in that channel until the server's app rooms are [replaced](#when-the-room-id-is-replaced), different for every other app. See [The room id](#the-room-id). |
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
gone. There is no storage that outlives a session. (A [hosted app](#hosted-apps) has a server of
its own and can keep whatever it likes there, filed under [the room id](#the-room-id).)

## What an app can and cannot see

Apps are uploaded by members, so LAN Party treats every one as untrusted code.

What follows is about **uploaded** apps. A hosted app is told exactly the same things over the
bridge and nothing more, but it is a site of its own rather than code in LAN Party's sandbox; what
that changes is under [Hosted apps](#what-a-hosted-app-is-and-is-not-trusted-with).

**An app can see**

- your username, display name and avatar;
- the same for the other people who joined the app;
- an opaque id for the voice channel it is running in (`lp.room`), once you have joined it. It is
  made for that one app, says nothing about which server or channel it is, and is not the id any
  other app is given for the same channel;
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

## Hosted apps

A hosted app is a web site on **your own server**, at its own address, that LAN Party shows in a
frame: on its own from the App Directory, and as a Thing To Do in a voice channel. Nothing is
uploaded. It keeps its own storage, cookies and backend, which an uploaded app does not have — so
it suits something that already exists as a site, or that needs a server of its own (a shared
music queue, a game with accounts).

### Adding one

1. **App Directory → Developer → Upload an app → Link (external URL).**
2. Enter the address and tick **Run inside LAN Party**.
3. It is saved as a draft like any other app, and goes through the same review: you can open it
   and start it in a voice channel yourself straight away (marked as not approved), and everyone
   can once an instance owner has approved it.

An existing link app becomes a hosted app the same way, under **Edit details**. Turning the
setting on or off, or changing the address, is a change to what was reviewed: a published app goes
back to Draft (unless you are an instance owner), and it ends in any voice channel running it.

### What the site has to do

- **Be served over `https://`.** Plain `http://` is accepted only for `localhost` and `127.0.0.1`,
  and only while LAN Party itself is being opened at a loopback address (`localhost`, `127.0.0.1`
  or `[::1]`): that is developing both on your own machine. On a real LAN Party an
  `http://localhost` address would frame whatever each viewer runs on their own computer, so it is
  refused there, by the server and by the client. No username or password in the address; 2000
  characters at most. The address is stored the way a browser spells it (lower-case host, default port dropped).
- **Be on a different origin than LAN Party.** This is the one rule everything else rests on, and
  it is checked by the server (when the address is saved, when the app is approved and when it is
  started) and again by the client before it builds the frame. A different port counts as a
  different origin; a path on LAN Party's own address does not. See
  [why](#what-a-hosted-app-is-and-is-not-trusted-with) below.
- **Allow being framed by LAN Party.** If the site sends `X-Frame-Options`, or a
  `Content-Security-Policy` with `frame-ancestors`, it must let the LAN Party origin in
  (`frame-ancestors https://lanparty.example.com`). A site that refuses shows as an empty frame;
  LAN Party cannot detect that for you.
- **Work inside a sandboxed frame.** The frame is
  `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-pointer-lock"` with
  `allow="autoplay; encrypted-media; fullscreen; gamepad"`. So: scripts, forms, your own storage
  and cookies, media playback and pop-ups work. There is no `allow-modals`, so `alert` /
  `confirm` / `prompt` do nothing (they return at once: `confirm` is `false`, `prompt` is `null`)
  — ask in your own page instead. The site cannot navigate the LAN Party window, a pop-up it opens
  stays under the same sandbox, and there is no camera or microphone. See also
  [Known limits](#known-limits).
- **Expect partitioned storage.** Browsers generally keep a framed site's cookies and storage apart
  from the same site visited directly, unless the two are on the same registrable domain
  (`music.example.com` inside `lanparty.example.com` shares; `music.example.org` does not). On an
  unrelated domain, someone signed in to your site in a tab is not signed in inside the frame.

Optionally, the site can **use the SDK** to learn who is looking and which room it is in. Without
it the site still runs; it just knows nothing about LAN Party.

### `lanparty=1`

LAN Party adds the query parameter `lanparty=1` to the address when it frames it, and leaves the
rest of the query and the fragment as they were. That is all that ever goes in the URL — no name,
no token, no room. It is a hint that the bridge is worth trying, not evidence of anything: anybody
can type it. Decide that you are inside LAN Party only when the page is framed **and** the
handshake below succeeds.

### Vendoring the SDK

Copy `server/sdk/lanparty.js` (the file every LAN Party serves at `/sdk/lanparty.js`) into your
own code and serve it from your own origin. Do **not** load it from a LAN Party server at run
time: a script from another origin runs with all the powers of yours — your users' sessions and
tokens included — and you would be handing those to whoever runs that server.

The file is a plain script that sets `window.LANParty`; it has no exports and no dependencies. In
a bundled project, import it for its side effect. Additions to the protocol are backwards
compatible, so a copy keeps working; take a new one when you want a newer feature.

### `hostOrigins`: saying which LAN Party you trust

An uploaded app has no origin and nothing of its own to protect, so it talks to whatever page
frames it. A hosted app must not: any page on the internet can frame your site and play the host.
So name the LAN Party origins you accept:

```js
import './vendor/lanparty.js';            // your copy; sets window.LANParty

const LANPARTY_ORIGINS = ['https://lanparty.example.com'];   // decided at build time

async function start() {
  const framed = window.parent !== window;
  const asked = new URLSearchParams(location.search).get('lanparty') === '1';
  if (framed && asked) {
    const lp = await window.LANParty.connect({ hostOrigins: LANPARTY_ORIGINS, timeoutMs: 3000 });
    if (!lp.standalone) {
      const user = { id: 'lp:' + lp.me.username, name: lp.me.displayName };
      // null: opened on its own, so a private session for this one person
      const room = lp.room && /^[0-9a-f]{32}$/.test(lp.room.id) ? 'lanparty:' + lp.room.id : null;
      return startInsideLanParty(lp, user, room);
    }
  }
  startAsUsual();                          // never a blank page
}
```

With `hostOrigins` given:

- `hello` is posted once per listed origin, with that origin as the `postMessage` target — never
  `'*'`. The browser delivers it only if the parent page really is on that origin.
- A message from the host is accepted only if it comes from the parent window **and** its
  `event.origin` is in the list. After the first `welcome`, only that origin is listened to and
  posted to.
- Each entry is reduced to its origin by the browser's own URL parser, so it matches
  `event.origin` exactly: case and a default port are tidied, a trailing slash or a path is
  dropped (`https://lanparty.example.com/app/` is `https://lanparty.example.com`), and an
  international domain name becomes its punycode form (`https://bücher.example` is
  `https://xn--bcher-kva.example`). An entry that is not an absolute `http(s)://` address with a
  host — `'*'`, `//host`, a bare name, a non-string, or one with a username or password in it — is
  dropped with a console warning, and the entries after it are still used.
- At most **20** origins are used; any after the twentieth are ignored, with a warning.
- If nothing usable is left, no host is accepted at all and `connect()` resolves in standalone mode
  at once; it never falls back to accepting anyone.
- If no listed host answers within `timeoutMs`, you get standalone mode, as always. `connect()`
  never rejects: a target the browser refuses to post to is skipped (with a warning) and the others
  are still tried, and anything that goes wrong while connecting ends in standalone mode.

The list is the trust decision, so keep it in your build or your server's configuration. Never
take a host origin, or the address of a script to load, from the query string or from a message.

LAN Party does the same from its side: it posts to your app's exact origin, and accepts a message
only from your frame's window **and** your origin. If the frame navigates to another site, that
site hears nothing and is not listened to.

### The room id

In a voice channel `lp.room` is `{ id }`: 32 lower-case hex characters that name *your app in
that voice channel*. It is what makes "everyone in this channel lands in the same place" work
without your site knowing anything about LAN Party's servers or channels:

- **It is stable, until it is replaced.** The same channel gives your app the same id every time,
  across sessions and server restarts. Use it as the key of a room on your own backend
  (`'lanparty:' + lp.room.id`), and whatever you keep there — a queue, a scoreboard — is still
  there next time. It stops being the same when the LAN Party server (the community, not the
  machine) that the channel belongs to has its app rooms replaced:
  see [When the room id is replaced](#when-the-room-id-is-replaced).
- **It is yours alone.** It is an HMAC, keyed by a secret on the LAN Party server, over your app's
  id, your app's **origin**, the channel, and a counter kept for the channel's server (its *app
  room epoch*). Another app gets a different id for the same channel, so two apps cannot compare
  notes; and the id reveals nothing about the server, the channel or the counter.
- **It is given only to people who joined**, and only while they may open the channel. Someone in
  the voice channel who has not pressed Join never receives it; neither does someone who has been
  removed from the server or from a private channel, even if their client is still connected.
- **It is `null`** when the app is opened on its own from the directory, and in standalone mode.
  Treat `null` as "a private session for this one person" — never as a room that people share.
- **Check its shape** (`/^[0-9a-f]{32}$/`) before using it in a key, a path or a query of your own.
- **It can also change** if the person running the LAN Party instance changes its signing secret,
  if your app is deleted and added again (it is then a new app), or if your app's address is moved
  to a **different origin** (another host, scheme or port): the key is bound to the site it is
  given to, so a new site gets new keys rather than inheriting the old one's. A new path or query
  on the same origin keeps them. What you stored under the old ids is not reachable through the
  new ones.

Uploaded apps get `lp.room` too, though with no backend to key by it most have no use for it.

#### When the room id is replaced

The room id is a bearer value: your backend lets in whoever presents it. Someone who joined your
app in a channel keeps the id they were given, and LAN Party cannot take it out of their hands. So
that a person who has left a server does not keep a way into its channels' rooms on your backend,
every room id also depends on a counter that LAN Party keeps per server, the **app room epoch**.
When the counter moves, every voice channel of that server has a new room id for every app, and
the old ids are never given out again.

The counter moves, for the one server concerned and no other:

- when a member is **removed** from the server (kicked);
- when a member **leaves** the server;
- when a member is **taken off a private channel's access list**;
- when an **admin is made a member again** and there is a private channel they are not listed on
  (as an admin they could open it; as a member they cannot);
- when someone's **account is deleted** — in every server they were a member of;
- when the server's owner or an admin chooses **Reset app rooms…** in the server's menu
  (`POST /servers/:serverId/app-rooms/reset`, at most ten times in ten minutes per person).

Nothing else moves it: not joining a server, not being added to a channel, not starting or ending
an app, not a restart of LAN Party. The **public commons never changes**: everyone is a member of
it and nobody is ever removed, so there is nobody to take a room away from, and it cannot be reset
by hand either. Channels there keep their room ids.

When the counter moves, **every app running in that server's voice channels is ended** at that
moment (the people in it were on the old id), and people who were in one are told that app rooms
were reset. Whoever starts your app there next gets the new id. To your app this looks like a room
it has never seen: `lp.room.id` is a different 32 characters and your backend has nothing under it.
That is the whole of what your app has to handle. In practice: start an empty room, and expect it —
on a busy server it can happen whenever anybody leaves.

What this does and does not do, in plain words:

- **It protects a channel's room from people who have left.** After they go, the room everyone
  else is sent to is one they were never given the id of.
- **It cannot stop a current member from sharing an id.** Anyone who has joined your app holds the
  current id and can pass it on. That person, and whoever they gave it to, can reach the room on
  your backend until the next time the counter moves.
- **What you stored under an old id stays on your server.** LAN Party does not tell your backend
  that an id was retired, and cannot delete anything there. The old room is simply no longer where
  LAN Party sends anyone; someone who still holds the old id can still open the old room, with
  whatever was in it. If that matters, do not keep rooms for ever: expire a room that nobody has
  opened for a while.
- **It does not make identity trustworthy.** Who a visitor says they are is still a name your page
  passes on, not something your backend can check; see
  [Identity is a name, not proof](#identity-is-a-name-not-proof).

`lp.state`, `lp.setState`, `lp.emit` and `lp.participants` work in a hosted app exactly as in an
uploaded one, with the same [limits](#limits). An app with its own backend will usually keep its
real state there and use the bridge for identity, the room id and who has joined.

### Identity is a name, not proof

What the bridge tells your app is the viewer's **public name** (and avatar) and the room id. It
arrives by `postMessage` from the page that frames you. Checking `hostOrigins` tells your page
that this really is the LAN Party it trusts — and that is all it tells anyone.

**Your backend has no way to verify it.** Nothing is signed. Whatever your page then sends to your
own server ("I am `ann`, in room `lanparty:3f…`") is a claim made by a browser, and anyone can
open your site, skip the SDK and send the same request with any name they like. Likewise the room
id is a shared secret among the people who joined the app in that channel — holding it shows that
someone was let in (or was given it by someone who was) at some point since the room id was last
[replaced](#when-the-room-id-is-replaced), not who they are.

So, for now:

- use the name for display and for attributing things inside a room ("queued by Ann");
- do not attach anything valuable to it: no account, no purchases, no private data keyed by a
  LAN Party name;
- keep ids that came from LAN Party apart from your own accounts (a prefix like `lp:` does it), so
  a LAN Party name can never collide with, or be mistaken for, a real account on your site;
- treat a `lanparty:` room like a link shared among friends: fine for a queue, not for secrets.

A signed assertion your server could check — sign-in with LAN Party — is planned; see
[Not yet](#not-yet).

### What a hosted app is, and is not, trusted with

A hosted app is told the same things as an uploaded one (names, avatars, the room id, its own
state and messages) and LAN Party's own interface is just as closed to it: it cannot join anyone,
start or end itself, or see messages, friends or channels. What is different is where it runs.

- **It is not in LAN Party's sandbox.** An uploaded app is forced into an origin of its own with
  no storage and no way out. A hosted app runs as the site it is: it has that site's cookies and
  storage, talks freely to that site's server, and can load anything else it likes.
- **It is kept away from your LAN Party session by being a different origin** — the browser's
  ordinary wall between two sites. That is why the address may never be LAN Party's own: a frame
  that is same-origin with the page around it, with scripts allowed, could reach up into that
  page and read your session. The server refuses such an address and the client refuses to frame
  one, each on its own.
- **Approval covers an address, not a version.** A reviewer approves *that site, framed*. Its
  owner can change what it serves the next day without anything coming back for review, which is
  not true of an uploaded bundle. An instance owner should approve a hosted app only from someone
  they would trust with that.
- **What you do inside it goes to that site.** The Join card says so, and names the site. The
  usual sense applies even more than for an uploaded app: it is somebody's web site.

### Trying it

- **Open** in the App Directory runs it in the viewer: the SDK connects, `lp.me` is you,
  `lp.room` is `null`. **Open in new tab** is the site as anyone visits it (no `lanparty=1`).
- Start your draft in a voice channel to see the real thing, room id included.
- For local development, run LAN Party on your machine too, open it at `http://localhost:<port>`,
  register `http://localhost:<another port>/` as the address and put the origin you open LAN Party
  at in `hostOrigins`. The app must be on a different port than LAN Party. (Against a real LAN
  Party, an app has to be on `https://`.)
- **Check app** is not offered for hosted apps (it would test them under conditions they never run
  in).

### Known limits

- **No DRM playback in the Windows desktop app.** The LAN Party desktop app is stock Electron, which
  has no Widevine, so anything that needs DRM / Encrypted Media Extensions — Spotify's player, and
  most paid streaming services — does not play inside it. YouTube and other media without DRM play
  fine. In a browser (and in the Android app) DRM playback works as the browser allows it.
- **No dialogs.** As above, hosted frames get no `allow-modals`: `alert`, `confirm` and `prompt` do
  nothing. Put confirmations in your page.
- **Directory entries in old tabs.** A LAN Party tab opened before hosted apps existed lists a
  hosted app as a plain link, which opens the site in a new tab. Reloading it is enough.

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
- **Sign-in with LAN Party** for apps hosted elsewhere: something signed that a hosted app's own
  server can check. Until it exists, what a [hosted app](#hosted-apps) is told is a public name,
  [not proof of who is there](#identity-is-a-name-not-proof).
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
| Hosted apps: the address rules, the room key | `server/services/hostedApps.js`; the frame and its origin check in `client/src/appBridge.ts` (`hostedAppFrame`) |
| The app room epoch: when room keys are replaced | `server/services/appRooms.js` (which lists every caller); the reset route in `server/routes/servers.js` |
| Who is an instance owner | `server/services/instanceOwners.js` |
| Server rules: limits, joined list, rate limit | `server/services/activities.js` (`applyAppEvent`), socket handlers in `server/index.js` |
| Tests | `server/test/appActivity.test.js`, `server/test/appApproval.test.js`, `server/test/hostedApps.test.js`, `server/test/appRooms.test.js` |

In `GET /apps`, **`embeddable` means "uploaded bundle" and nothing else**; a hosted app has
`embeddable: false, hosted: true`. Tabs opened before hosted apps existed read `embeddable` as
"frame it in the bundle sandbox", where a hosted site is a blank page; with it false they show a
hosted app as a plain link (it opens in a new tab), which works. Current client code asks `hosted`
first and treats an app as runnable inside when `hosted || embeddable` (`runsInside()` and
`isBundleApp()` in `client/src/components/AppDirectoryParts.tsx`).

The app and the host talk over `postMessage`. Every message is an object with `lanparty: 1` and a
`type`. App to host: `hello`, `set`, `replace`, `emit`. Host to app: `welcome`, `state`, `ack`,
`participants`, `message`, `closed`. The `welcome` carries `me`, `participants`, `room`
(`{ id }` or `null`), `shared` and `rev`.

For an uploaded bundle the frame's origin is opaque, so neither side can check an origin: each
accepts a message only from the exact window it expects (the app from its parent, the host from
that iframe), and the host posts with a `'*'` target — which is acceptable only because nothing
secret is ever put on the bridge. A hosted app's frame has a real origin, and both sides use it:
the host posts to that exact origin and accepts a message only from the iframe's window **and**
that origin (`frameOrigin` in `createAppBridge`); the app does the mirror image with `hostOrigins`.

**A hosted app's frame** is built by `hostedAppFrame()` and nowhere else. It returns the address
with `lanparty=1` added and the origin for the bridge, or refuses: when the address is not a plain
`https://` one — the one exception being `http://localhost` and `http://127.0.0.1`, and only while
the page itself is on a loopback host (`window.location.hostname` is `localhost`, `127.0.0.1` or
`[::1]`); the server applies the same exception only when every name the request was sent to
(Host, X-Forwarded-Host, Origin) is a loopback one (`servedFromLoopback`) — and when its origin
is this page's own (or the API server's, where the client is served from somewhere else). That refusal is independent of the server's — the server cannot
always know the name a browser reached it by. The real-origin sandbox
(`allow-scripts allow-same-origin …`) is only ever put on a frame whose `src` came from there.
The frame's `src`, `sandbox` and `allow` are worked out from the run's own url and never change
while it is mounted, so a re-render never reloads the app.

**The room key** (`state.roomKey`) is computed by the server when the app is started:
`HMAC-SHA256` under a key derived from `JWT_SECRET`, over
`JSON.stringify([appId, frameOrigin, serverId, channelId, epoch])`, cut to 32 hex characters.
`frameOrigin` is the hosted app's origin (`new URL(url).origin`) or the constant `'bundle'` for an
uploaded one (`appFrameOrigin`), so moving a hosted app to another origin rotates all of its keys,
and a bundle and a hosted app never share one. It is in the activity state only for sockets that have joined the app; everyone
else's copy has `null`. The client passes it to the app as `room` in the `welcome`, and the solo
viewer always sends `room: null`.

**The epoch** is `servers.app_room_epoch`, an integer that starts at 0 and only ever counts up
(migration `0013_app_room_epoch`). It is in the signed text from 0 on; there is no four-part form
of the key and no compatibility path for one, because nothing had been stored under such a key
when the epoch was added. `appRooms.rotate(serverId)` (`server/services/appRooms.js`) adds one and
ends every app activity in that server's voice rooms, through the same function that ends an app
when it is deleted or unpublished (`endAppActivitiesWhere` in `server/index.js`): each room gets
`activity:update` `null`, and the sockets that had joined are first sent `activity:app-ended`
`{ run, reason: 'rooms-reset' }`, which the client shows as a toast. The callers are the routes
listed under [When the room id is replaced](#when-the-room-id-is-replaced); a new way of losing
access to a channel has to call it too. Deleting a server ends its apps the same way, with no
epoch left to bump. The commons (`demo`) is refused inside `rotate` itself.

Because a rotation has to mean something, **who may be handed a room key is asked of the database
each time**, not inferred from being in the voice room (a socket stays in a room after its user is
kicked): an app start, and the `join` event, both check that the person is a member of the server
and may open that channel, and that the channel exists (`mayUseAppRoom`; in the commons any room
name will do). A refused join is answered `{ ok: false, reason: 'no-access' }`. A start also notes
the server's rotation counter before it reads anything and gives up if it has moved by the time
the activity would be created, so a start that overlaps a rotation can never leave a room running
on the old key.

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
