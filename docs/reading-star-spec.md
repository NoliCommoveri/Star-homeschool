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
  go, log an end date, and rate how much they liked it. More than one book can
  be "currently reading" at once — starting a new one never requires finishing
  or quitting whatever's already in progress (§9).
- Take a quiz on the book, if they want to — never required.
- A parent can see reading history on their phone, the same way they already
  see Spelling and Math history, **and edit the book catalog from there** —
  add a book the bundle doesn't have, fix a wrong quiz answer, write questions
  for whatever their kid is reading now (§4.3).
- Down the line: series-completion progress on the kid side, and grouping
  books read by series and by genre. Not built at launch, but §4.2 makes v1
  record what those displays will need, since the classification of a book a
  kid read last spring can't be recovered later.
- Down the line: points that scale adaptively — the same book worth more to a
  younger or reading-support kid than to an older neurotypical one. Not
  required at launch, but the data model should not need to change to add it
  later.

### Non-goals (v1)

- Adaptive point weighting itself (§7 designs the hook; it isn't built yet).
- The series-progress and genre-grouping displays themselves (§4.2 designs
  what they need recorded; the screens come later).
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
enumerate what they know about, and neither has a `reading` case today: the
envelope-column mapping in `sync.js` (§3.3) and the command-kind list in
`_lib/auth.js`, which needs `assign-book` / `delete-book` for parent catalog
editing (§4.3) and `set-reading-support-level` later (§7). Both are
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

  // Classification, also frozen at write time (§4.2). Null where unknown —
  // a standalone book, or a custom entry the kid didn't classify.
  seriesKey, seriesNumber,
  genre,         // array of vocabulary keys

  ...            // per-mode detail, see §3.2's payload row
}]

// Parent-authored catalog entries and overrides (§4.3), keyed by book_key
// and merged over the bundled reading-catalog.json at load. Arrives by
// assign-book command; never written by the kid.
data.catalogOverlay = { [bookKey]: { title, author, seriesKey, seriesNumber,
                                     genre: [], gradeLevel, questions: [] } }

// The view. Rebuilt from data.events; cached in localStorage so the
// currently-reading screen paints without a reduce on every render.
data.books = [{
  id,            // client-minted uuid; equals data.events[].bookId
  catalogId,     // the catalog's book_key (§4.1); null for a custom title.
                 // Settable after the fact too, not just at start — see §9's
                 // catalog-reconciliation flow.
  title, author,
  series,        // null for a standalone book — and for every custom entry
  seriesNumber,  // null unless series is set
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
| `payload` | title and author (always, see below); `seriesKey`/`seriesNumber`/`genre` frozen at write time (§4.2); the book's difficulty band; plus whatever's specific to the event — rating on `finish`, minutes/pages/note on `log-session`, missed-question ids on `quiz` |

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
layout. One row per question, eleven columns:

```
book_key,                                   <- identity; required, unique
series_name, series_number,                 <- display only; blank for standalones
book_title, author, grade_level,
question, correct_answer, wrong_answer_1, wrong_answer_2, wrong_answer_3
```

It holds **53 questions across books #1–5** of the Thoroughbred series — the
"_15" in the filename is aspirational, not a row count, so the catalog
launches small and grows. Every question has exactly three distractors, so the
converter can assume four options and doesn't need a variable-length answer
path.

### 4.1 `book_key` is authored, not derived

A book's identity is an explicit column that a human assigns once. It is
**not** computed from series name and number, and not computed from the title.

The immediate reason is that plenty of books aren't in a series at all —
*Where the Red Fern Grows*, most of what independent reading actually looks
like — and a `slug(series)-number` scheme has nothing to key them on. Making
series required to satisfy the key format would be the data model bullying the
content.

But the singleton case only exposed a problem that was already there. A
derived key means **identity changes whenever its inputs are edited**, and
these inputs are exactly the fields most likely to get edited: a series
renamed ("Thoroughbred" → "Thoroughbred Classics"), a typo fixed, a book
renumbered when an omnibus or a prequel shows up. Any of those silently mints
a *new* catalog key, and because question ids are `<book_key>-q<n>` (below),
every question id under that book changes with it — so every `payload.missed`
already recorded points at ids that no longer exist, and the trouble-items
card in §6 quietly empties out.

That is the same failure this spec already rules out twice: question ids are
assigned once and never reused, and `scope_name` is a frozen copy so a rename
can't relabel the past (§3.2, sync spec §16.3). Deriving the book key would
have reintroduced it through the back door. An authored key is one column and
makes the whole family of edits safe: fix the series name, fix the title, fix
the numbering — the key doesn't move, and history stays attached.

Rules for the converter, all of which should **fail the build loudly** rather
than guess:

- `book_key` is required on every row; a blank one is an error, not a
  fallback to a derived value.
- It must be unique per book and consistent across that book's rows — two
  different `book_title`s under one key, or one title under two keys, is an
  error.
- It should be a readable slug (`thoroughbred-1`, `red-fern-grows`) so a
  human maintaining the CSV can spot a duplicate by eye, but nothing depends
  on its shape.
- Once a key has shipped in a catalog, it is permanent. Renaming one is a
  history-orphaning migration, not an edit.

Series stops being what the system *keys on*. It does not stop mattering —
§4.2.

### 4.2 Classification: series and genre

Two axes hang off a book, and both are wanted for more than decoration:
series-completion progress on the kid side ("you've read 4 of the
Thoroughbred books"), and grouping books read — by series, and by genre — on
both sides. Neither display is v1. Both are cheap to add later **and
impossible to add retroactively**, which is what makes them a v1 data-model
question rather than a v1 feature question.

This is §7's shape exactly: record the facts now, build the display whenever.

**The numerator has to be recorded now. The denominator can arrive whenever.**
"4 of 12 Thoroughbred books" needs two things: which books this kid finished
and what series each belonged to (the numerator — only knowable at the moment
the kid reads it), and how many books the series contains (the denominator —
a static fact, lookup-able forever). Only the first is perishable. So v1
stamps series and genre onto every event, and the series-length table can land
years later with no backfill.

**Both need stable keys, for the same reason `book_key` does (§4.1).** The CSV
gains `series_key` and `genre` alongside the human-readable `series_name`.
Renaming a series must not detach a kid's history from it, and it will get
renamed — subtitles change, a publisher rebrands, someone fixes a typo. Same
argument, second instance; §4.1 spells it out.

**Stamped onto the event, not looked up from the catalog at read time.** The
lookup version is tempting — one copy of the truth, corrections propagate —
but it makes classification mutable after the fact, and §4.3 hands parents an
editor that can re-genre a book in ten seconds. Then last year's reading
silently re-sorts itself, and a genre breakdown means something different
every time it's opened. Freezing is the same call `scope_name` already makes
(§3.2), and the cost is a few dozen bytes an event.

**Series lives in its own file.** `wordlists/reading/series.json` holds
`{ series_key: { name, author?, totalBooks } }`. It is separate from the quiz
CSV because a series is a different entity than a question: it exists whether
or not any of its books have quizzes, and the quiz catalog will never be a
complete list of a series — the Thoroughbred catalog holds 5 books out of a
series that ran far longer. Deriving "how many Thoroughbred books are there"
from the quiz CSV would answer 5, and the progress display would read *4 of 5*
when the truth is *4 of many*. That is worse than showing nothing.

`totalBooks` may be `null`, permanently and legitimately — an open-ended or
still-running series has no total. `null` renders as a plain count ("4 books
read"), never as a fraction or a percentage. The committed `series.json` has
`totalBooks: null` for Thoroughbred; fill it in when you want the fraction.

**Genre is multi-valued and needs a controlled vocabulary.** A book is often
two things at once, so the CSV column is semicolon-delimited
(`animal-fiction;realistic-fiction`) and the catalog emits an array. The
values must come from a fixed list the converter validates against, because
free-text genre degrades into `sci-fi` / `scifi` / `science fiction` as three
distinct groups within about a month, and the grouping display is the entire
point. An unknown genre should fail the conversion, not pass through — the
same fail-loudly posture as `book_key`.

The vocabulary itself isn't specified here; it's a content decision, and the
list can grow. Adding a value is a one-line change with no migration, since
genres are stamped as strings at write time. Committed values for the
Thoroughbred rows are `animal-fiction;realistic-fiction` — a starting point,
not a considered taxonomy.

**Custom books need optional series and genre too.** A kid reading
Thoroughbred #6 — not in the quiz catalog, typed in by hand — should still
count toward series progress, or the number is wrong in the one direction
that's demoralizing: it undercounts real reading. So the "type a custom title"
flow (§5) offers an optional series picker over known series plus a genre
pick. Optional, skippable, and a skipped one just doesn't group. Getting this
in Phase 0b is what makes the eventual display honest; adding it later means a
permanent hole in the middle of the history.

**A caution about the kid-side percentage.** `docs/math-star-spec.md` states
the rule plainly — *"Kid-facing views never show a percentage or a grade"* —
and §5 of this spec inherits it for ratings. A series-progress display is a
genuine edge case rather than a violation: the rule exists so a kid isn't
graded on performance, and "how much of this series have you read" measures
collection, not competence. Nothing is being scored.

The safe form is also the better one: **show it as a count and a bar — "4 of
12", eleven segments filled — not as "33%".** A count is concrete and reads as
progress; a percentage is the register the other apps deliberately avoid, and
a kid who sees `33%` on one screen has been taught that percentages are how
this app talks about them. Keep the numerals; skip the percent sign.

It becomes `reading-catalog.json` — a single static file, bundled, fetched at
load, no build step at runtime:

```json
{
  "thoroughbred-1": {
    "series": "Thoroughbred", "seriesNumber": 1,
    "title": "A Horse Called Wonder", "author": "Joanna Campbell",
    "gradeLevel": "4-6",
    "questions": [
      { "id": "thoroughbred-1-q1",
        "q": "What was the name of the Griffen family's own farm...",
        "correct": "Edgardale",
        "wrong": ["Whitebrook", "Townsend Acres", "Saddlebrook"] }
    ]
  },

  "red-fern-grows": {
    "series": null, "seriesNumber": null,
    "title": "Where the Red Fern Grows", "author": "Wilson Rawls",
    "gradeLevel": "4-6",
    "questions": [ ... ]
  }
}
```

The top-level key is the CSV's `book_key`, verbatim (§4.1). `gradeLevel` is
the `grade_level` column verbatim — a difficulty band, not a school grade
(§3.2). Answer order is shuffled at quiz time, not stored pre-shuffled.

**`id` on each question is required, and is assigned once and never reused.**
It is what `payload.missed` records (§3.2). The conversion step assigns them
and must be idempotent for questions that already have one, so that
regenerating the catalog after adding a book doesn't renumber the existing
ones and invalidate every quiz result already recorded. The simplest form that
holds: `<book_key>-q<n>` by first-appearance order within a book, with the
script reading any existing `reading-catalog.json` and preserving ids for
questions whose text it already knows. Appending a book is then purely
additive; the failure mode to design against is a *reordered* or reworded
source row silently inheriting a different id. Note this inherits its
stability from `book_key`'s, which is the second reason §4.1 doesn't derive
it.

### 4.3 Parents editing the catalog

A parent needs to add and edit catalog books from the phone — a book the
family owns that isn't in the bundle, a fixed typo, a wrong quiz answer,
questions written for whatever their kid is actually reading. This does not
need a new mechanism either.

**It's `assign-list` with a different noun.** The Phase 3 command queue (sync
spec §15) is exactly "a parent action on the phone that becomes an instruction
the tablet applies to its own `localStorage`," and Spelling already ships a
whole word list through it. A book is the same shape and smaller: one
`assign-book` command, payload `{ book: { key, title, author, seriesKey,
seriesNumber, genre[], gradeLevel, questions[] } }`, plus `delete-book` to
retire one. Well inside the 64 KB payload cap — the largest Thoroughbred book
here is 11 questions, a couple of KB.

**The bundled catalog is read-only; parent edits are an overlay.**
`reading-catalog.json` is a static asset and the app cannot rewrite it. So
edits land in a `data.catalogOverlay` map in `localStorage`, merged over the
bundled catalog by key at load. Entry shape is identical in both, so the quiz
runner, §5's search, and §6's card never know which one a book came from.
An override keeps winning after a bundle update — the parent's fix is
deliberate and shouldn't be silently reverted by a deploy — until the parent
removes it.

**Parent-minted keys are namespaced, and this is not optional.** §4.1 makes
`book_key` permanent and authored; a parent creating a book has to mint one,
and a hand-typed `red-fern-grows` would silently merge with a bundled
`red-fern-grows` shipping six months later — two different question sets
colliding under one key, with quiz history attached to both. Parent-created
keys get a reserved prefix (`p-` plus a random suffix) that the converter
refuses to emit. Same for question ids: parent-authored questions mint
`p-…`-prefixed ids so they can never collide with the converter's
`<book_key>-q<n>`.

**Replace by key, not by name.** §15.3 makes `assign-list` replace-by-name
because "ids are minted on whichever side created the thing." Books don't have
that problem — §4.1 gave them an authored, stable key precisely so identity
survives edits — so `assign-book` replaces by key, and renaming a book's title
is an edit rather than a new book. This is the payoff for §4.1 showing up a
second time.

**Editing questions has to respect §4's id rule.** A question's id is assigned
once and never reused, because `payload.missed` records it. So: correcting a
question's wording or a wrong answer **keeps** its id — it's the same
question, fixed, and past results stay meaningful. *Deleting* a question
retires its id permanently. Adding mints a new one. The editor should make
"fix this question" and "replace this question" visibly different actions,
because they mean different things to history and the parent can't be expected
to infer that.

**The parent composes against reality via `syncState()`.** §15.4's child-state
snapshot exists so the dashboard offers real choices instead of guessing.
Reading's `syncState()` pushes the overlay's keys and a thin index of the
bundled catalog — key, title, question count — so the phone can list what the
tablet actually has and offer edit-versus-create correctly. Keys and counts
only, not question text: the 128 KB state cap is generous but a full quiz bank
would eventually strain it, and the parent doesn't need the text until they
open one book to edit it.

**This moves the `COMMAND_KINDS` edit earlier.** §7 treats the `auth.js`
whitelist as a Phase 2 concern; parent catalog editing needs `assign-book` and
`delete-book` in the same phase as sync. Same one-line change, same ordering
rule (Worker before dashboard), just sooner — see §8.

**This is not a replacement for the CSV pipeline.** Bulk content — a whole
series at a time — stays a CSV conversion, which is reviewable in a diff and
versioned in the repo. Parent editing is the one-off path for the book in
front of them tonight. Both write the same entry shape, and a parent-authored
book that turns out to be worth keeping can be exported and folded back into
the CSV, which is a nice-to-have rather than a requirement.

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

Every flow below writes a date on its event. It's prefilled with now, but
always editable (§9) — a kid logging Tuesday's reading on Thursday, or
starting the app partway through a book, types the real date instead of
keeping today's.

- **Start a book.** Search the catalog by title or author, or type a custom
  title + author. Writes a `start` event, sets `status = 'reading'`. Series is
  a way to *group* results, not the way to find them — a catalog that will
  hold standalone books alongside series can't make browse-by-series the
  primary path (§4.1). Titles with no series sort in by author or title
  alongside the series headings rather than into an "Other" bucket. A custom
  title can be pointed at a matching catalog entry later, from the book's
  detail screen, once one exists (§9).
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

- Currently reading, per child — a list, since a kid can have more than one
  book going at once (§9).
- Reading history: title, author, dates, days spent, session count, rating,
  quiz score.
- A "trouble items" analog: missed quiz questions, or weak authors and
  series — the same "what needs work" instinct as Spelling's trouble-words and
  Math's trouble-categories, just applied to reading comprehension instead of
  spelling/arithmetic. Author is the dependable axis here, since series is
  null for standalones (§4.1); grouping by series is a bonus where it exists,
  not the basis of the card.

- **A catalog editor** (§4.3): add a book, fix a title or a wrong answer,
  write questions for what the kid is reading now. Composed against the
  tablet's real catalog via the §15.4 state snapshot, delivered as
  `assign-book` / `delete-book`, and showing delivery state the same way the
  existing assignment UI does — `ackCount` from `GET /api/commands` already
  reports which tablets have applied it.

The history parts fall out of the event stream once it's pushed — no new
aggregation mechanism, same `GET /api/sessions` the other cards already use,
reading title and author out of `payload` (§3.2). The editor is the one piece
that isn't just a view, and it rides the existing command queue rather than
anything new.

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

It does need one line of Worker, the same line §4.3 already touches:
`COMMAND_KINDS` in `functions/api/_lib/auth.js` is a server-side whitelist,
and `/api/commands` rejects an unrecognized `kind` with a 400 before it
reaches the queue. (Sync spec §15.3 both describes this check and concludes
that a new kind ships "as an app change rather than a backend deploy" — the
check is what's actually there, and the deploy is real if small.) The meaning
of the payload stays entirely client-side, which is the part of §3 rule 3 that
matters.

Order matters here too, in the opposite direction from §3.3: the Worker must
learn the kind *before* the parent dashboard offers the control, or the
parent gets a 400 on every attempt with nothing queued. Since §4.3 brings
`assign-book` / `delete-book` in earlier, the Phase 2 addition is just one
more entry in a list reading already appears in.

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

0. **Phase 0a — content.** The source CSV and `series.json` are committed
   under `wordlists/reading/`. What remains is the CSV → JSON script that
   produces `reading-catalog.json` with stable question ids, validating
   `book_key` uniqueness and the genre vocabulary (§4, §4.1, §4.2). Nothing
   else can start without it.
1. **Phase 0b — the app itself, no sync.** `reading-star-v1.html`:
   catalog + custom books, start/log/finish/rate/abandon, optional quiz, CSV
   export. Satisfies the whole request on its own, offline, same as any other
   app before its sync phase. Two things here are cheap now and expensive
   later, because they leave permanent holes in history if deferred:
   series/genre stamped onto every event, and the optional series/genre
   picker on custom books (§4.2). Shipping a new app file also means:
   - a tile in `index.html` (four hardcoded cards today);
   - `./reading-star-v1.html` and `./reading-catalog.json` added to
     `PRECACHE_URLS` in `sw.js`, **and** a `CACHE_VERSION` bump — without the
     bump, clients keep serving the old cache and the new page 404s offline;
   - a row in `tests/child-apps.test.mjs`, which is table-driven per app file.
2. **Phase 1 — sync.** `sessionScope()` in `sync.js` deploys *first* (§3.3),
   then `app = 'reading'` events through the existing pipe (§3), then the
   `parent.html` card plus its `APPS`/`MODES` entries (§6). No schema
   migration. Worth an `api.test.mjs` case that a reading event round-trips
   with its scope columns populated, since the failure mode is silent.
3. **Phase 1b — parent catalog editing** (§4.3). `assign-book` /
   `delete-book` added to `COMMAND_KINDS` and deployed *before* the dashboard
   offers the editor; `catalogOverlay` merge and `applyCommand` cases on the
   tablet; the editor UI and the `syncState()` catalog index. Separable from
   Phase 1 and worth separating — Phase 1 is read-only and can ship and settle
   on its own.
4. **Phase 2 — adaptive points.** `readingSupportLevel` command kind (§7 —
   by then `COMMAND_KINDS` already lists reading kinds), `computePoints()`.
5. **Later, ongoing.** Series-progress and genre grouping displays (§4.2 —
   the data is already there by then, including `totalBooks` in
   `series.json`), catalog ingestion tooling, and expansion beyond the
   Thoroughbred series.

---

## 9. Decided

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

**Every event's date is backdatable, not just `start`'s.** A kid isn't going
to remember to open the app the moment they sit down to read, or the moment
they put a book down. The date field on every write — `start`, `log-session`,
`finish`, `abandon`, `quiz` — is prefilled with now for convenience but always
editable; the app helpfully fills in the system date, it never requires it.
Nothing breaks doing this: `/api/sessions` orders by `occurred_at`, and
`/api/summary`'s aggregate doesn't care what order events arrived in either.

**Custom books reconcile with the catalog.** `data.books[].catalogId` (§3.1)
already exists and is already nullable — reconciling a custom entry is just
setting it after the fact, from the book's detail screen, once a matching
catalog book exists (freshly added via §4.3, or already there and missed on
search). This needs no server change and does **not** rewrite `scope_id`:
past events keep whatever `bookId` and classification they were written with,
same "renaming doesn't relabel history" rule §4.1 and §4.2 already apply
elsewhere, and events written *after* reconciliation freeze the catalog's
series/genre/gradeLevel like any other event. The book's `id` — and therefore
every already-pushed event's `scope_id` — never moves. The payoff is real
even without touching history: it unlocks the catalog's quiz for a book that
started as a typed-in title, and correct series-progress counting for
everything logged from that point on.

**Genre vocabulary ships as committed** (§4.2's placeholder list). Adding
values later is free; the actual risk was only ever renaming or merging
existing ones after a year of classified reading, so there's no reason to
hold Phase 0b on nailing the taxonomy up front.

**`totalBooks` is maintained by hand, `null` where unknown.** This is already
§4.2's design — Thoroughbred ships with `totalBooks: null`. The only open
question was whether that manual upkeep is worth doing at all; it is: fill it
in for series worth showing a fraction for, leave it `null` (plain count) for
the rest.

**Abandonment gets an explicit kid-facing control.** Not inference, not
parent-side only: a "I quit this book" button on the book's screen, next to
Finish. It writes the same `abandon` event §5 already specifies — this closes
the UI question, not the data model, which was already settled.

**A kid can be reading more than one book at a time.** Nothing in the data
model assumed otherwise — `status` is derived per `bookId` (§3.1: "the latest
`start` with no later `finish`/`abandon` **for the same bookId**"), so two
books independently land on `status: 'reading'` for free. What was implicit
needs to be explicit in two places once it's a stated goal rather than an
accident of the model:

- The "currently reading" screen (§3.1, §5, §6) is a *list*, not a slot. Home
  shows every book with `status: 'reading'`, each with its own Log-a-session /
  Finish / Quit / Quiz actions, and "Start a book" is never blocked by an
  already-active book.
- Any flow that writes to *a* book — logging a session, finishing, quitting,
  taking a quiz — has to know *which* book first. In practice this falls out
  of the UI shape for free: those actions live on a specific book's row or
  detail screen, not behind a single global button, so there's no new
  "which book?" picker to design — the screen the kid is already on answers
  it.

## 10. The bookshelf

Finishing a book used to be the flattest moment in the app: `submitFinish`
wrote the event and dropped the kid back on the same detail screen they came
from, and the only lasting trace was a grey `finished` badge in history. The
quiz, a lesser accomplishment, got a celebration screen. The shelf inverts
that back: a finished book earns a spine, and the spines accumulate.

**Derived, never stored.** A spine is computed from `data.books` at render
time. There is no shelf in the data model, no new field on a book, no new
event mode, and nothing for the sync phases to carry — which is the whole
reason this could land without touching §3. Genre picks a colour family and
a hash of `book.id` pins which variant inside it, so a book keeps the same
spine forever, on every device, without anyone persisting the choice. A book
with no genre (a custom book a parent has not classified yet) falls back to
a neutral grey family rather than being left off.

**Only `finished` books get a spine.** Abandoned books stay in history and
off the shelf. §9 made quitting a book blameless and the shelf is not the
place to reopen that — it is a pile of wins, not a ledger.

**No counters beyond the total.** The caption says how many books are on the
shelf and nothing else: no pace, no goals, no streak, no "behind" state. The
moment a shelf carries a target it stops being a reward, and a kid who is
behind stops opening the app.

**Sizing is art, not data.** Spine height and width come from the sprite the
book was assigned, which gives a roughly 1.9× height spread across the set.
An earlier draft scaled height by `gradeLevel` so that longer books visibly
took more shelf — deliberately dropped, because every catalog entry today
carries the same `'4-6'` band and a custom book carries `null`, so it would
have been dead code dressed up as a rule. Worth revisiting when the catalog
spans real grade bands.
