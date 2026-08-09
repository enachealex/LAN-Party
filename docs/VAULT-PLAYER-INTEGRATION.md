# LAN Party ↔ Vault Player integration

Everything Vault Player needs to sign a LAN Party user in automatically and mirror their friends.

**LAN Party origin (prod):** `https://lanparty.thejumpvault.com`
**Shared secret:** `VAULT_SSO_SECRET` — 32 random bytes, hex. On the LAN Party host it lives in
`/mnt/retroboard-data/lan-party/vault-sso.key` (mode 600) and in the gitignored
`ecosystem.config.cjs`. Read it with `cat vault-sso.key`; never commit it or put it in a client build.

---

## 1. What already works

Vault Player is **already driven** by the LAN Party activity now labelled **"Vault Player"**
(`ACTIVITY_TYPES.movie`). LAN Party currently calls your Rendezvous service:

| LAN Party does | Your endpoint |
| --- | --- |
| Polls room state every 3s | `GET /room/{code}` |
| Streams a web-playable film into a `<video>` | `GET /stream/{code}` |
| Follows the host's clock | uses `serverNowMs` + `atUnixMs` + `positionMs` from `/room` |
| Falls back to the desktop app | `vaultmovies://join?code=…&server=…` |

Room fields LAN Party reads: `title`, `host`, `service`, `webPlayable`, `webReason`, `positionMs`,
`playing`, `atUnixMs`, `serverNowMs`. Skew is computed as `Date.now() - serverNowMs`, so keep
`serverNowMs` accurate.

**The only missing piece was identity** — that's what follows.

---

## 2. The SSO assertion

### Why not just pass the LAN Party token
The LAN Party session JWT grants full control of the account (post as the user, change their profile,
delete it). It never leaves the browser. Instead LAN Party mints a **separate, short-lived assertion**
that only states who the user is, signed with `VAULT_SSO_SECRET` — **not** LAN Party's `JWT_SECRET`.
A leak of one secret therefore cannot forge sessions on the other side.

### How Vault Player receives it
Appended to the existing deep link when the user clicks *Open in Vault Player*:

```
vaultmovies://join?code=ABC123&server=party.thejumpvault.com&sso=<JWT>
```

It's minted **at click time** because it expires in 60 seconds. If SSO is unconfigured the link simply
arrives without `sso=` — treat that as "anonymous guest", don't fail the join.

### Token format
`HS256` JWT signed with `VAULT_SSO_SECRET`:

```json
{
  "iss": "lanparty",
  "aud": "vault-player",
  "sub": "alexander",
  "name": "alexander",
  "email": "user@example.com",
  "iat": 1786240000,
  "exp": 1786240060,
  "jti": "6f1c…"
}
```

| Claim | Meaning |
| --- | --- |
| `sub` | **The identity key. Store this.** The LAN Party username — stable, unique, lowercase-ish. |
| `name` | Display name (currently the same as `sub`). |
| `email` | The user's own address. May be absent. |
| `exp` | 60 seconds after `iat`. |
| `jti` | Unique per mint — cache consumed values to block replay. |

### What your `/auth/sso` must do
1. Verify the HMAC with `VAULT_SSO_SECRET`, **pinning `alg` to HS256** (never trust the header's alg).
2. Require `iss === "lanparty"` and `aud === "vault-player"` — reject anything else.
3. Reject if `exp` has passed (allow ≤30s clock skew at most).
4. Reject a `jti` you've already consumed (an in-memory cache with a 5-minute TTL is enough).
5. Look up your user by `sub`; create them on first sight (`AccountService`). **Key on `sub`, not
   `name` or `email`** — a display name can change, `sub` is the stable link.
6. Issue your own Vault session. Never store or echo the assertion.

> ⚠️ Because `sub` is the join key, do not also allow a Vault-local account to claim an arbitrary
> `sub`, or someone could pre-register a LAN Party username and inherit that identity.

---

## 3. User + friends structure

Call this **server-to-server** with the assertion as a bearer token, within its 60s window:

```
GET https://lanparty.thejumpvault.com/integrations/vault/userinfo
Authorization: Bearer <the same JWT>
```

### Response

```json
{
  "issuer": "lanparty",
  "user": {
    "username": "alexander",
    "displayName": "alexander",
    "avatarUrl": "/uploads/1786-abc.png",
    "avatarColor": "#4b7bec",
    "status": "available",
    "email": "user@example.com"
  },
  "friends": [
    {
      "username": "romo",
      "displayName": "romo",
      "avatarUrl": null,
      "avatarColor": "#a55eea",
      "status": "offline"
    }
  ]
}
```

### Field reference

| Field | Type | Notes |
| --- | --- | --- |
| `user.username` | string | Same value as the token's `sub` — your identity key. |
| `user.displayName` | string | What to show in the UI. |
| `user.avatarUrl` | string \| null | **Relative path.** Resolve against the LAN Party origin: `https://lanparty.thejumpvault.com` + value. `null` when they've never uploaded one. |
| `user.avatarColor` | string | `#rrggbb`. Use as the tile colour behind their initial when `avatarUrl` is null. |
| `user.status` | enum | `available` \| `idle` \| `dnd` \| `offline`. Point-in-time; LAN Party does not push updates to you. |
| `user.email` | string \| null | **Only ever the asserted user's own address.** |
| `friends[]` | array | Same shape **minus `email`** — a friend's address is never exposed. Sorted by username. Empty array if they have none. |

Friendship in LAN Party is **symmetric and mutual** — it only exists after an explicit request +
accept, so every entry is a confirmed two-way friend. There are no "pending" or "blocked" entries in
this payload.

### Errors

| Status | Meaning |
| --- | --- |
| `401` | Missing / malformed / forged / expired assertion, or wrong `aud`/`iss`. |
| `404` | The asserted user no longer exists (deleted account). |
| `503` | SSO isn't configured on the LAN Party server. |

---

## 4. Suggested flow

```
User clicks "Open in Vault Player" in LAN Party
   → LAN Party mints the assertion (60s) and opens vaultmovies://join?...&sso=<JWT>
      → Vault Player validates it (§2), finds/creates the user by `sub`
         → Vault Player GETs /integrations/vault/userinfo with the same JWT
            → stores displayName + avatar, and mirrors `friends[]` into FriendsService
               → joins room `code` on `server` as that identity
```

Friends are a **snapshot**, so refresh on each SSO login rather than assuming it stays current.

---

## 5. Testing before wiring the desktop app

Anything holding a LAN Party login can exercise it end to end:

```bash
# 1. Log in as a LAN Party user
TOKEN=$(curl -s -X POST https://lanparty.thejumpvault.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<you>","password":"<password>"}' | jq -r .token)

# 2. Mint an assertion (this is what rides the deep link)
SSO=$(curl -s -X POST https://lanparty.thejumpvault.com/integrations/vault/sso-token \
  -H "Authorization: Bearer $TOKEN" | jq -r .token)

# 3. Fetch the user + friends payload
curl -s https://lanparty.thejumpvault.com/integrations/vault/userinfo \
  -H "Authorization: Bearer $SSO" | jq
```

Expect `401` if you wait more than 60s between steps 2 and 3 — that's the expiry working.

---

## 6. Open items

- **Presence is a snapshot.** If Vault Player wants live status, we'd add a webhook or let it poll
  `userinfo`; there's no push today.
- **Reverse direction.** Nothing flows Vault → LAN Party yet (e.g. "now playing" back into the
  activity). The activity already shows `title`/`host` from `/room`, which covers most of it.
- **`name` currently equals `sub`.** If Vault Player wants a separate display name, LAN Party would
  need a distinct profile display-name field first.
