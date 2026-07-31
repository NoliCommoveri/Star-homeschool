# Parent Sync — Specification

Status: **Phase 1 complete.** The §6 schema and §6.4 API (`schema.sql`,
`functions/api/*`) are built per §12 Steps 4 and 7, `parent.html` (§9, §11
step 3) is built and tested end-to-end against a local D1 instance (family
creation, pairing-code mint/redeem, sync, the dashboard grid/cards/
trouble-items/session-detail, and device revocation), and the §8 sync module
— identical code per §3 rule 5 — is now wired into both `spelling-star-v6_3.html`
and `math-star-v6_1.html` (§11 Phase 1 steps 4-5): `data.sync` with tolerant
migration, "Sync to my phone" pairing UI (plus the §5 endpoint-override field)
behind the existing PIN gate, push after every session-completing `persist()`
and once on boot/profile-switch, and `/api/delete` on session delete. `sw.js`'s
`CACHE_VERSION` is bumped (§11 step 6). Verified with a Playwright smoke pass
against static files: setup wizard through to a completed session with sync
off (byte-for-byte unaffected), and the Settings sync card rendering and
failing a pairing attempt gracefully with no uncaught errors. Not yet verified
against a live `wrangler dev`/D1 instance in this pass — the sandboxed network
here couldn't complete workerd's local `Request.cf` handshake, so treat the
next real deploy as the first live check of the full pairing→push→dashboard
loop. This document is the design for adding an optional backend so a parent
can see their children's results from their own phone. Scope is **Spelling
Star and Math Star only**.

Revised after review: the §6 schema had a dangling `sessions.device_id` with
nothing to join against, and the authorization boundary was never stated
(§6.5) — both are fixed here, along with backing storage for pairing codes and
rate limiting. **Do not follow §12 Step 4 from an older copy of this file.**

Revised again after a second review: the six-endpoint API had no way to
actually *mint* a pairing code past the first device, no way to list or revoke
a family's devices despite §7 promising both, and `childId` was used
throughout §6 without ever saying where it comes from (unlike `deviceId`,
which got its own subsection). All three are fixed here — see §6.2 (child
identity) and the three new rows in §6.4's endpoint table.

Target files (when built): a new `parent.html`, a new `functions/` directory,
and additive changes inside `spelling-star-v6_3.html` and `math-star-v6_1.html`.
No existing behavior changes when sync is off.

Revised again after the live deploy: **Cloudflare Pages no longer exists as a
separate product** — connecting a repo now always creates a Worker (static
assets + optional server code), and that Worker does not understand Pages
Functions' file-based routing from `functions/api/*`, and its dashboard
binding editor is locked for git-connected projects. §12 Steps 2 and 5-7 are
rewritten for what actually works today: a committed `wrangler.toml`, a
committed `.assetsignore`, and a pre-bundled Worker script built from
`functions/`. **Do not follow an older copy of §12.**

---

## 1. Goals

- A parent opens a page on their own phone and sees, without touching a child's
  device: recent scores, trend over time, and — the highest-value one —
  **what each child keeps getting wrong**.
- Free. Not "free tier that becomes $19/month," actually free at this data
  volume, indefinitely.
- Works for several children and several devices.
- The apps keep working exactly as they do today with no network, no account,
  and no sync configured. Sync is strictly additive.
- Sharing the apps with other families stays as frictionless as it is now.

### Non-goals

- **Geography Star and Logic Star.** Out of scope, and not merely deferred —
  see §2.1, where the reason is a design difference rather than a matter of
  effort.
- Accounts, passwords, or email for children. Children never sign in.
- Real-time / live-watching. Minutes-fresh is fine.
- Replacing `localStorage` as the source of truth. The cloud is a mirror.
- Parent-to-child direction (assigning lists remotely). Deferred to Phase 3.
- Operating a hosted service for other families. Possible later on this same
  code, but a deliberate separate decision — see §5.

---

## 2. What exists today

Both in-scope apps share the same storage design:

- One `localStorage` key per child — `spellingstar-<slug>`, `mathstar-<slug>` —
  holding a single JSON blob (`data`).
- `data.sessions[]` is the history, appended to and never mutated.
- History capped in `load()` (300 sessions); CSV export is the long-term record.
- Parent area is PIN-gated, on the child's device, with `exportCSV()`.
- `load()` tolerantly defaults new fields, so old profiles keep opening.
- Static hosting (GitHub Pages), no build step, no CI, PWA via `sw.js`.

Session records:

| | Spelling Star | Math Star |
|---|---|---|
| `id` | `Date.now()` | `Date.now()` |
| `date` | ISO string | ISO string |
| `mode` | `practice \| test \| pretest \| repeat \| spotit` | `practice \| drill` |
| scope field | `listName` | `categories`, `focusName` |
| totals | `score`, `total`, `bonusEarned` | `score`, `total`, `elapsedMs` |
| `results[]` | `{ word, correct, attempts, type }` | `{ key, category, prompt, answer, type, subgroup?, correct, attempts, fromReview? }` |

The overlap is what makes this cheap: **same id scheme, same date format, same
`score`/`total`, and both carry per-item `results[]` with `correct` and
`attempts`.** Everything the parent dashboard needs is already recorded; nothing
in either app has to change to *produce* it.

### 2.1 Why Geography and Logic are excluded

Not laziness — they're built differently. Both use `sessionLog[]` rather than
`sessions[]`, with entries that hold only totals (`{date, mode, region,
correct, total}` and `{date, mode, level, solved, score, total, hints,
seconds}`). **There is no per-item detail**, so the "what do they keep getting
wrong" feature — the whole point of the dashboard — cannot be built from their
history at all.

Their real signal lives in cumulative state instead: Geography's `mastery{}` /
`graduated{}` / `reviewFacts{}`, Logic's `stats{}`. Syncing that is a different
mechanism — last-write-wins on a single row per child+app, not append-only
events — which would mean two sync kinds, two sets of conflict semantics, and a
second code path through the server.

Excluding them keeps this design to **one sync kind: append-only events.** If
they're ever wanted, the honest path is to first change those two apps to record
per-item results, then reuse this pipeline unchanged.

---

## 3. Architecture principle

Local-first, one-way, best-effort.

```
child device (localStorage = truth)
      │  append-only push, fire-and-forget
      ▼
   tiny API  ──►  small database
      │
      ▼  read-only
parent phone (parent.html)
```

Rules the build must not violate:

1. A sync failure is never visible to the child and never blocks a session.
   Sessions save to `localStorage` first; the push happens after `persist()`.
2. If sync is off or unreachable, both apps behave byte-for-byte as today.
3. The server is dumb storage. All logic — grading, trends, trouble-item
   ranking — stays in the client, as it is now.
4. No third-party `<script src>` in the app files. The self-contained-HTML
   constraint holds; sync is `fetch()` calls only.
5. The sync module is **identical code in both app files**. Same function names,
   same field names, differing only in the `app` string. With no build step,
   copy-paste is the sharing mechanism, and two identical copies stay
   maintainable in a way that two variants would not.

---

## 4. Backend choice

Free tiers move, so verify at signup. The volume that matters: two children at
3 sessions a day is ~2,200 writes a year and a few MB. Every candidate is
orders of magnitude above that, so **capacity is not the differentiator —
operational friction is.**

| Option | Free? | Friction | Verdict |
|---|---|---|---|
| **Cloudflare Workers (static assets) + D1** | Yes, no card. ~100k req/day; D1 ~5 GB. | Deploys on `git push`. ~150 lines of your own code in the repo. Same origin as the apps → no CORS. | **Chosen** |
| Firebase Firestore (Spark) | Yes, no card. | No server code, but a console to configure, security rules to get right, fiddly token refresh. Usable via REST, so no SDK script tag. | Fallback |
| Supabase | Free, but **projects pause after ~7 days idle**. | A homeschool app goes quiet over breaks; a paused project is a dead dashboard. | Rejected |
| GitHub repo as store | — | Needs a write token in client code, in a public repo, holding kids' data. | Never |
| Apps Script → Sheet | Yes. | Least work, and a spreadsheet the parent already knows. But the deploy URL is a bare secret anyone can POST to, and you get a sheet, not a dashboard. | Escape hatch |

**Chosen: Cloudflare Workers, static assets + D1**, moving hosting for the
whole repo from GitHub Pages to Cloudflare. (This was originally written for
Cloudflare Pages; Pages has since been folded entirely into Workers — see the
§12 revision note.)

- Same origin means the apps call `/api/...` — no CORS, no second domain, no
  cross-origin cookie questions.
- Deployment stays "push to `main`". There *is* a build step, just not one
  Cloudflare runs for you: `functions/api/*` gets bundled locally with
  `wrangler pages functions build` into a committed `dist/worker/index.js`
  (§12 Step 7), because a Worker doesn't understand Pages-style file-based
  routing on its own. Local `wrangler` is needed for that bundling step and
  for the one-time D1 setup — not for day-to-day deploys, which are still
  just `git push`.
- The API is yours, ~150 lines, in the repo, reviewable and diffable — which
  suits a codebase whose ethos is "one file you can read."
- No inactivity pause, no cold-start a parent would notice.

Cost, stated plainly: hosting moves off GitHub Pages, so the URL changes and any
bookmark or installed PWA needs re-pointing once. That one-time annoyance is the
only real downside, and it is the first step of Phase 1.

If avoiding the move is preferred, the same functions can live on a
`*.workers.dev` subdomain with CORS headers and GitHub Pages stays. Everything
below is unchanged apart from the endpoint and an `OPTIONS` handler.

---

## 5. Hosting, endpoints, and who can create a family

The apps must stay as shareable as they are now. Three audiences, and the design
has to serve all three without any of them getting in the others' way.

**Default endpoint is same-origin `/api`.** Not a blank field to fill in. For
your deployment — and for any family who forks the repo and deploys their own —
apps and backend land on one origin, so there is nothing to configure and no
CORS. Setup on a child device is a 6-character pairing code and nothing else; no
URL typing on a tablet keyboard.

**The control point is family creation, not the endpoint.** If your Worker
deployment serves the apps and `/api` is live at the same origin, a "blank by
default" endpoint field protects nothing — any visitor's copy of the code can
find the backend trivially, and you would be running multi-tenant hosting by
accident. So: family creation lives on its own endpoint, `/api/family`, which
requires a **signup secret held as a worker environment variable** (§6.4). Your instance is publicly reachable but serves exactly
one family, and no amount of poking changes that. Hosting for other families
later means deliberately changing that setting, having first decided on
encryption (§10) and a privacy policy — never something you back into.

Consequences per audience:

- **A family who just uses your hosted apps.** Nothing changes. Four apps,
  offline, no accounts, no setup. The sync section renders as "not set up"
  behind the PIN gate, and no code they can enter attaches them to your backend.
- **You.** Parent area → "Sync to my phone" → type the 6-character code from
  your phone. Once per child device.
- **A family who wants their own.** Fork the repo, connect their own Cloudflare
  account, run one D1 migration, set their own signup secret. Apps and backend
  on their origin; their data never touches your account; they never see the
  endpoint field either. This is the path to document in the README.

**The endpoint override field** covers only the leftover case — someone using
your hosted apps with their own backend. Behind the PIN gate, plainly labeled;
their functions need CORS headers since it is now cross-origin. Worth the ~15
lines, but it is the exception, not the mechanism.

Security note: a field where a user pastes a URL is a mild phishing surface.
Low risk for this audience, mitigated by keeping it PIN-gated and stating in
plain words what it does.

---

## 6. Data model (server)

D1 / SQLite. Deliberately boring.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE families (
  id          TEXT PRIMARY KEY,      -- 128-bit random hex; never derived (§6.5)
  created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,      -- client-generated UUID; stable across re-pairing
  family_id   TEXT NOT NULL REFERENCES families(id),
  token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256; raw token never stored. Rotates; id does not.
  role        TEXT NOT NULL,         -- 'child' | 'parent'
  label       TEXT,                  -- "Ada's tablet"
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  rl_window   INTEGER NOT NULL DEFAULT 0,  -- rate-limit window start, epoch (§6.6)
  rl_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_devices_token ON devices(token_hash);

CREATE TABLE children (
  id          TEXT PRIMARY KEY,      -- 128-bit random hex; NOT derived from family_id
  family_id   TEXT NOT NULL REFERENCES families(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_children_family ON children(family_id);

CREATE TABLE pairing_codes (
  code_hash   TEXT PRIMARY KEY,      -- SHA-256 of the 6-char code
  family_id   TEXT NOT NULL REFERENCES families(id),
  role        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                -- non-null once redeemed; single use
);

CREATE TABLE sessions (
  child_id    TEXT NOT NULL REFERENCES children(id),
  app         TEXT NOT NULL,         -- 'spelling' | 'math'
  device_id   TEXT NOT NULL REFERENCES devices(id),
  session_id  TEXT NOT NULL,         -- the client's Date.now() id, as text
  occurred_at INTEGER NOT NULL,      -- from the client
  received_at INTEGER NOT NULL,      -- from the server; clock-skew insurance
  mode        TEXT NOT NULL,
  score       INTEGER,
  total       INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL,         -- JSON (or ciphertext — see §10)
  PRIMARY KEY (child_id, app, device_id, session_id)
);
CREATE INDEX idx_sessions_child_app ON sessions(child_id, app, occurred_at);
```

`device_id` is in the session primary key because two devices can both mint
`Date.now()` ids that collide. The composite key makes every push an idempotent
upsert, which is what lets the client be careless about retries.

`deleted` is a tombstone, not a row removal, so a delete on the child's device
propagates without an old push resurrecting it.

### 6.1 Device identity is not token identity

`devices.id` is its own column, generated **client-side** with
`crypto.randomUUID()` on first sync setup and stored in `data.sync.deviceId`.
`token_hash` is a separate unique column, not the primary key.

These must not be collapsed into one. If `device_id` were the token hash:

- Revoking or rotating a token would orphan every historical session row
  written by that device.
- A device that re-paired would come back with a different `device_id`, so its
  whole local history would re-push under a new composite key and **duplicate
  in the cloud** — `ackedIds` lives in `localStorage` and survives re-pairing,
  but a "Resync now" would then write a second copy of everything.

A client-generated UUID survives both. The device sends it **once, at pairing**;
the server stores it on the `devices` row and thereafter derives it from the
token. It is never accepted as a per-request parameter, so one device cannot
claim another's identity.

### 6.2 Child identity

`childId` needs the same treatment as `deviceId` (§6.1) got, and an earlier
draft of this spec skipped it — `childId` showed up in the `/api/sync` body
and the `sessions` primary key with no statement of where it comes from.

It is minted the same way: **client-side**, with `crypto.randomUUID()`, the
first time sync is turned on for that profile, and stored in `data.sync.childId`
alongside `deviceId`. It is not derived from the child's name or from
`family_id` — same reasoning as §6.5's non-guessable-ids note.

**One child, not one child per app.** "That profile" spans both apps, and this
is the part an earlier draft got wrong: Spelling Star and Math Star keep
separate profile blobs, so each minted its own `childId` and the same child
arrived as two `children` rows — two rows in the parent grid (§9), one per app.
The apps share an origin, so the id is kept in its own `localStorage` entry,
`starhomeschool-childid-<slug>`, where `<slug>` is the profile-name slug both
apps already compute the same way. Whichever app pairs first mints it; the
other adopts it. It stays outside `data.sync` because it outlives any one
app's profile blob.

An app that already paired under its own id reconciles on its next push:
adopting the shared id clears `ackedIds`, which re-pushes local history under
it (safe — §6.4's upsert is idempotent). The rows written under the old id stay
put; the dashboard folds them in by name (§9) rather than the server rewriting
history. `/api/delete` therefore tombstones by `device_id` rather than
`child_id`, so a delete still reaches copies written before the adoption.

This unifies the common case — one tablet, both apps. A child using Spelling on
one device and Math on another still mints two ids, the same documented
limitation shape as §8's "same child on two devices," and lands on the same
dashboard-side merge.

There is no separate "create a child" call. The `children` row is created
lazily, inside `/api/sync`'s handler: on each push, upsert `children` by
`(id)` within the token's `family_id`, setting `name = childName` from the
request. `INSERT ... ON CONFLICT(id) DO UPDATE SET name = excluded.name` keeps
this idempotent and also lets a child's display name be edited later by simply
sending a new `childName` on the next push — no separate rename endpoint
needed.

Because the upsert is scoped to the token's `family_id` (§6.5 step 4 applies
here too), a child device cannot create or touch a `children` row outside its
own family even if it sent a guessed `childId`.

### 6.3 Envelope and payload

Spelling and Math sessions overlap but are not identical, so the row stores a
**common envelope in columns** and the **app-specific remainder as `payload`**:

- Envelope (columns, both apps): `session_id`, `occurred_at`, `mode`, `score`,
  `total`.
- Payload (JSON): everything else — `listName` + `bonusEarned` + `results[]`
  for Spelling; `categories` + `focusName` + `elapsedMs` + `results[]` for Math.

This is what makes the cross-app view cheap: "both kids × both apps × last 7
days" is a single indexed query over columns, with no JSON parsing. Detail
views parse `payload` only for the one session being opened.

Size note: Math payloads are meaningfully larger than Spelling's, since each
result carries a full problem descriptor (`prompt`, `answer`, sometimes
`fields`/`options`). Estimate 3-6 KB per drill session against a ~5 GB
allowance — a non-issue, but the reason `payload` is not stored twice or
indexed.

### 6.4 API

Nine endpoints, all JSON. All except `/api/family` are authenticated by
`Authorization: Bearer <device-token>`.

| Endpoint | Auth | Body / query | Role |
|---|---|---|---|
| `POST /api/family` | signup secret | `{ signupSecret, deviceId, label }` | — |
| `POST /api/pairing-code` | token | `{ role, label }` | parent |
| `POST /api/pair` | pairing code | `{ code, deviceId, role, label }` | — |
| `POST /api/sync` | token | `{ app, childId, childName, sessions: [...] }` | child |
| `POST /api/delete` | token | `{ app, childId, sessionIds: [...] }` | child |
| `GET /api/children` | token | — | parent |
| `GET /api/sessions` | token | `?childId=&app=&since=` | parent |
| `GET /api/devices` | token | — | parent |
| `POST /api/devices/revoke` | token | `{ deviceId }` | parent |

**Family creation and pairing are separate endpoints**, not one endpoint with
two request shapes. They authenticate against different things — a long-lived
server secret versus a short-lived one-time code — and conflating them means a
single handler where forgetting one branch of an `if` silently downgrades the
§5 gate. `/api/family` creates the family, mints the first parent device, and
is the *only* endpoint that ever reads `env.SIGNUP_SECRET`.

`deviceId` is accepted by those two endpoints only (§6.1) and is ignored
everywhere else.

`/api/sync` returns the ids it accepted, so the client can mark them acked.

**`/api/pairing-code`** is what §7's "Adding a device" flow actually calls —
an earlier draft of this spec described the parent page "showing a 6-character
code" without any endpoint that produces one. It requires a `parent`-role
token (so a child device's token, which can only append sessions, cannot mint
codes for new devices), writes one row to `pairing_codes` with `family_id`
taken from the token, and returns the plaintext code once — the server never
stores anything but its hash. `role` in the body is the role the *resulting*
device will get once the code is redeemed (`child` for a tablet, `parent` for
a second phone); it is copied into `pairing_codes.role` and enforced again at
redemption in `/api/pair`.

**`/api/devices`** and **`/api/devices/revoke`** back the "revoking one token
… and nothing else" claim in §7 and the "last heard from per device" mitigation
in §13 — both required an endpoint that didn't previously exist. `/api/devices`
returns each device's `id`, `role`, `label`, `created_at`, `last_seen`, and
`revoked`, scoped to the token's family (§6.5). `/api/devices/revoke` sets
`revoked = 1` on the named device, again only within the caller's own family —
a `deviceId` from another family 404s, same as `childId` does elsewhere
(§6.5 step 4). Revoking is a one-way flip in Phase 1; un-revoking means
re-pairing, which is deliberate — a revoked token should not become live again
by accident.

### 6.5 Authorization boundary

The single invariant, stated because it is the one that matters most and is
easiest to leave implicit:

> **Every handler resolves `family_id` from the bearer token, and every query
> is filtered by that `family_id`. A client-supplied `childId` is a selector,
> never an authorization.**

Concretely, on every authenticated request:

1. Hash the bearer token, look up `devices` by `token_hash`, reject if missing
   or `revoked = 1`.
2. Take `family_id` and `role` from **that row** — never from the request body.
3. Check `role` against the endpoint (children write, parents read/manage; §6.4).
4. Any query naming a `childId` joins `children` and requires
   `children.family_id = <token's family_id>`. A `childId` from another family
   returns 404, not 403 — a 403 would confirm the id exists.

Ids are also non-guessable — `families.id` and `children.id` are 128-bit random
hex, and `children.id` is **no longer `family_id + slug`** as an earlier draft
had it. That derivation was doubly bad: it made child ids structurally
predictable from one leaked family id, and it leaked the family id to anyone
holding a child id.

But non-guessable ids are defense in depth, not the control. Step 4 is the
control. A design that relies on ids being hard to guess is one lucky enumeration
away from cross-family reads; a design that filters by the token's family is
unaffected either way.

### 6.6 Rate limiting

A fixed window on the `devices` row: `rl_window` (window start) and `rl_count`.
Every authenticated request already updates `last_seen`, so the counter rides
along in that same `UPDATE` — no extra write, no extra service. If
`now - rl_window > 3600` reset the window to now and the count to 1; otherwise
increment and reject over a ceiling (a few hundred an hour is far above any
honest use).

The point is narrow: stop a retry-loop bug on one tablet from burning the daily
request budget for everyone. It is not an anti-abuse system.

Not Workers KV — it is eventually consistent, so concurrent increments lose
writes and the counter silently undercounts. Not Durable Objects — correct, but
a whole additional primitive for a job one integer column does.

---

## 7. Pairing and auth

No child accounts, no child passwords. Device tokens only.

**First run (parent phone):** open `parent.html` → "Create family" → enter the
signup secret → `POST /api/family` mints a random family id and returns a parent
device token, stored in that phone's `localStorage`. The page generates its own
`deviceId` first (§6.1) and sends it along.

**Adding a device:** parent page calls `POST /api/pairing-code` (§6.4) with its
own parent token and shows the returned **6-character code**, valid ~10
minutes, single use. The server stores only its SHA-256 in `pairing_codes` with
`expires_at`; redemption sets `used_at` in the same transaction that mints the
token, so a code cannot be redeemed twice even under concurrent requests.

**On each child device:** in the existing PIN-gated parent area, "Sync to my
phone" → type the code → the app generates a `deviceId` with
`crypto.randomUUID()`, calls `POST /api/pair`, and stores the returned token in
the profile blob. The `deviceId` is sent exactly here and never again.

Redeeming a code is **not** idempotent the way `/api/sync` is (§6.4): if
the network drops the response after the server already consumed the code, the
client has no way to know whether pairing succeeded, and the code — single-use
— can't be retried. The UI should treat a network error on `/api/pair` as
"unknown, generate a new code" rather than auto-retrying with the same one.

Expired and used codes should be swept periodically — simplest is a
`DELETE FROM pairing_codes WHERE expires_at < ?` at the top of `/api/family`,
which runs rarely and costs nothing.

Optionally, the parent page can instead show a link carrying the code in the URL
**fragment** (`#pair=abc123`), messaged or AirDropped to the tablet — fragments
are not sent to servers, so the code never lands in a log or `Referer` header.
Build the typed code first; six characters is not a burden.

Why this shape: a child device's token can only *append* to its own family — it
cannot read other children's data. A lost tablet means revoking one token —
`GET /api/devices` to find it by `label`, `POST /api/devices/revoke` (§6.4) —
from the parent page, and nothing else. Tokens are stored hashed, so a database
dump yields no working credentials.

Profile-blob addition, added tolerantly in `load()` in the same style as every
other migration in both apps:

```js
data.sync = { enabled, endpoint, childId, deviceId, deviceToken, ackedIds: [], lastPushAt }
```

`deviceId` is minted once and must survive re-pairing — if a device is re-paired
and mints a fresh one, its whole local history re-pushes under a new composite
key and duplicates in the cloud (§6.1). Re-pairing replaces `deviceToken` only.

`deviceToken` living in `localStorage` is the accepted tradeoff: this is a
child's tablet in a house, and the token's only power is "append scores to this
family."

---

## 8. Client sync mechanics

Identical in both apps (§3 rule 5).

**When to push.** After `persist()` at each site that appends to
`data.sessions` — four in Spelling Star, one in Math Star — plus once on boot.
Fire-and-forget: no `await` in the render path, no spinner, no error a child
could see.

**What to push.** Any session whose id is not in `data.sync.ackedIds`. On
success, add the returned ids, `persist()`, done. Failures do nothing — the next
session or the next boot retries, and idempotent upserts make double-sending
harmless. `ackedIds` is pruned alongside the existing 300-session cap so it
cannot grow unbounded.

**Deletes.** `deleteSession()` in the parent area calls `/api/delete`
best-effort. If it fails the session reappears in the parent view; a "Resync
now" button pushes the full current id set to reconcile.

**The 300-session cap.** Once sync is on, the cloud holds more history than the
device. That is a feature: it is also a backup. Worth stating in the UI, because
Safari evicts non-persisted `localStorage` after ~7 days of non-use —
`navigator.storage.persist()` is already called at boot in both apps, but it is
a request, not a guarantee. **Sync is the first real protection this data has
against a wiped tablet**, and for some users that will matter more than the
dashboard.

**Same child on two devices.** Both push under the same `childId` with different
`device_id`s. The cloud holds the union; local histories stay divergent; the
parent view is the merged truth. A documented limitation, not a Phase 1 bug.

---

## 9. Parent dashboard (`parent.html`)

New self-contained page, same visual language as `index.html`, network-first in
`sw.js` so it is never served stale (bump `CACHE_VERSION`).

Not a report card. A parent glances at this between other things, so it answers
"how's it going, and what should we work on?" in one screen.

**Top: the grid.** Both children × both apps × last 7 days — sessions done and
last-active. Answers "has anyone touched Math since Tuesday?" at a glance, and
comes straight from the envelope columns with no JSON parsing.

One row per child, so `/api/children` rows sharing a name are merged into a
single dashboard child holding every id it synced under (§6.2) — within one
family a name is the child. Sessions are fetched per id and deduped on
`(deviceId, id)`, since a re-push under an adopted id leaves the same session
under both.

**Per child, per app, one card:**

- Last 7 days: sessions, average score, sparkline.
- Recent sessions: date, scope (list name / focus area), score — honoring the
  profile's `percent | points` preference in Spelling.
- **Trouble items**, the centerpiece:
  - *Spelling* — words ranked by miss count, weighted toward recent misses,
    excluding words already graduated out of `reviewWords`. Top ~10 with counts.
  - *Math* — same ranking grouped by `category` / `subgroup`. Better than
    Spelling's, since these are a real taxonomy rather than free strings, so it
    reads as "long division and equivalent fractions" instead of a word list.

  This is the one thing the current CSV export makes a parent do by hand in a
  spreadsheet, and it is the reason to build any of this.
- Streak / last active.

**Detail view:** one session, item by item, right and wrong, attempts.

**Devices:** one small screen, off the main view. "Add a device" calls
`POST /api/pairing-code` and shows the resulting 6-character code (§7). A list
below it, from `GET /api/devices`, shows label, role, last active, and a
Revoke button per row (§6.4) — this is the whole surface for the "lost
tablet" story in §7, and the same `last_seen` data drives the quiet-device
flag in §13.

**Copy discipline:** the apps never show a child a percentage or a grade.
`parent.html` is parent-only behind a device token, so percentages are fine
there — but it must never be linked from the child apps' navigation, only from
the PIN-gated parent area.

---

## 10. Privacy

The data is first names, spelling words, math problems, and right/wrong marks.
Low sensitivity, but it is children's data on someone else's computer:

- HTTPS only; tokens in headers, never in URLs (URLs leak via logs and
  referrers).
- Names: encourage a first name or nickname at setup. No last names, no email,
  no birthdates — none are collected today and none should be added.
- Tokens hashed at rest. Pairing codes short-lived and single-use.
- One-tap "delete everything" on the parent page that actually deletes rows.

**Optional, recommended for Phase 2: client-side encryption.** Derive an AES-GCM
key with PBKDF2 from a family passphrase (WebCrypto, no library) and encrypt
`payload` before it leaves the device. The server then holds opaque blobs plus
envelope columns; the parent page decrypts locally. Roughly 40 lines, and it
means a database compromise, a subpoena, or an operator error yields nothing
readable. Deferred to Phase 2 only because it introduces a "lose the passphrase,
lose the data" failure mode better added once the basic loop is proven.

**The unsolved part is key distribution, and it is the hard part of Phase 2, not
the crypto.** A child device has no account to attach a key to, and the
passphrase must never reach the server — which rules out shipping it through the
pairing code, since that round-trips through `/api/pair`. The likely answer is
that the parent types the passphrase once per child device, at pairing time, as
a second field the server never sees; the key is then derived locally and cached
in the profile blob. That makes pairing a two-secret flow and means a device
that is re-paired after a wipe cannot decrypt — or contribute to — existing
history without the passphrase being typed again. Worth designing properly
before Phase 2 starts rather than during it.

**If hosting for other families is ever enabled (§5), this stops being optional
and becomes a prerequisite.**

---

## 11. Build order

**Phase 0 — no backend (optional, ~1 session).** If something is wanted this
week: a "Share results" button in the PIN-gated parent area that puts a compact
summary on the clipboard or into the OS share sheet. Zero infra, and it proves
out the summary format before any server exists. Skippable.

**Phase 1 — the real thing (~3-4 sessions).**
1. Cloudflare Worker set up (git-connected, static assets + D1), repo
   connected, `main` deploying. Verify all four apps and the PWA still work on
   the new origin **before** touching app code.
2. D1 schema + `functions/api/*` (bundled into a single Worker script, §12
   Step 7) + pairing + signup secret. Test with `curl`.
3. `parent.html`: family creation, pairing, the grid, cards, trouble items.
4. Spelling Star: `data.sync` field with migration, pairing UI in the parent
   area, push on session end and boot, `/api/delete` on session delete.
5. Math Star: paste the identical sync module, change the `app` string, add the
   same pairing UI.
6. `sw.js` cache bump; `parent.html` network-first.

**Phase 2 —** client-side encryption; token revocation UI; endpoint override
field + CORS; fork-and-deploy README for other families.

**Phase 3 — parent → child.** The genuinely new capability: assign a spelling
list or a math focus area from your phone and have it appear on the tablet.
Requires the child device to *poll* on boot and a real answer for remote-vs-local
conflicts. Deliberately last, because it inverts the one-way rule in §3 and
everything gets harder once it does.

---

## 12. Step-by-step: standing up the backend

Written to be followed without prior Cloudflare knowledge. **Cloudflare moves
its dashboard around** — Pages has been folded into Workers entirely, so
"Pages project" in older instructions (including earlier drafts of this file)
now just means "Worker." Each step states *what you are accomplishing* and
gives a CLI equivalent, which changes far less than the menus do. If a menu
name doesn't match, match on the goal.

This does touch the repo, beyond the app files: `wrangler.toml`,
`.assetsignore`, and a `dist/worker/index.js` build output all get committed
in Step 7, because Workers has no dashboard-only way to configure D1 bindings
or serve `functions/api/*` for a git-connected project. None of it changes
behavior for the four apps.

### Step 1 — Cloudflare account

Sign up at dash.cloudflare.com. Free plan, no credit card. You do **not** need
to buy a domain or move your DNS anywhere.

*Checkpoint:* you can see a dashboard with "Workers & Pages" in the sidebar.

### Step 2 — Connect the repo

Workers & Pages → Create → connect to Git → authorize GitHub → pick
`NoliCommoveri/Star-homeschool`, branch `main`. There is no separate "Pages"
option anymore — connecting a repo always creates a Worker.

Unlike the old Pages flow, there's no dashboard field for build output
directory or a D1 binding — a git-connected Worker gets **all** of its config
(what to serve as static assets, what script to run, what it's bound to) from
a `wrangler.toml` committed to the repo, added in Steps 5 and 7 below. Until
that file exists, Cloudflare deploys the repo as static-assets-only (no
server code), which is fine for this step.

*Checkpoint:* your assigned URL — something like
`https://star-homeschool.<your-subdomain>.workers.dev`, found via the
dashboard's **Visit** button — loads `index.html`, and all four apps open and
work. **Test the PWA install and offline mode here too, before going
further** — this is the hosting move, and it is the one step with a
user-visible cost.

### Step 3 — Create the database

Workers & Pages → D1 → **Create database** → name it `star-homeschool`.

CLI equivalent: `npx wrangler d1 create star-homeschool`

*Checkpoint:* the database appears in the D1 list with a database ID.

### Step 4 — Create the schema

Commit the §6 `CREATE TABLE` statements to the repo as `schema.sql`, then run:

```
npx wrangler d1 execute star-homeschool --remote --file=./schema.sql
```

**Don't paste `schema.sql` into the D1 Console tab in the dashboard** — it's a
plausible-looking option but it silently mishandles multi-statement, commented
SQL like this file: pasting the whole thing gives a "request malformed" error,
and stripping the leading comments just moves the failure to "incomplete
input." The CLI command above sends the file to D1's real batch-exec endpoint
and works correctly. If you truly have no CLI access, the Console can work
one statement at a time (no comments, one `CREATE TABLE`/`CREATE INDEX` per
paste) but there's no reason to do it that way.

The `--remote` flag matters. Without it you write to a local dev copy and the
real database stays empty — a genuinely confusing failure, because everything
appears to succeed.

*Checkpoint:* `SELECT name FROM sqlite_master WHERE type='table';` in the D1
console lists `families`, `devices`, `children`, `pairing_codes`, `sessions`
(alongside Cloudflare's own internal `_cf_KV` table — that one's not yours,
ignore it).

Note the `PRAGMA foreign_keys = ON` at the top of the schema: D1 supports
foreign keys but they are **not enforced by default**. This pragma only
applies per-connection, though, and a git-deployed Worker never runs it at
request time — so the §6 schema's reliance on FK enforcement is currently
theoretical, not actually active in production. Real enforcement would need
`PRAGMA foreign_keys = ON` run at the top of the request handler itself, not
just once during schema setup.

### Step 5 — Bind the database to the site

**The dashboard's Bindings tab does not work for this.** If your Worker
deploys via git (it does — Cloudflare's build log will say something like
`npx wrangler deploy`), its dashboard binding editor is locked: any binding
you add there through the UI silently fails to persist, because the real
source of truth is `wrangler.toml` in the repo, and the dashboard won't let
the two drift. (You'll know you're in this state if Settings → Variables and
secrets says "Variables cannot be added to a Worker that only has static
assets," or if the Bindings tab accepts a new D1 binding but shows "No
connected bindings" again right after.)

Instead, commit a `wrangler.toml` to the repo:

```toml
name = "star-homeschool"
main = "./dist/worker/index.js"
compatibility_date = "<today's date>"

[assets]
directory = "./"
binding = "ASSETS"

[[d1_databases]]
binding = "DB"
database_name = "star-homeschool"
database_id = "<your D1 database's ID>"
```

Find the database ID on the D1 database's own Overview page in the dashboard,
or via `npx wrangler d1 list`. `main` points at a build output that doesn't
exist yet — that's Step 7.

*In code this becomes* `env.DB` inside your function handlers.

### Step 6 — Set the signup secret

Worker → Settings → **Variables and secrets** → add `SIGNUP_SECRET`, type
**Secret**, value = a long random string you generate. Unlike the D1 binding,
this one genuinely works from the dashboard — secrets are stored separately
from `wrangler.toml` (correctly: never commit a secret value to git) and
aren't subject to the same config-drift lock. There's no separate
Production/Preview split to worry about here; a git-connected Worker like
this one has just the one environment.

This is the §5 gate that keeps your instance serving exactly one family. Once
saved, the value is **not viewable again** — copy it somewhere safe (a
password manager) the moment you create it.

### Step 7 — Write the functions, and bundle them into the Worker

Create `functions/api/` in the repo, one file per §6.4 endpoint, using Pages
Functions' file-based-routing shape:

```js
// functions/api/sync.js
export async function onRequestPost({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  // ...verify token hash against env.DB, then upsert sessions...
  return Response.json({ accepted: [] });
}
```

Nine files, one per §6.4 endpoint. Roughly 200-260 lines total.

**This file-based routing is a Pages-only convention — a plain Worker (which
is what git-connected deploys produce now) does not understand `functions/`
at all**, and will not serve any of it. It needs compiling into a single
entry script first:

```
npx wrangler pages functions build --outdir=dist/worker
```

This bundles all of `functions/api/*.js` into one `dist/worker/index.js` that
does its own internal routing and falls back to `env.ASSETS.fetch(request)`
for anything it doesn't handle — which is exactly what `wrangler.toml`'s
`main` points at in Step 5. **Commit `dist/worker/index.js`.** There's no
Cloudflare build-command step running this automatically, so it has to be
regenerated and committed by hand after every change under `functions/`,
before you push.

Also commit an `.assetsignore` in the repo root, or the `[assets] directory =
"./"` from Step 5 will upload things that were never meant to be public:

```
.git/
.wrangler/
functions/
dist/
docs/
schema.sql
wrangler.toml
.assetsignore
README.md
node_modules/
package.json
package-lock.json
```

**The `.git/` line is not optional.** Wrangler's default ignore list only
covers `.assetsignore`, `_redirects`, and `_headers` — it does *not* skip
`.git` or `node_modules` on its own. Without `.git/` here, your entire commit
history — every past version of every file — gets uploaded as publicly
downloadable static assets alongside your site.

*Gotcha:* **bindings and secrets only take effect on a deploy made after they
were added.** If you added the D1 binding or `SIGNUP_SECRET` to an existing
deployment, push a new commit (or hit Retry deployment) or `env.DB`/
`env.SIGNUP_SECRET` will still be undefined.

### Step 8 — Deploy and verify

`git push` to `main`. Watch the deployment go green, then check the API is alive
before involving any app:

```
curl -i https://<your-worker>.workers.dev/api/children
# expect 401 — no token. A 404 means routing never reached the Worker
# (check that functions/ was actually rebuilt into dist/worker/index.js —
# see Step 7 — and, if it still 404s, that assets.run_worker_first isn't
# needed for your setup);
# a 500 usually means the D1 binding didn't apply (Step 5 or the Step 7 gotcha).
```

Then create your family, which is the one call that needs the secret:

```
curl -X POST https://<your-worker>.workers.dev/api/family \
  -H 'Content-Type: application/json' \
  -d '{"signupSecret":"<the secret>","deviceId":"'"$(uuidgen)"'","label":"curl test"}'
# expect a device token back
```

(On Windows, use `curl.exe` explicitly — PowerShell's built-in `curl` is an
alias for `Invoke-WebRequest` and doesn't take these flags — and swap in a
fixed UUID for `deviceId`, since `uuidgen` isn't a Windows command.)

Then confirm the §5 gate actually holds — a wrong secret must fail:

```
curl -X POST https://<your-worker>.workers.dev/api/family \
  -H 'Content-Type: application/json' \
  -d '{"signupSecret":"wrong","deviceId":"x","label":"x"}'
# expect 401/403. A 200 here means your instance is open to the world.
```

*Checkpoint:* a `SELECT * FROM families;` in the D1 console shows one row. The
backend is now real, and nothing in the apps has changed.

### Step 9 — Optional: custom domain

Worker → Domains & Routes → **Add**. If you own a domain, this avoids ever
re-pointing devices again should the project name change. Skippable;
`.workers.dev` is perfectly stable.

### Step 10 — Retire the old host

Once the family has been using the Cloudflare URL for a week or two, turn off
GitHub Pages in the repo settings so there is no stale second copy with a
divergent service worker cache. **Not before** — keep the old URL working while
devices are being re-pointed.

### Rollback

Every step is reversible and none of it touches app code. If the hosting move
goes badly at step 2, GitHub Pages is still live and untouched — just keep using
the old URL. Delete the Worker and you are exactly where you started.

---

## 13. Risks and open questions

- **Hosting move.** The one-time URL change and PWA re-install is the biggest
  practical cost. Decide before Phase 1 step 1, because step 1 *is* the move.
  (Alternative: `*.workers.dev` + CORS, keeping GitHub Pages.)
- **Free-tier drift.** Cloudflare could change terms. The API is nine endpoints
  over SQLite; porting is a day, not a rewrite. Keeping the schema plain SQL is
  deliberate for exactly this reason.
- **Clock skew.** A tablet with a wrong date mints wrong `occurred_at` and odd
  session ids. `received_at` is stored as a cross-check; the dashboard should
  prefer it when the two disagree by more than a day.
- **Silent sync failure.** Because failures are invisible by design, sync could
  be dead for weeks unnoticed. Mitigation: the parent page calls `GET
  /api/devices` (§6.4) and flags anything quiet for 7+ days by `last_seen`.
- **Open question:** should `parent.html` ship in this public repo? It holds no
  secrets — tokens are per-device and entered at runtime — so yes, but worth
  re-confirming before it ships.
- **Open question:** whether to ever enable family creation for others (§5).
  Nothing in Phase 1 forecloses it; nothing in Phase 1 requires deciding.

---

## 14. Summary

Yes, and free is realistic rather than a technicality — the data volume is
thousands of times below any free tier's limits.

Cloudflare Workers, static assets + D1, one-way append-only sync from the child
devices, a read-only `parent.html` on the parent's phone, covering Spelling Star
and Math Star. Both apps already record everything the dashboard needs, in
close enough to the same shape that the sync module is identical code in both
files. Trouble words and trouble categories are the headline feature.

Dropping Geography and Logic is what keeps the design to a single append-only
sync path — they would have required a second, state-based one. Keeping the
endpoint same-origin and gating family creation behind a secret is what keeps
the apps as shareable as they are today, while leaving "host it for others" as
a later decision rather than an accident.

The main real cost is moving hosting off GitHub Pages. The main unexpected
benefit is that this doubles as the first actual backup of data that currently
exists only in a browser's `localStorage`.
