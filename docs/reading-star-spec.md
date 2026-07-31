# Reading Star — Specification

Status: **Design only. Not built.** This is the plan for a new app, Reading
Star, alongside Spelling Star, Math Star, Geography Star, and Logic Star.

Target files (when built): a new `reading-star-v1.html` (self-contained, same
conventions as the other three apps) and a new static content file,
`reading-catalog.json`. Everything else — sync, the parent dashboard — reuses
existing machinery from `docs/parent-sync-spec.md` with no schema change.

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
*finishing and rating*, and *completing a quiz* are all point-in-time events.
"Currently reading" is just the latest `start` event for a book with no
matching `finish` yet — derived client-side, the same way the dashboard
already derives everything else from an event stream rather than a mutable
row. So Reading Star can be **the third app on the existing append-only sync
path**, not a new one.

Concretely, that means: no new server table, no new endpoint, no schema
migration. `sessions.app = 'reading'` slots in next to `'spelling'` and
`'math'`.

---

## 3. Data model

### 3.1 Local (`localStorage`)

One key per child, `readingstar-<slug>`, same pattern as the other apps:

```js
data.books = [{
  id,            // client-minted uuid — this is the session table's scope_id
  catalogId,     // e.g. "thoroughbred-1"; null for a custom/untracked title
  title, author, series, seriesNumber,
  gradeLevel,    // from the catalog; blank for custom entries
  status,        // 'reading' | 'finished' | 'abandoned'
  startedAt,
  endedAt,       // null while reading
  sessions: [{ at, minutes, pages, note }],   // "I read today" log entries
  rating,        // 1-5, kid-facing; null until finished
  quiz: { attempted, score, total, answeredAt, missed: [questionIndex, ...] }
}]
```

`data.books` is the local source of truth, same role `data.sessions` plays in
Spelling/Math (§3 of the sync spec: local-first, cloud is a mirror).

### 3.2 What gets pushed

Every meaningful action is flattened into its own append-only event and
pushed through the existing `/api/sync`, identical in shape to a Spelling or
Math session row:

| Field | Value |
|---|---|
| `app` | `'reading'` |
| `mode` | `'start' \| 'log-session' \| 'finish' \| 'quiz'` |
| `scope_id` | the book's local `id` |
| `scope_name` | the book's title, frozen at write time (§16.3 of the sync spec — the server groups on this, so it has to be a column, and it already exists) |
| `score` / `total` | quiz score/total when `mode = 'quiz'`; null otherwise |
| `grade` | the catalog's `gradeLevel`, when known — reuses the existing nullable column, no migration |
| `payload` | whatever's specific to the event: rating on `finish`, minutes/pages/note on `log-session`, missed-question detail on `quiz` |

This is why no server change is needed: `scope_id`/`scope_name`/`grade`
already exist on `sessions` (added in Phase 3/§16 for Spelling's list id and
Math's focus area — reading's "book" is a third filling of the same slot),
and `payload` is already an opaque per-app JSON blob the server never parses.

The sync module itself (pairing, push-on-`persist()`, `ackedIds`, retry) is
**pasted in unchanged** from Spelling/Math, per the sync spec's rule that
transport code is identical across apps (§3 rule 5) — only the `app` string
and the `syncState()`/`applyCommand()` seam differ.

---

## 4. Quiz content

The uploaded CSV (`Thoroughbred_Quiz_Books_15.csv`) becomes
`reading-catalog.json`, structured like `spelling-lists.json` — static,
bundled, no build step:

```json
{
  "thoroughbred-1": {
    "series": "Thoroughbred", "seriesNumber": 1,
    "title": "A Horse Called Wonder", "author": "Joanna Campbell",
    "gradeLevel": "4-6",
    "questions": [
      { "q": "What was the name of the Griffen family's own farm...",
        "correct": "Edgardale",
        "wrong": ["Whitebrook", "Townsend Acres", "Saddlebrook"] }
    ]
  }
}
```

Answer order is shuffled at quiz time, not stored pre-shuffled.

Note for planning purposes: the CSV as uploaded only actually contains
books #1–5 of the Thoroughbred series (the "_15" in the filename doesn't
match the row count), so the catalog launches small. This should be a
repeatable **CSV → JSON conversion step**, not a hand-edit, since more series
will get added incrementally over time.

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
- **Take the quiz** (optional, any time after starting, not gated on
  finishing). Multiple choice, one screen at a time, like the other apps'
  quiz-style modes. Writes a `quiz` event with score/total and which questions
  were missed.
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
aggregation mechanism, same `GET /api/sessions` the other cards already use.

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
`set-reading-support-level`, fits that pattern directly — no new channel
needed, just a new command kind (which, per §15.3, is an app-level decision,
not a server change).

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

1. **Phase 0 — the app itself, no sync.** `reading-star-v1.html`:
   catalog + custom books, start/log/finish/rate, optional quiz, CSV export.
   Satisfies the whole request on its own, offline, same as any other app
   before its sync phase.
2. **Phase 1 — sync.** `app = 'reading'` events through the existing pipe
   (§3), a new card in `parent.html`. No schema migration.
3. **Phase 2 — adaptive points.** `readingSupportLevel` command kind (§7),
   `computePoints()`.
4. **Later, ongoing.** Catalog ingestion tooling and expansion beyond the
   Thoroughbred series.

---

## 9. Open questions

- Quiz retakes: allow retaking and keep best score, or one logged attempt per
  book? (Not decided — affects whether `quiz` is a single event or
  append-only like sessions.)
- Whether "abandoned" (started, never finished, no longer active) needs to be
  a status a kid can set themselves, or stays an inferred state (e.g., no
  activity in N days) shown only on the parent side.
