# Parent Sync — Specification (plan only, nothing built)

Status: **Planning.** No code written. This document is the design for adding
an optional backend so a parent can see each child's results from their own
phone, starting with Spelling Star.

Target files (when built): a new `parent.html`, a new `worker/` directory, and
additive changes inside the existing app files. No existing behavior changes
when sync is off.

---

## 1. Goals

- A parent opens a page on their own phone and sees, without touching the
  child's device: recent test scores, trend over time, and — the highest-value
  one for spelling — **which words the child keeps getting wrong**.
- Free. Not "free tier that becomes $19/month," actually free at this data
  volume, indefinitely.
- Works for several children and several devices.
- The apps keep working exactly as they do today with no network, no account,
  and no sync configured. Sync is strictly additive.

### Non-goals (for the first build)

- Accounts, passwords, or email for children. Children never sign in.
- Real-time / live-watching. Minutes-fresh is fine.
- Replacing `localStorage` as the source of truth. The cloud is a mirror.
- Parent-to-child direction (assigning lists remotely). Deferred to Phase 3.
- Multi-family / anything resembling a product. This is one household.

---

## 2. What exists today

Relevant to this plan, per app:

- One `localStorage` key per child, e.g. `spellingstar-<slug>` /
  `mathstar-<slug>`, holding one JSON blob (`data`).
- `data.sessions[]` is the history. In Spelling Star a session is:
  ```
  { id, date, mode, listName, score, total, bonusEarned,
    results: [ { word, correct, attempts, type } ] }
  ```
  `id` is `Date.now()`. `mode` is `practice | test | pretest | repeat | spotit`.
  `results[].type` is `main | bonus | review`.
- History is capped at 300 sessions in `load()`; CSV export is the long-term
  record.
- The parent area is PIN-gated, on the child's device, with `exportCSV()`.
- `load()` tolerantly defaults new fields, so old profiles keep opening.
- Static hosting (GitHub Pages), no build step, no CI, PWA with `sw.js`
  precaching the app shell.

Two facts that shape everything below: **the per-word `results` array already
contains everything a parent dashboard needs**, and **each session is immutable
once written**, which makes append-only sync the natural fit.

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

Rules that follow from this, and that the build must not violate:

1. A sync failure is never visible to the child and never blocks a session.
   Sessions save to `localStorage` first; the push happens after `persist()`.
2. If sync is off or unreachable, every app behaves byte-for-byte as today.
3. The server is dumb storage. All logic — grading, trend, trouble-word
   ranking — stays in the client, as it is now.
4. No third-party `<script src>` in the app files. The self-contained-HTML
   constraint holds; sync is `fetch()` calls only.

---

## 4. Backend options

Free tiers move, so treat the numbers as "verify at signup," not a promise.
The volume that actually matters here: a child doing 3 sessions a day is
~1,100 writes/year and a few MB. Every option below is 3-4 orders of magnitude
above that, so **capacity is not a differentiator — operational friction is.**

| Option | Free? | Friction | Verdict |
|---|---|---|---|
| **Cloudflare Pages + Functions + D1** | Yes. Workers ~100k req/day; D1 ~5 GB. No card. | Deploys on `git push` once connected. ~150 lines of your own code in the repo. Same origin as the apps → no CORS. | **Recommended** |
| Firebase Firestore (Spark) | Yes, no card. ~50k reads / 20k writes per day. | No server code, but a console to configure and security rules to get right. Usable via REST so no SDK script tag. Token refresh is fiddly. | Good alternative |
| Supabase | Free tier, but **projects pause after ~7 days of inactivity**. | A homeschool app goes quiet over breaks; a paused project is a dead dashboard needing a console visit. | Avoid |
| GitHub repo as the store | — | Needs a write token in client code, in a public repo, holding kids' data. | Never |
| Google Apps Script → Sheet | Yes. | Genuinely the least work, and the parent gets a spreadsheet they already know. But the deploy URL is a bare secret anyone can POST to, and you get a spreadsheet, not a dashboard. | Good escape hatch |

### Recommendation

**Cloudflare Pages + Pages Functions + D1**, and move hosting for the whole
repo from GitHub Pages to Cloudflare Pages.

Reasoning:

- Same origin means the apps call `/api/sync` — no CORS, no second domain, no
  cross-origin cookie/`SameSite` questions to reason about.
- Deployment stays "push to `main`". Cloudflare builds nothing (there's no
  build step); it serves the repo and runs `functions/`. No local `wrangler`,
  no CI to maintain.
- The API is yours, ~150 lines, in the repo, reviewable and diffable — which
  suits a codebase whose whole ethos is "one file you can read."
- No inactivity pause, no cold-start behavior a parent would notice.

Cost of the recommendation, stated honestly: hosting moves off GitHub Pages,
so the URL changes (`*.pages.dev`, or a custom domain), and any bookmark or
installed PWA on a kid device needs re-pointing once. That is a one-time
annoyance, and it is the only real downside.

If avoiding a hosting move outweighs that, the same worker can live on a
`*.workers.dev` subdomain with CORS headers and GitHub Pages stays as-is. The
plan below is unchanged apart from the endpoint URL and an `OPTIONS` handler.

---

## 5. Data model (server)

D1 / SQLite. Four tables, deliberately boring.

```sql
CREATE TABLE families (
  id          TEXT PRIMARY KEY,      -- random, e.g. 16 chars
  created_at  INTEGER NOT NULL
);

CREATE TABLE devices (
  token_hash  TEXT PRIMARY KEY,      -- SHA-256 of the device token; raw token never stored
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
  app         TEXT NOT NULL,         -- 'spelling' | 'math' | 'geography' | 'logic'
  device_id   TEXT NOT NULL,
  session_id  TEXT NOT NULL,         -- the client's Date.now() id, as text
  occurred_at INTEGER NOT NULL,      -- from the client
  received_at INTEGER NOT NULL,      -- from the server; clock-skew insurance
  deleted     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL,         -- JSON (or ciphertext — see §9)
  PRIMARY KEY (child_id, app, device_id, session_id)
);
```

`device_id` is in the primary key because two devices can both mint
`Date.now()` ids that collide. The composite key makes every push idempotent:
retrying a push that already landed is a no-op upsert, which is what lets the
client be careless about retries.

`deleted` is a tombstone, not a row removal, so that a delete on the child's
device propagates without the parent view resurrecting it from an old push.

### API

Four endpoints, all JSON, all authenticated by an `Authorization: Bearer
<device-token>` header.

- `POST /api/pair` — exchange a short-lived pairing code for a device token.
- `POST /api/sync` — `{ app, childId, childName, sessions: [...] }`, upserts.
  Returns the ids it accepted so the client can mark them acked.
- `POST /api/delete` — `{ app, childId, sessionIds: [...] }`, sets tombstones.
- `GET /api/children` and `GET /api/sessions?childId=&app=&since=` — parent
  reads. `since` keeps the parent page from re-downloading everything.

Rate-limit crudely (a per-token counter) so a bug in a retry loop can't burn
the daily request budget.

---

## 6. Pairing and auth

No child accounts. No passwords for children. The model is device tokens.

**First run (parent, on their own phone):** open `parent.html`, tap "Create
family." The server mints a family id and returns a parent device token, stored
in that phone's `localStorage`. The page shows a **6-word pairing phrase**,
valid ~10 minutes, single-use per child device.

**On each child device:** in the existing PIN-gated parent area, "Sync to my
phone" → type the pairing phrase → the device exchanges it for its own child
device token and stores it in the profile blob.

**Thereafter:** every request carries a token. Tokens are stored hashed
server-side, so a database dump doesn't yield working credentials.

Why this shape:

- The child device holds a token that can only *append* to its own family. It
  cannot read other children's data. If a tablet is lost, revoke that one token
  from the parent page and nothing else is affected.
- Nothing secret is ever typed on a kid device except a one-time phrase that
  expires.
- The parent phone's token is the only thing that can read. Losing that phone
  means revoking it from a second device, or from the D1 console.

Profile-blob addition on the child side, added tolerantly in `load()` in the
same style as every other migration:

```js
data.sync = { enabled, endpoint, childId, deviceToken, ackedIds: [], lastPushAt }
```

`deviceToken` living in `localStorage` is the accepted tradeoff: this is a
child's tablet in a house, and the token's only power is "append spelling
scores to this family."

---

## 7. Client sync mechanics

**When to push.** After `persist()` in `finishSession()` and the other three
call sites that push to `data.sessions`, plus once on app boot. Fire-and-forget:
no `await` in the render path, no spinner, no error toast the child could see.

**What to push.** Any session whose id is not in `data.sync.ackedIds`. On a
successful response, add the returned ids to `ackedIds`, `persist()`, done.
Failures do nothing at all — the next session or the next boot retries. Because
upserts are idempotent, double-sending is harmless.

`ackedIds` is capped and pruned alongside the existing 300-session cap so it
can't grow without bound.

**Deletes.** `deleteSession()` in the parent area calls `/api/delete`
best-effort. If it fails, the session reappears in the parent view — acceptable,
and a "Resync now" button in the child's parent area fixes it by pushing the
full current id set for reconciliation.

**The 300-session cap.** Once sync is on, the cloud holds more history than the
device. That is a feature, not a bug: it is also a backup. Worth saying plainly
in the UI, because Safari evicts non-persisted `localStorage` after ~7 days of
non-use — `navigator.storage.persist()` is already called at boot, but it is a
request, not a guarantee. **Sync is the first real protection this data has
against a wiped tablet.** For some users that will matter more than the
dashboard.

**Same child on two devices.** Both push under the same `childId` with
different `device_id`s. The cloud holds the union; local histories stay
divergent. The parent view is the merged truth. This is a documented
limitation, not a bug to fix in Phase 1.

---

## 8. Parent dashboard (`parent.html`)

New self-contained page, same visual language as `index.html`, never precached
as stale (network-first in `sw.js`; bump `CACHE_VERSION`).

Not a report card. A parent glances at this between other things, so it must
answer "how's it going, and what should we work on?" in one screen.

**Per child, one card:**

- Last 7 days: sessions done, average test score, sparkline.
- Most recent tests: date, list, score, honoring the profile's
  `percent | points` preference.
- **Trouble words** — the centerpiece for spelling. Rank words from
  `results[]` by miss count, weighted toward recent misses, excluding words
  already graduated out of `reviewWords`. Show the top ~10 with miss counts.
  This is the one thing the current CSV export makes a parent do by hand in a
  spreadsheet, and it is the reason to build any of this.
- Streak / last active, so "hasn't touched it since Thursday" is visible.

**Detail view:** one session, word by word, right and wrong, attempts.

**Copy discipline:** the existing apps never show a child a percentage or a
grade. `parent.html` is a parent-only surface behind a device token, so
percentages are fine there — but the page must never be linked from the child
apps' navigation, only from the PIN-gated parent area.

Phase 1 ships spelling only, and says so on screen for the other apps rather
than showing empty cards.

---

## 9. Privacy

The data is: first names, spelling words, and right/wrong marks. Low
sensitivity, but it is children's data on someone else's computer, so:

- HTTPS only; tokens in headers, never in URLs (URLs leak via logs and
  referrers).
- Names: encourage a first name or nickname at setup. No last names, no email,
  no birthdates — none are collected today and none should be added.
- Tokens hashed at rest. Pairing phrases short-lived and single-use.
- One-tap "delete everything" on the parent page that actually deletes rows.

**Optional, recommended for Phase 2: client-side encryption.** Derive an
AES-GCM key with PBKDF2 from a family passphrase (WebCrypto, no library) and
encrypt `payload` before it leaves the device. The server then stores opaque
blobs plus `child_id` and timestamps, and the parent page decrypts locally.
This costs perhaps 40 lines and means a database compromise, a Cloudflare
subpoena, or an operator error yields nothing readable. Deferred to Phase 2
only because it adds a "if you lose the passphrase, the data is gone" failure
mode that is better introduced once the basic loop is proven.

---

## 10. Build order

**Phase 0 — no backend (optional, ~1 session).** If something is wanted this
week: a "Share results" button in the child's parent area that puts a compact
summary on the clipboard or into the OS share sheet. Zero infra, and it
verifies the summary format is actually the one that's useful before any
server exists. Skippable if going straight to Phase 1.

**Phase 1 — the real thing (~3-4 sessions).**
1. Cloudflare Pages set up, repo connected, `main` deploying. Verify all four
   apps and the PWA still work on the new origin before touching app code.
2. D1 schema + `functions/api/*` + pairing. Test with `curl` alone.
3. `parent.html`: pairing, family creation, child cards, trouble words.
4. Spelling Star: `data.sync` field with migration, pairing UI in the parent
   area, push on session end and boot, `/api/delete` on session delete.
5. `sw.js` cache bump; `parent.html` network-first.

**Phase 2 —** Math, Geography, Logic (the same push code, different payload);
client-side encryption; token revocation UI.

**Phase 3 — parent → child.** The genuinely new capability: assign a spelling
list from your phone and have it appear on the tablet. Requires the child
device to *poll* on boot, and requires a real answer for conflicts between
remote and local edits. Deliberately last, because it inverts the one-way rule
in §3 and everything gets harder once it does.

---

## 11. Risks and open questions

- **Hosting move.** The one-time URL change and PWA re-install is the biggest
  practical cost of the recommendation. Decide before Phase 1 step 1, because
  step 1 is the move. (Alternative: `*.workers.dev` + CORS, keeps GitHub Pages.)
- **Free-tier drift.** Cloudflare could change terms. Mitigation: the API is
  four endpoints over SQLite; porting to another host is a day, not a rewrite.
  Keeping the schema plain SQL is deliberate for this reason.
- **Clock skew.** A tablet with a wrong date mints wrong `occurred_at` and odd
  session ids. `received_at` is stored as a sanity check; the parent view
  should prefer it when the two disagree by more than a day.
- **Silent sync failure.** Because failures are invisible by design, sync could
  be dead for weeks unnoticed. Mitigation: the parent page shows "last heard
  from this device" per device, and flags anything quiet for 7+ days.
- **Open question:** should `parent.html` live in this repo (public) at all?
  It contains no secrets — tokens are per-device and entered at runtime — so
  yes. Worth re-confirming before it ships.

---

## 12. Summary answer

Yes, and free is realistic rather than a technicality — the data volume is
thousands of times below any free tier's limits. The recommendation is
Cloudflare Pages + Functions + D1, one-way append-only sync from the child
devices, a read-only `parent.html` on the parent's phone, Spelling Star first
with trouble-word ranking as the headline feature. The main real cost is moving
hosting off GitHub Pages; the main unexpected benefit is that this doubles as
the first actual backup of data that currently exists only in a browser's
`localStorage`.
