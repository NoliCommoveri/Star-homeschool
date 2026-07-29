# Parent Sync — Specification (plan only, nothing built)

Status: **Planning.** No code written. This document is the design for adding
an optional backend so a parent can see their children's results from their own
phone. Scope is **Spelling Star and Math Star only**.

Target files (when built): a new `parent.html`, a new `functions/` directory,
and additive changes inside `spelling-star-v6_3.html` and `math-star-v6_1.html`.
No existing behavior changes when sync is off.

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
| **Cloudflare Pages + Functions + D1** | Yes, no card. ~100k req/day; D1 ~5 GB. | Deploys on `git push`. ~150 lines of your own code in the repo. Same origin as the apps → no CORS. | **Chosen** |
| Firebase Firestore (Spark) | Yes, no card. | No server code, but a console to configure, security rules to get right, fiddly token refresh. Usable via REST, so no SDK script tag. | Fallback |
| Supabase | Free, but **projects pause after ~7 days idle**. | A homeschool app goes quiet over breaks; a paused project is a dead dashboard. | Rejected |
| GitHub repo as store | — | Needs a write token in client code, in a public repo, holding kids' data. | Never |
| Apps Script → Sheet | Yes. | Least work, and a spreadsheet the parent already knows. But the deploy URL is a bare secret anyone can POST to, and you get a sheet, not a dashboard. | Escape hatch |

**Chosen: Cloudflare Pages + Pages Functions + D1**, moving hosting for the
whole repo from GitHub Pages to Cloudflare Pages.

- Same origin means the apps call `/api/...` — no CORS, no second domain, no
  cross-origin cookie questions.
- Deployment stays "push to `main`". Cloudflare builds nothing (there is no
  build step); it serves the repo and runs `functions/`. No local `wrangler`,
  no CI to maintain.
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

**The control point is family creation, not the endpoint.** If your Pages
deployment serves the apps and `/api` is live at the same origin, a "blank by
default" endpoint field protects nothing — any visitor's copy of the code can
find the backend trivially, and you would be running multi-tenant hosting by
accident. So: `/api/pair` requires a **signup secret held as a worker
environment variable**. Your instance is publicly reachable but serves exactly
one family, and no amount of poking changes that. Hosting for other families
later means deliberately changing that setting, having first decided on
encryption (§9) and a privacy policy — never something you back into.

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
CREATE TABLE families (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
  token_hash  TEXT PRIMARY KEY,      -- SHA-256; the raw token is never stored
  family_id   TEXT NOT NULL,
  role        TEXT NOT NULL,         -- 'child' | 'parent'
  label       TEXT,                  -- "Ada's tablet"
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER
);

CREATE TABLE children (
  id          TEXT PRIMARY KEY,      -- family_id + slug, stable across devices
  family_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  child_id    TEXT NOT NULL,
  app         TEXT NOT NULL,         -- 'spelling' | 'math'
  device_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,         -- the client's Date.now() id, as text
  occurred_at INTEGER NOT NULL,      -- from the client
  received_at INTEGER NOT NULL,      -- from the server; clock-skew insurance
  mode        TEXT NOT NULL,
  score       INTEGER,
  total       INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL,         -- JSON (or ciphertext — see §9)
  PRIMARY KEY (child_id, app, device_id, session_id)
);
```

`device_id` is in the primary key because two devices can both mint `Date.now()`
ids that collide. The composite key makes every push an idempotent upsert, which
is what lets the client be careless about retries.

`deleted` is a tombstone, not a row removal, so a delete on the child's device
propagates without an old push resurrecting it.

### 6.1 Envelope and payload

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

### 6.2 API

Five endpoints, all JSON, authenticated by `Authorization: Bearer <device-token>`.

- `POST /api/pair` — exchange a pairing code for a device token. Creating a new
  family additionally requires the signup secret (§5).
- `POST /api/sync` — `{ app, childId, childName, sessions: [...] }`, upserts.
  Returns accepted ids so the client can mark them acked.
- `POST /api/delete` — `{ app, childId, sessionIds: [...] }`, sets tombstones.
- `GET /api/children` — parent read.
- `GET /api/sessions?childId=&app=&since=` — parent read; `since` keeps the
  dashboard from re-downloading everything.

Rate-limit crudely (a per-token counter) so a bug in a retry loop cannot burn
the daily request budget.

---

## 7. Pairing and auth

No child accounts, no child passwords. Device tokens only.

**First run (parent phone):** open `parent.html` → "Create family" → enter the
signup secret → the server mints a family id and returns a parent device token,
stored in that phone's `localStorage`.

**Adding a device:** parent page shows a **6-character code**, valid ~10
minutes, single use.

**On each child device:** in the existing PIN-gated parent area, "Sync to my
phone" → type the code → the device exchanges it for its own token and stores it
in the profile blob.

Optionally, the parent page can instead show a link carrying the code in the URL
**fragment** (`#pair=abc123`), messaged or AirDropped to the tablet — fragments
are not sent to servers, so the code never lands in a log or `Referer` header.
Build the typed code first; six characters is not a burden.

Why this shape: a child device's token can only *append* to its own family — it
cannot read other children's data. A lost tablet means revoking one token from
the parent page and nothing else. Tokens are stored hashed, so a database dump
yields no working credentials.

Profile-blob addition, added tolerantly in `load()` in the same style as every
other migration in both apps:

```js
data.sync = { enabled, endpoint, childId, deviceToken, ackedIds: [], lastPushAt }
```

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

**If hosting for other families is ever enabled (§5), this stops being optional
and becomes a prerequisite.**

---

## 11. Build order

**Phase 0 — no backend (optional, ~1 session).** If something is wanted this
week: a "Share results" button in the PIN-gated parent area that puts a compact
summary on the clipboard or into the OS share sheet. Zero infra, and it proves
out the summary format before any server exists. Skippable.

**Phase 1 — the real thing (~3-4 sessions).**
1. Cloudflare Pages set up, repo connected, `main` deploying. Verify all four
   apps and the PWA still work on the new origin **before** touching app code.
2. D1 schema + `functions/api/*` + pairing + signup secret. Test with `curl`.
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
its dashboard around** (Pages is being folded into Workers), so each step states
*what you are accomplishing* and gives a CLI equivalent, which changes far less
than the menus do. If a menu name doesn't match, match on the goal.

Nothing here touches the app files. At the end of §12 you have a working,
empty backend and the four apps still behaving exactly as today.

### Step 1 — Cloudflare account

Sign up at dash.cloudflare.com. Free plan, no credit card. You do **not** need
to buy a domain or move your DNS anywhere.

*Checkpoint:* you can see a dashboard with "Workers & Pages" in the sidebar.

### Step 2 — Connect the repo

Workers & Pages → Create → Pages → **Connect to Git** → authorize GitHub →
pick `NoliCommoveri/Star-homeschool`.

Build settings — this is the step people get wrong, because the defaults assume
a build step this repo does not have:

| Setting | Value |
|---|---|
| Framework preset | **None** |
| Build command | **leave empty** |
| Build output directory | **`/`** (repo root) |
| Production branch | `main` |

Save and deploy. It takes about a minute.

*Checkpoint:* `https://star-homeschool.pages.dev` (or whatever name it assigned)
loads `index.html`, and all four apps open and work. **Test the PWA install and
offline mode here too, before going further** — this is the hosting move, and
it is the one step with a user-visible cost.

### Step 3 — Create the database

Workers & Pages → D1 → **Create database** → name it `star-homeschool`.

CLI equivalent: `npx wrangler d1 create star-homeschool`

*Checkpoint:* the database appears in the D1 list with a database ID.

### Step 4 — Create the schema

Commit the §6 `CREATE TABLE` statements to the repo as `schema.sql`, then either
paste them into the D1 **Console** tab in the dashboard, or run:

```
npx wrangler d1 execute star-homeschool --remote --file=./schema.sql
```

The `--remote` flag matters. Without it you write to a local dev copy and the
real database stays empty — a genuinely confusing failure, because everything
appears to succeed.

*Checkpoint:* `SELECT name FROM sqlite_master WHERE type='table';` in the D1
console lists `families`, `devices`, `children`, `sessions`.

### Step 5 — Bind the database to the site

The Pages project cannot see D1 until you bind it.

Pages project → Settings → **Functions** → **D1 database bindings** → Add:

| Field | Value |
|---|---|
| Variable name | **`DB`** |
| D1 database | `star-homeschool` |

Add it under **both Production and Preview.** Setting only Production is the
single most common way to get a "`env.DB` is undefined" error that appears to
make no sense.

*In code this becomes* `env.DB` inside your function handlers.

### Step 6 — Set the signup secret

Same Settings area → **Environment variables** → add `SIGNUP_SECRET`, value = a
long random string you generate. Click **Encrypt** so it is write-only
afterwards. Again: Production *and* Preview.

This is the §5 gate that keeps your instance serving exactly one family.

### Step 7 — Write the functions

Create `functions/api/` in the repo. Pages Functions uses **file-based
routing**: `functions/api/sync.js` serves `/api/sync`. The `functions/`
directory is never served as static files, so nothing here is publicly
readable.

```js
// functions/api/sync.js
export async function onRequestPost({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  // ...verify token hash against env.DB, then upsert sessions...
  return Response.json({ accepted: [] });
}
```

Five files, one per §6.2 endpoint. Roughly 150 lines total.

*Gotcha:* **bindings and environment variables only take effect on a deploy made
after they were added.** If you added them to an existing project, push a commit
(or hit Retry deployment) or `env.DB` will still be undefined.

### Step 8 — Deploy and verify

`git push` to `main`. Watch the deployment go green, then check the API is alive
before involving any app:

```
curl -i https://<your-site>.pages.dev/api/children
# expect 401 — no token. A 404 means routing is wrong;
# a 500 usually means the D1 binding didn't apply (step 5 or the step 7 gotcha).
```

Then create your family, which is the one call that needs the secret:

```
curl -X POST https://<your-site>.pages.dev/api/pair \
  -H 'Content-Type: application/json' \
  -d '{"signupSecret":"<the secret>","role":"parent"}'
# expect a device token back
```

*Checkpoint:* a `SELECT * FROM families;` in the D1 console shows one row. The
backend is now real, and nothing in the apps has changed.

### Step 9 — Optional: custom domain

Pages project → Custom domains. If you own a domain, this avoids ever
re-pointing devices again should the project name change. Skippable; `.pages.dev`
is perfectly stable.

### Step 10 — Retire the old host

Once the family has been using the Cloudflare URL for a week or two, turn off
GitHub Pages in the repo settings so there is no stale second copy with a
divergent service worker cache. **Not before** — keep the old URL working while
devices are being re-pointed.

### Rollback

Every step is reversible and none of it touches app code. If the hosting move
goes badly at step 2, GitHub Pages is still live and untouched — just keep using
the old URL. Delete the Pages project and you are exactly where you started.

---

## 13. Risks and open questions

- **Hosting move.** The one-time URL change and PWA re-install is the biggest
  practical cost. Decide before Phase 1 step 1, because step 1 *is* the move.
  (Alternative: `*.workers.dev` + CORS, keeping GitHub Pages.)
- **Free-tier drift.** Cloudflare could change terms. The API is five endpoints
  over SQLite; porting is a day, not a rewrite. Keeping the schema plain SQL is
  deliberate for exactly this reason.
- **Clock skew.** A tablet with a wrong date mints wrong `occurred_at` and odd
  session ids. `received_at` is stored as a cross-check; the dashboard should
  prefer it when the two disagree by more than a day.
- **Silent sync failure.** Because failures are invisible by design, sync could
  be dead for weeks unnoticed. Mitigation: the parent page shows "last heard
  from" per device and flags anything quiet for 7+ days.
- **Open question:** should `parent.html` ship in this public repo? It holds no
  secrets — tokens are per-device and entered at runtime — so yes, but worth
  re-confirming before it ships.
- **Open question:** whether to ever enable family creation for others (§5).
  Nothing in Phase 1 forecloses it; nothing in Phase 1 requires deciding.

---

## 14. Summary

Yes, and free is realistic rather than a technicality — the data volume is
thousands of times below any free tier's limits.

Cloudflare Pages + Functions + D1, one-way append-only sync from the child
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
