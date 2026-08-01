# Reading Star spec — review

Status: **all findings below have been folded into
`docs/reading-star-spec.md`.** Kept as the record of what was checked against
the code and why the spec now reads the way it does — the corrections are
mostly one-line claims whose reasons run much longer than the claims, and the
next person to touch this will want the reasons. Section references are to the
spec as it stood at review time; the corrected spec has renumbered slightly
(§3.3 is new).

Review of `docs/reading-star-spec.md` (design-only, not built) against the
code as it actually stands. Verdict: **the core architectural claim holds —
reading really is an append-only event app and needs no schema migration —
but four of the spec's "no change needed" statements are wrong, and three
gaps would produce silent data loss if the spec were built as written.**

Ordered by what would bite hardest during the build.

---

## Blocking — the spec says "no server change" where a server change is required

### 1. `sessionScope()` has no `reading` branch, so `scope_id`/`scope_name`/`grade` land NULL

§3.2 is the load-bearing claim: `scope_id` = the book's local id, `scope_name`
= the title frozen at write time, `grade` = the catalog's level, and *"This is
why no server change is needed."*

The columns do exist, so the migration claim is right. But nothing populates
them for a new app. `functions/api/sync.js:180-188`:

```js
function sessionScope(app, rest) {
  if (app === 'spelling') { ... }
  if (app === 'math')     { ... }
  return { grade: null, id: null, name: null };   // ← reading lands here
}
```

Every reading event would insert with all three columns NULL. The failure is
silent: the INSERT succeeds, sync returns 200, and the loss only shows up
later as an empty Years tab.

Fix is three lines in `sync.js` plus a Worker deploy — but it has to be in
the plan, and §3.2's sentence should read *"no schema migration and no new
endpoint"* rather than *"no server change."* Note the deploy ordering: the
`reading` branch must ship **before** any tablet pushes reading events,
because nothing backfills a NULL scope column.

Also update the `app` column comment in `schema.sql:45` (`-- 'spelling' |
'math'`) — documentation only, no constraint, but it's the file someone reads
to learn what the column holds.

### 2. `COMMAND_KINDS` is a server-side whitelist — `set-reading-support-level` needs a deploy

§7 says a new command kind is *"an app-level decision, not a server change."*
That sentence is inherited from sync spec §15.3, which is itself slightly
self-contradictory: it says the server "checks `kind` against this list" and
then concludes a new kind ships "as an app change rather than a backend
deploy."

`functions/api/_lib/auth.js:55-61` is the list, and `commands.js` rejects
anything outside it with a 400. So `set-reading-support-level` is: one line in
`auth.js`, plus a Worker deploy, plus ordering care — a parent phone that
learns the new kind before the Worker does gets a 400 on every attempt.

Still cheap, still no schema change. But §7 should say so rather than promise
a pure client change.

---

## Blocking — silent data loss as specified

### 3. `session_id` is undefined, and the primary key will eat events

`sessions` is keyed `PRIMARY KEY (child_id, app, device_id, session_id)` and
`sync.js` inserts with `ON CONFLICT ... DO NOTHING`. `mode` is **not** in the
key.

§3.2 defines four event types per book (`start`, `log-session`, `finish`,
`quiz`) all sharing one `scope_id`, and never says what `session_id` is. The
natural reading — given "scope_id = the book's local id" — is to reuse the
book id, which would persist only the first event per book and drop the other
three without an error anywhere. Sync spec §3 rule 1 deliberately keeps sync
failures away from the child, so nobody would notice.

The spec needs one explicit sentence: **`session_id` is a fresh per-event id,
minted at write time; `scope_id` is what ties events to a book.** Worth also
noting that Spelling/Math use `id: Date.now()` (e.g.
`spelling-star-v6_3.html:938`), which is fine at kid pace but is a
millisecond-granularity id — a flow that writes `finish` and `quiz` back to
back should not mint both from one `Date.now()`.

### 4. "Sync module pasted in unchanged" breaks the `delete-session` path

§3.2 says the sync module is pasted in unchanged, only `syncState()` /
`applyCommand()` differ. But `delete-session` is not transport — it is an
`applyCommand` case, and in Spelling it is
`applyRemoteSessionDelete()` (`spelling-star-v6_3.html:2060-2072`), which
filters a flat `data.sessions` array.

Reading's local model (§3.1) is `data.books[]` with sessions *nested inside a
book*. Pasted in unchanged, that handler finds no `data.sessions` and is a
no-op — so a parent deleting a reading event tombstones the server row
(`functions/api/sessions/delete.js`) and the tablet keeps it forever. That is
exactly the divergence sync spec §15.3 says the combined endpoint exists to
prevent.

Two ways out; the spec should pick one:

- **Keep a flat `data.events[]` alongside `data.books[]`** as the push queue
  and the delete target, with `data.books` as the derived view. This matches
  §2's own argument (events are the truth, "currently reading" is derived) and
  makes `ackedIds` straightforward, since ids must be stable across re-derives.
- Or write a reading-specific `applyRemoteSessionDelete` that walks nested
  book sessions — more code, and it still needs stable per-event ids for
  finding 3.

The first is better and is what §2 already argues for; §3.1 just doesn't
reflect it.

### 5. `missed: [questionIndex, ...]` breaks when the catalog grows

§3.1/§3.2 store missed quiz questions as **indices into the catalog's
`questions[]`**. §4 explicitly plans for the catalog to grow incrementally,
and §8 step 4 makes catalog expansion ongoing work. Reordering or inserting a
question silently re-points every historical `missed` index at a different
question — and §6's "trouble items" card reads exactly that field.

The repo already has the right instinct one line up: `scope_name` is
denormalized *specifically* so a rename doesn't retroactively relabel history
(`schema-phase3.sql`, and sync spec §16.3). Apply the same rule here — store a
stable question id, or freeze the question text into the payload at write
time.

---

## Design conflicts worth resolving before building

### 6. `grade` means two different things

§3.2 maps `grade` to the catalog's `gradeLevel` — a difficulty band like
`"4-6"`. Everywhere else in the system that column means *the child's school
grade when the session happened* (`schema.sql:57`, sync spec §16), and
`/api/summary` GROUPs BY it to drive the Years tab.

Overloading it means the reading rows in a grade-keyed aggregate read `"4-6"`
where every other row reads a school year. Options: put the book's level in
`payload` and stamp the child's school grade in `grade` (consistent, and the
child's grade is already known — Math Star reads `gradeLevel` at setup); or
leave `grade` NULL for reading and keep book level in payload. Either is fine;
the current mapping isn't.

Worth noting what *does* work: `/api/summary` filters `total > 0`
(`summary.js:51`), so `start` / `log-session` / `finish` events (score and
total null) drop out on their own and `?app=reading&mode=quiz` yields best
quiz score per book with no new code. That's a genuinely clean fit.

### 7. `/api/sessions` does not return the scope columns

§6 says the parent card falls out of the event stream via the same
`GET /api/sessions`. It selects `session_id, device_id, occurred_at,
received_at, mode, score, total, payload` (`functions/api/sessions.js:28`) —
**no `scope_id`, `scope_name`, or `grade`.**

So a card built on `/api/sessions` cannot see the book title if the title only
lives in `scope_name`. Title/author must *also* ride in `payload`. That is
fine and costs nothing (payload is spread into the session object client-side),
but §3.2's payload column currently says "whatever's specific to the event,"
which reads as *not* including the title. Say it explicitly.

### 8. `'abandoned'` is a status with no event

§3.1 has `status: 'reading' | 'finished' | 'abandoned'`. §3.2's `mode` enum is
`'start' | 'log-session' | 'finish' | 'quiz'` — there is no abandon event. A
kid marking a book abandoned changes local state and pushes nothing, so the
parent dashboard never learns it, and §2's "status is derived from events"
argument quietly stops holding.

§9 flags abandonment as an open question, which is fair, but the two sections
should at least agree today. Cheapest resolution consistent with §2: make
`abandon` a fifth mode. Then §9's question narrows to a UI question (does the
kid get a button) rather than a data-model one.

---

## §9's open questions are already answered by the existing machinery

**Quiz retakes.** Append-only wins with zero extra work: distinct
`session_id`s make retakes separate rows, and `/api/summary` already computes
`MAX(ratio)` per `scope_id` — i.e. "best score per book" is the query the
Years tab runs today. Storing one attempt would mean a mutable row, which is
the one thing this pipeline doesn't do. Recommend: append-only, best score
displayed. This also makes §3.1's `quiz: {...}` singleton object wrong — it
should be `quizzes: [...]` locally.

**Abandonment.** See finding 8 — worth deciding now because it's a `mode`
value, not just UI.

---

## Smaller things

- **§4's `spelling-lists.json` analogy is misleading.** There are two files
  with that name — `./spelling-lists.json` (a 4-key grade→list-id index,
  precached in `sw.js:27`) and `wordlists/spelling/spelling-lists.json`, which
  is what `resources.html:98` actually fetches. Neither is what §4 describes,
  and the spelling *app* fetches no content JSON at all. `reading-catalog.json`
  as a single bundled title→content map is a reasonable new pattern — it just
  isn't an existing one, so don't describe it as following one.
- **The source CSV wasn't in the repo.** `Thoroughbred_Quiz_Books_15.csv` was
  referenced in §4 as "uploaded" but existed nowhere in the tree. *Resolved:*
  committed at `wordlists/reading/Thoroughbred_Quiz_Books_15.csv`. Verified
  contents — 53 question rows, books #1–5, ten columns, no blank cells, three
  distractors per question — are now recorded in §4 so the converter can be
  written against a known shape.
- **§8 Phase 0 is missing its integration checklist.** A new app file also
  needs: a tile in `index.html` (currently four hardcoded `<a class="card">`),
  `./reading-star-v1.html` + `./reading-catalog.json` added to
  `PRECACHE_URLS` in `sw.js`, and a `CACHE_VERSION` bump. Easy to forget; the
  symptom is a stale service worker serving a page that doesn't exist.
- **§6 Phase 1 also needs `parent.html` edits beyond "a new card":** `APPS`
  (`parent.html:113`) and `MODES` (`parent.html:125`) are hardcoded tables.
  `MODES` is the one with a real decision in it — it's what
  `gradedMode()`/`modeOrder()` derive from, and reading's "graded sitting" is
  `quiz`. Unknown modes do render (`modeInfo()` falls through to a raw label),
  so a missing entry degrades rather than breaks.
- **Test coverage.** `tests/child-apps.test.mjs` is table-driven per app file;
  Phase 0 should add a reading row. Worth stating in §8 since every other app's
  sync work landed with tests.

---

## What the spec gets right

Worth saying plainly, because the central argument is the part that's easy to
get wrong and it's correct:

- **The stateful-looking-but-actually-event-shaped argument (§2) holds.**
  Reading genuinely does decompose into point-in-time events with per-item
  detail, which is the exact property sync spec §2.1 uses to exclude Geography
  and Logic. This is the right test, applied correctly.
- **No new table, no new endpoint, no migration** — true. `scope_id` /
  `scope_name` / `grade` / `payload` are a real generic slot, and reading is a
  legitimate third filling of it.
- **§7's naming call is right and non-obvious.** `readingSupportLevel` over a
  diagnosis label, justified by the repo's existing no-sensitive-fields
  posture (sync spec §10), is the kind of decision that's much cheaper to make
  now than to unwind later.
- **Deferring the points formula while logging the raw facts from day one** is
  the correct sequencing — it's what makes "no backfill" true rather than
  aspirational.

---

## Suggested edits, shortest path

1. §3.2 — replace "no server change is needed" with "no schema migration or
   new endpoint"; add the `sessionScope()` line item and its deploy ordering.
2. §3.1/§3.2 — define `session_id` as per-event; add `data.events[]` as the
   push queue; `quiz` → `quizzes[]`; missed questions by stable id, not index.
3. §3.2 — `grade` carries the child's school grade; book level goes in payload
   alongside title and author.
4. §7 — `set-reading-support-level` is one line in `COMMAND_KINDS` plus a
   Worker deploy.
5. §3.2 or §8 — note that `applyCommand`'s `delete-session` case is reading
   specific, not pasted in unchanged.
6. §8 Phase 0 — add the CSV commit, `index.html` tile, `sw.js` precache +
   version bump, and a `child-apps.test.mjs` row.
7. §9 — close the retake question (append-only, best score) and either close
   abandonment or add `abandon` as a fifth mode.
