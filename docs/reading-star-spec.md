# Reading Star — Specification

Status: **Design only. Not built.** This is the plan for a new app, Reading
Star, alongside Spelling Star, Math Star, Geography Star, and Logic Star.

Target files (when built): a new `reading-star-v1.html` (self-contained, same
conventions as the other four apps) and a new static content file,
`reading-catalog.json`. Everything else — sync, the parent dashboard — reuses
existing machinery from `docs/parent-sync-spec.md` with **no schema
migration and no new endpoint**, and two small additive Worker edits (§3.3,
§7). Touched along the way: `index.html`, `sw.js`, `parent.html`, and the
test tables — enumerated in §8.

Reviewed against the code as it stands; `docs/reading-star-spec-review.md`
records what that review found and why the corrections here read the way they
do.

---

## 1. Goals

- A kid can identify the book they're currently reading (from a catalog, or
  typed in if it's not there), log a start date, log reading sessions as they
  go, log an end date, and rate how much they liked it.
- Take a quiz on the book, if they want to — never required.
- A parent can see reading history on their phone, the same way they already
  see Spelling and Math history.
- Down the line: points that scale adaptively — the same book worth more to a
  younger or reading-support kid than to an older neurotypical one. Not
  required at launch, but the data model should not need to change to add it
  later.

### Non-goals (v1)

- Adaptive point weighting itself (§7 designs the hook; it isn't built yet).
- A large quiz catalog. It ships with whatever content exists (§4) and grows
  over time.
- Forcing quiz completion, or gating "finishing" a book on taking one.

---

## 2. Why this fits the existing sync design without a new mechanism

`docs/parent-sync-spec.md` §2.1 excluded Geography and Logic Star from sync
specifically because their real signal lives in **cumulative state**
(`mastery{}`, `stats{}`) rather than **append-only events with per-item
detail** — state-based sync would have been a second mechanism, with its own
conflict semantics, alongside the append-only one Spelling and Math already
use.

A reading log looks stateful at first glance ("what book is X currently
reading?") but isn't, structurally: *starting* a book, *logging a session*,
*finishing and rating*, *setting it down for good*, and *completing a quiz*
are all point-in-time events. "Currently reading" is just the latest `start`
event for a book with no later `finish` or `abandon` for the same book —
derived client-side, the same way the dashboard
already derives everything else from an event stream rather than a mutable
row. So Reading Star can be **the third app on the existing append-only sync
path**, not a new one.

Concretely, that means: no new server table, no new endpoint, no schema
migration. `sessions.app = 'reading'` slots in next to `'spelling'` and
`'math'`.

It does *not* mean no server change at all. Two places in the Worker
enumerate the apps they know about, and neither has a `reading` case today:
the envelope-column mapping in `sync.js` (needed for v1 — §3.3) and the
command-kind list in `_lib/auth.js` (only when Phase 2 lands — §7). Both are
one-line-ish and additive. Nothing about the schema or the API surface
changes.

---

## 3. Data model

### 3.1 Local (`localStorage`)

One key per child, `readingstar-<slug>`, same pattern as the other apps. Two
structures, not one — and which is the source of truth matters:

```js
// The truth. Append-only, never edited in place. This is what gets pushed,
// and it is the same shape data.sessions has in Spelling/Math.
data.events = [{
  id,            // per-EVENT id, minted fresh at write time (see §3.2)
  date,          // ISO, from the client
  mode,          // 'start' | 'log-session' | 'finish' | 'abandon' | 'quiz'
  score, total,  // quiz only; null otherwise

  // The scope stamp, carried on every event. Named the way Spelling carries
  // listId/listName/listGrade — §3.3 maps these onto the envelope columns.
  bookId,        // which book; becomes scope_id
  bookTitle,     // frozen at write time; becomes scope_name
  childGrade,    // the CHILD's school grade; becomes grade

  ...            // per-mode detail, see §3.2's payload row
}]

// The view. Rebuilt from data.events; cached in localStorage so the
// currently-reading screen paints without a reduce on every render.
data.books = [{
  id,            // client-minted uuid; equals data.events[].bookId
  catalogId,     // e.g. "thoroughbred-1"; null for a custom/untracked title
  title, author, series, seriesNumber,
  gradeLevel,    // the BOOK's difficulty band from the catalog ("4-6");
                 // blank for custom entries. Not the child's school grade.
  status,        // 'reading' | 'finished' | 'abandoned' — derived: the latest
                 // start with no later finish/abandon for the same bookId
  startedAt,
  endedAt,       // null while reading
  sessions: [{ at, minutes, pages, note }],   // "I read today" log entries
  rating,        // 1-5, kid-facing; null until finished
  quizzes: [{ score, total, answeredAt, missed: [questionId, ...] }]
}]
```

**Why an event array and not just `data.books`.** §2's whole argument is that
the events are the truth and "currently reading" is derived, so the local
model should say that too. Three concrete things break if `data.books` is the
only structure:

1. The push queue needs stable ids. `ackedIds` (§3.2) tracks what the server
   has confirmed; if events are re-derived from `data.books` on each sync,
   their ids have to be stable across re-derives anyway — at which point they
   are stored, and this is just the storage.
2. `delete-session` arrives as a command carrying `sessionIds[]` and has to
   find them (§3.3).
3. Retakes and repeated sessions are naturally append-only; folding them into
   a book record means mutating a record the server already has a copy of.

`data.books` is a cache, and a corrupted or missing one is recoverable by
rebuilding from `data.events`. Only `data.events` is local-first truth in the
sync spec's sense (§3: local-first, cloud is a mirror).

### 3.2 What gets pushed

Every meaningful action is flattened into its own append-only event and
pushed through the existing `/api/sync`, identical in shape to a Spelling or
Math session row:

| Field | Value |
|---|---|
| `app` | `'reading'` |
| `session_id` | the **event's** own id, not the book's — see below |
| `mode` | `'start' \| 'log-session' \| 'finish' \| 'abandon' \| 'quiz'` |
| `scope_id` | the book's local `id` — this is what ties a book's events together |
| `scope_name` | the book's title, frozen at write time (§16.3 of the sync spec — the multi-year aggregate groups on this, so it has to be a column, and it already exists) |
| `score` / `total` | quiz score/total when `mode = 'quiz'`; null otherwise |
| `grade` | the **child's school grade** when the event happened, same as every other app. The book's difficulty band goes in `payload`. See below. |
| `payload` | title and author (always, see below), plus whatever's specific to the event: rating on `finish`, minutes/pages/note on `log-session`, book difficulty band and missed-question ids on `quiz` |

No schema migration is needed: `scope_id`/`scope_name`/`grade` already exist
on `sessions` (added in Phase 3/§16 for Spelling's list id and Math's focus
area — reading's "book" is a third filling of the same slot), and `payload`
is already an opaque per-app JSON blob the server never parses. One small
Worker edit *is* needed to populate them; that's §3.3.

**`session_id` is per event, not per book.** The sessions table is keyed
`PRIMARY KEY (child_id, app, device_id, session_id)` and `/api/sync` inserts
with `ON CONFLICT ... DO NOTHING`. `mode` is not part of that key. So if all
of a book's events shared one id — the tempting reading of "scope_id is the
book" — only the first would ever persist, and it would fail *silently*: the
insert succeeds, sync returns 200, and sync spec §3 rule 1 deliberately keeps
sync failures away from the child, so nobody would see it. Every event mints
its own id at write time. Spelling and Math use `id: Date.now()`, which is
fine at kid pace, but a flow that writes two events in one gesture (finish +
rate, or finish then quiz) must not mint both from a single `Date.now()`.

**`grade` is the child's school year, not the book's level.** Every other
writer of this column means "what grade was this child in when this happened"
(`schema.sql`, sync spec §16), and `/api/summary` GROUPs BY it to drive the
Years tab. Putting `"4-6"` there would make reading rows read as a grade in a
view where every other row reads a school year. The child's grade is already
known at setup — Math Star reads exactly this at §16.5 — so stamp that, and
keep the catalog's `gradeLevel` in `payload` where it's still available for
the future point weighting (§7).

**Title and author have to reach `payload`, not only `scope_name`.**
`GET /api/sessions` — the endpoint the parent card reads — selects
`session_id, device_id, occurred_at, received_at, mode, score, total, payload`
and does *not* return the scope columns. Those exist for the aggregate in
`/api/summary`, which is a different query. A card built on `/api/sessions`
expecting the title in `scope_name` would render blank rows.

This costs nothing to get right, because `sync.js` already does it: it
destructures `{ id, date, mode, score, total, ...rest }` and stores `rest`
wholesale as the payload, so the scope fields it reads are *also* the payload
fields it keeps. `bookTitle` is duplicated into the column and the blob by the
existing code path — the same way `listName` already is for Spelling. Author
has no column, so it just rides in the blob. Nothing extra to write; the point
is only that the card must read the title from the payload, not expect a
column that endpoint never sends.

**Missed questions are stored by stable question id, never by array index.**
§4 plans for the catalog to grow incrementally, and an index into
`questions[]` silently re-points at a different question the moment one is
inserted or reordered — retroactively rewriting history the "trouble items"
card (§6) reads directly. This is the same reasoning that made `scope_name` a
frozen denormalized copy rather than a lookup (sync spec §16.3): renaming a
thing must not relabel the past.

The sync module's **transport** (pairing, push-on-`persist()`, `ackedIds`,
retry) is pasted in unchanged from Spelling/Math, per the sync spec's rule
that transport code is identical across apps (§3 rule 5) — only the `app`
string and the `syncState()`/`applyCommand()` seam differ. `applyCommand()`
is a real difference and not a rename; see §3.3.

### 3.3 What "no schema change" still leaves to change

Three things, none of them touching the schema or the API surface, and none
obvious from the sentence "reading reuses the existing pipe."

**1. `sessionScope()` in `functions/api/sync.js` — a real Worker edit.** It maps each app's own
vocabulary onto the shared envelope columns, and branches on the app name:
spelling reads `listId`/`listName`/`listGrade`, math reads
`focusId`/`focusName`/`focusGrade`, and everything else falls through to
`{ grade: null, id: null, name: null }`. Without a `reading` case, every
reading event inserts with all three columns NULL — again silently, since the
insert itself succeeds. Reading's fields are `bookId` / `bookTitle` /
`childGrade`, and the branch is three lines.

**Order matters: this ships before any tablet pushes a reading event.**
Nothing backfills a NULL scope column, so events pushed before the Worker
knows about `reading` are permanently missing from the Years view. In
practice the Worker deploy is part of Phase 1 (§8) and precedes the sync code
reaching any tablet, which is the safe order anyway.

**2. `sessions.app`'s comment in `schema.sql`** still reads `'spelling' |
'math'`. There is no CHECK constraint, so this is documentation only and no
migration — but it's the file someone reads to learn what the column holds,
and the same is true of the `app` comment on `commands`.

**3. Client-side: `applyCommand`'s `delete-session` case is reading-specific.**
Spelling's `applyRemoteSessionDelete()` filters a flat `data.sessions` array
by id. Pasted into an app whose local model is books-with-nested-sessions, it
finds nothing and returns false. The parent's delete would then tombstone the
server rows (`/api/sessions/delete` does both halves in one call) while the
tablet kept showing them — exactly the divergence sync spec §15.3 says that
endpoint exists to prevent. With `data.events` as the source of truth (§3.1)
the handler is the same one-line filter Spelling uses, followed by a rebuild
of the `data.books` cache. This is the main reason §3.1 has two structures.

---

## 4. Quiz content

The source CSV is committed at
`wordlists/reading/Thoroughbred_Quiz_Books_15.csv`, mirroring the spelling
layout. One row per question, ten columns:

```
series_name, series_number, book_title, author, grade_level,
question, correct_answer, wrong_answer_1, wrong_answer_2, wrong_answer_3
```

It holds **53 questions across books #1–5** of the Thoroughbred series — the
"_15" in the filename is aspirational, not a row count, so the catalog
launches small and grows. No blank cells; every question has exactly three
distractors, so the converter can assume four options and doesn't need a
variable-length answer path.

It becomes `reading-catalog.json` — a single static file, bundled, fetched at
load, no build step at runtime:

```json
{
  "thoroughbred-1": {
    "series": "Thoroughbred", "seriesNumber": 1,
    "title": "A Horse Called Wonder", "author": "Joanna Campbell",
    "gradeLevel": "4-6",
    "questions": [
      { "id": "tb1-q1",
        "q": "What was the name of the Griffen family's own farm...",
        "correct": "Edgardale",
        "wrong": ["Whitebrook", "Townsend Acres", "Saddlebrook"] }
    ]
  }
}
```

Answer order is shuffled at quiz time, not stored pre-shuffled.

The catalog key (`thoroughbred-1`) is `slug(series_name)-series_number`.
`gradeLevel` is the book's `grade_level` column verbatim — a difficulty band,
not a school grade (§3.2).

**`id` on each question is required, and is assigned once and never reused.**
It is what `payload.missed` records (§3.2). The conversion step assigns them
and must be idempotent for questions that already have one, so that
regenerating the catalog after adding a book doesn't renumber the existing
ones and invalidate every quiz result already recorded. The simplest form that
holds: `<bookKey>-q<n>` by first-appearance order within a book, with the
script reading any existing `reading-catalog.json` and preserving ids for
questions whose text it already knows. Appending a book is then purely
additive; the failure mode to design against is a *reordered* or reworded
source row silently inheriting a different id.

**This is a new pattern, not an existing one.** An earlier draft described it
as "structured like `spelling-lists.json`," which is misleading in three
ways: there are two files by that name (`./spelling-lists.json`, a small
grade→list-id index precached by `sw.js`, and
`wordlists/spelling/spelling-lists.json`, which is what `resources.html`
actually fetches); neither holds content of this shape; and the Spelling app
itself fetches no content JSON at all — its word lists arrive by parent
assignment. A single bundled title→content map is a reasonable design for a
quiz bank, it just isn't precedent being reused. It needs its own
`PRECACHE_URLS` entry (§8).

Conversion is a repeatable **CSV → JSON script**, not a hand-edit, since more
series get added incrementally over time. It is the only thing standing
between the committed CSV and a buildable Phase 0b.

A book typed in that isn't in the catalog just has no quiz available — logging
a book is never gated on catalog membership, since a lot of independent
reading won't be in any bank.

---

## 5. Core flows

- **Start a book.** Search the catalog (by series/title) or type a custom
  title + author. Writes a `start` event, sets `status = 'reading'`.
- **Log a session.** One tap ("I read today") from the currently-reading
  screen; optional minutes or pages, optional note. Writes a `log-session`
  event. No quiz, no pressure — this is the low-friction one, used the most.
- **Finish + rate.** End date stamped, kid picks a rating (simple 1-5, kid
  language rather than stars-as-percentage — same "never show a percentage to
  a kid" rule the other apps follow). Writes a `finish` event. Status becomes
  `'finished'`.
- **Stop reading it.** A book set down for good writes an `abandon` event and
  moves to `status = 'abandoned'`. It needs to be an event and not just a
  local status flag: §2's argument is that status is *derived* from events, so
  a status with no event is one the parent dashboard can never learn about,
  and the book would show as "currently reading" forever on the phone. Whether
  the kid gets a button for this or it's parent-side only is a UI question
  (§9); the event exists either way.
- **Take the quiz** (optional, any time after starting, not gated on
  finishing). Multiple choice, one screen at a time, like the other apps'
  quiz-style modes. Writes a `quiz` event with score/total and which questions
  were missed. Retakes are allowed and each writes its own event (§9).
- **History.** A list of past books with dates, sessions logged, rating, quiz
  score if taken. CSV export, same PIN-gated parent area as the others.

---

## 6. Parent dashboard (`parent.html`)

A new card, same pattern as the Spelling/Math cards in §9 of the sync spec:

- Currently reading, per child.
- Reading history: title, author, dates, days spent, session count, rating,
  quiz score.
- A "trouble items" analog: missed quiz questions, or weak
  series/authors — the same "what needs work" instinct as Spelling's
  trouble-words and Math's trouble-categories, just applied to reading
  comprehension instead of spelling/arithmetic.

All of this falls out of the event stream once it's pushed — no new
aggregation mechanism, same `GET /api/sessions` the other cards already use,
reading title and author out of `payload` (§3.2).

Two hardcoded tables in `parent.html` also need a `reading` entry, and one of
them carries a decision rather than a label:

- `APPS` — id and label. Purely additive.
- `MODES` — the per-app map of mode → `{ label, tone }`. It is also what
  `modeOrder()` and the graded-sitting derivation read, so this is where
  "reading's graded sitting is `quiz`" gets expressed, the same way Spelling's
  is `test` and Math's is `drill`. Unknown modes already degrade gracefully
  (`modeInfo()` falls through to the raw mode string), so a missing entry
  renders ugly rather than breaking — which means it's also easy to leave
  half-done.

`GET /api/summary` needs no change at all. It filters `total > 0`, so
`start` / `log-session` / `finish` / `abandon` events — which carry null
score and total — drop out on their own, and `?app=reading&mode=quiz` returns
best quiz score per book, since the aggregate already computes `MAX(ratio)`
grouped by `(grade, scope_id)`. That is the Years-tab query, unmodified.

---

## 7. Adaptive points (designed now, built later)

Not part of v1. Two things are worth deciding now so the later work doesn't
require a data-model change:

**Where the adjustment input comes from.** Per the sync spec's rule that the
server is dumb storage and all logic (grading, weighting) stays client-side,
the multiplier has to be computed on-device, not on the Worker. The input
that drives it — "this reader gets more credit for the same book" — should be
something a **parent** sets, not something the kid self-reports. The existing
Phase 3 command queue (`docs/parent-sync-spec.md` §15) already exists for
exactly this shape of thing: a parent action on the phone that becomes an
instruction the tablet applies to its own `localStorage`. A new command kind,
`set-reading-support-level`, fits that pattern directly — no new channel, no
new endpoint, no schema change.

It does need one line of Worker: `COMMAND_KINDS` in
`functions/api/_lib/auth.js` is a server-side whitelist, and `/api/commands`
rejects an unrecognized `kind` with a 400 before it reaches the queue. (Sync
spec §15.3 both describes this check and concludes that a new kind ships "as
an app change rather than a backend deploy" — the check is what's actually
there, and the deploy is real if small.) The meaning of the payload stays
entirely client-side, which is the part of §3 rule 3 that matters.

Order matters here too, in the opposite direction from §3.3: the Worker must
learn the kind *before* the parent dashboard offers the control, or the
parent gets a 400 on every attempt with nothing queued.

**What that input is called.** `readingSupportLevel` — a generic tier, not a
diagnosis label. This repo doesn't collect sensitive fields anywhere today
(no names beyond a nickname, no birthdates, no diagnoses — §10 of the sync
spec), and a field like "dyslexia" attached to a minor's profile would be the
first exception to that. A generic support tier gets the same adaptive
behavior without being a label that has to be protected, explained in a
privacy policy, or excluded later if hosting ever opens up to other families.

**The formula itself is explicitly not designed yet** — v1 logs the raw facts
(book grade level, quiz score, time spent, rating) with a flat point value.
Because those facts are already being recorded from day one, a future
`computePoints(book, childProfile)` can be dropped in client-side with no
backfill.

---

## 8. Build order

0. **Phase 0a — content.** The source CSV is committed
   (`wordlists/reading/Thoroughbred_Quiz_Books_15.csv`). What remains is the
   CSV → JSON script that produces `reading-catalog.json` with stable question
   ids (§4). Nothing else can start without it.
1. **Phase 0b — the app itself, no sync.** `reading-star-v1.html`:
   catalog + custom books, start/log/finish/rate/abandon, optional quiz, CSV
   export. Satisfies the whole request on its own, offline, same as any other
   app before its sync phase. Shipping a new app file also means:
   - a tile in `index.html` (four hardcoded cards today);
   - `./reading-star-v1.html` and `./reading-catalog.json` added to
     `PRECACHE_URLS` in `sw.js`, **and** a `CACHE_VERSION` bump — without the
     bump, clients keep serving the old cache and the new page 404s offline;
   - a row in `tests/child-apps.test.mjs`, which is table-driven per app file.
2. **Phase 1 — sync.** The two Worker edits in §3.3 deploy *first*, then
   `app = 'reading'` events through the existing pipe (§3), then the
   `parent.html` card plus its `APPS`/`MODES` entries (§6). No schema
   migration. Worth an `api.test.mjs` case that a reading event round-trips
   with its scope columns populated, since the failure mode is silent.
3. **Phase 2 — adaptive points.** `readingSupportLevel` command kind (§7,
   including the `COMMAND_KINDS` line), `computePoints()`.
4. **Later, ongoing.** Catalog ingestion tooling and expansion beyond the
   Thoroughbred series.

---

## 9. Decided, and still open

**Quiz retakes: allowed, append-only, best score displayed.** This was listed
as undecided, but the existing machinery decides it. Distinct `session_id`s
(§3.2) make each attempt its own row for free, and `/api/summary` already
computes `MAX(ratio)` per `(grade, scope_id)` — "best quiz score per book" is
the query the Years tab runs today, with no new code. The alternative, one
logged attempt, would mean editing a row the server already holds a copy of,
which is the one thing this pipeline doesn't do. Hence `quizzes: []` rather
than a single `quiz: {}` in §3.1.

**Abandonment is an event** (§5), because a status the parent can never see
is not a status. What stays open is only the UI: does the kid get an explicit
"I stopped reading this" control, or does the app infer it (no activity in N
days) and offer it as a prompt — or does it stay parent-side entirely? All
three write the same `abandon` event, so this can be settled during Phase 0b
without touching the data model.

**Still genuinely open:**

- Whether reading `start` events should be backdatable. A kid adopting the app
  mid-book wants to log a realistic start date, but a backdated `occurred_at`
  lands behind rows the server already has. Nothing breaks — `/api/sessions`
  orders by `occurred_at` and the aggregate doesn't care — but it's worth
  deciding whether the UI offers it before someone discovers it doesn't.
- Whether a custom (non-catalog) book that later appears in the catalog should
  be reconcilable, or stays a separate entry forever. Leaning: stays separate.
  Merging means rewriting `scope_id` on already-pushed events, and the payoff
  is small.
