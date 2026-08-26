# Assignment and Targets — Specification

Status: **Step 1 of §17 is built. Steps 2–6 are still design.** This is the
plan for making "assigned" mean something with a quantity and a deadline
attached, and for spanning the apps rather than living inside one.

What has landed: `schema-phase5.sql`, `families.timezone` / `week_start`,
`sessions.local_date`, `GET`/`PUT /api/family/settings`, the plan document
riding down in `/api/sync`'s response, the shared `starplan-<slug>` key in the
three synced apps, the local-date stamp, and the phone-side backfill. Nothing a
parent or child sees has changed except one new card on the Devices screen.

Still to build: a new `today.html` (the kid-facing hub), `functions/api/plan.js`,
the Plan tab in `parent.html`, and the evaluator. Nothing changes in
`geography-star.html` or `logic-star.html` in this phase, and no existing
behavior changes when a family has no plan.

Read `docs/parent-sync-spec.md` first. Section references of the form §15.2
are to that document unless they say otherwise.

---

## 1. Goals

- A parent can say **how much** work a child owes, by type, per day or per
  week, and see whether it happened.
- A parent can assign **a specific piece of work with a deadline** — "the Test
  on list 5.12, by Friday" — and see whether it happened.
- Both of the above span apps, so a week reads as one plan rather than three
  unrelated ones.
- A child can see what they owe and what they have done, on the tablet,
  offline, without a parent present.

### Non-goals

- Blocking, gating, or locking a child out of anything (§8.2).
- Grades, percentages, or scores in any target (§4.4).
- Rollover of unmet targets into the next period (§10.4).
- Notifications, reminders, or anything that pushes to a parent's phone.
- Bringing Geography Star and Logic Star into sync. §14 designs the seat they
  will sit in; this phase does not build it.

---

## 2. What exists today

The raw material, because most of this feature is already sitting in the repo
under other names.

| Piece | Where | What it gives us |
|---|---|---|
| Per-weekday activity gates | `data.schedule` in Spelling and Math — `{practiceEnabled, testEnabled, …}` × 7 | A "what happens on Tuesday" model. On/off, not "how many", and tablet-only |
| Command queue | `commands` / `command_acks`, pulled through `/api/sync` (§15.2) | Delivery to a tablet that may be offline for a week |
| Child-state snapshot | `child_state` (§15.4) | The phone composes against what the tablet actually has |
| Session envelope columns | `app, mode, score, total, occurred_at, grade, scope_id, scope_name` | Enough to evaluate a target without parsing a payload |
| Mode taxonomy with tones | `MODES` in `parent.html` | The cross-app vocabulary, already written |
| "N sessions in the last 7 days", with a per-mode breakdown | `renderChildAppCard()` | The numerator. This spec supplies the denominator |

### 2.1 What "assigned" means right now

`set-active-list` and `set-active-focus` (§15.3) point a child at some work.
That is the whole of it. There is no quantity, no due date, no done-state, and
nothing that spans apps. A parent can say *what* but not *how much* or *by
when*, and cannot say it once for the whole week.

### 2.2 The five apps already share a localStorage namespace

This is load-bearing for §8 and was not obvious, so it is written down rather
than rediscovered.

Every app is a static file served from the same origin, and every profile key
is `<prefix>-<childSlug>`:

| App | Key prefix | History lives in |
|---|---|---|
| Spelling Star | `spellingstar-` | `data.sessions[]` (capped at 300) |
| Math Star | `mathstar-` | `data.sessions[]` (capped at 300) |
| Reading Star | `readingstar-` | `data.events[]`, plus nested copies in `books[]` |
| Geography Star | `geostar-` | `data.sessionLog[]` (capped at 500) |
| Logic Star | `logicstar-` | `data.sessionLog[]` (capped at 500) |

`childSlug()` — lowercase, non-alphanumerics to dashes, trim dashes — is
byte-identical in all five, including the two that inline it rather than
naming it.

So a page at the same origin can read every app's history for one child, with
no sync, no pairing, no backend, and no change to any of the five apps.
`index.html` currently says "Progress is saved on this device only, for each
app" — that "for each app" is a filing convention, not a boundary.

**This is why the two halves of the feature have different coverage.**
Counting all five apps *on the device* is nearly free. Showing all five *to
the parent* costs each of Geography and Logic a sync client. This spec takes
the free half now and specifies the other half in §14.

---

## 3. Architecture principle

Everything in §3 of the sync spec still holds. One sentence is added to it:

> A **record** flows one way, up. An **instruction** flows one way, down. A
> **plan** is an instruction, and progress against it is never stored — it is
> recomputed from records.

The consequence that matters: no client ever reports "I have done 2 of 3."
Both sides count the same sessions with the same rules and arrive at the same
number on their own. There is no progress field to get out of sync, no
reconciliation, and no new upward channel.

---

## 4. The plan item — one primitive for both features

An assignment and a target are the same object at different settings. Building
them as two features would mean two editors, two evaluators, and two ways to
be wrong.

```js
{
  id:     "wk-spell-practice",       // stable across revisions
  label:  "Spelling practice",       // what the child and parent both read
  match:  { app: "spelling", modes: ["practice"], scopeId: null },
  count:  3,
  period: "week"                     // "day" | "week" | { from, to }
}
```

- **A target** is a broad `match` with `count: 3` — "3 Spelling practices a
  week."
- **An assignment** is a narrow `match` with `count: 1` and a dated `period` —
  `{ scopeId: "list-5-12", modes: ["test"], period: { from, to } }` is "the
  Test on list 5.12, by Friday."
- **A cross-app target** omits `app` and matches on tone (§5) — "5 graded
  sittings a week, any app."

### 4.1 A match may only reference envelope columns

`app`, `mode`, `scope_id`, `occurred_at`. Never a payload field.

This is the constraint that makes the rest cheap. It keeps §3 rule 3 intact —
the server still never interprets a payload — and it is why one predicate is
evaluable in three places: as JavaScript on the tablet, as JavaScript in
`parent.html`, and as SQL in a future aggregate. A match on, say, "3 practices
that included the word *rhythm*" would be evaluable in exactly one of those,
and the feature would quietly become two features.

### 4.2 Identity is `id`, not position

A plan item keeps its `id` across revisions, so "she has missed her Friday
test three weeks running" is answerable. Editing an item's `count` is an edit
to that item; deleting and re-adding is a different item that happens to read
the same. This is the same reasoning as §15.3's replace-by-name for lists —
derived identity is what `docs/reading-star-spec-review.md` catches going
wrong three separate times.

### 4.3 Periods

| `period` | Bucket | Reads as |
|---|---|---|
| `"day"` | One local calendar day (§9) | "2 sittings every day" |
| `"week"` | Seven local days from the family's week start (§9.4) | "3 practices a week" |
| `{ from, to }` | An explicit local-date range, inclusive | An assignment with a deadline |

A dated item disappears from the child's view once its `to` has passed. It
stays in the parent's history, where "not done, and the window closed" is the
whole point.

There is deliberately no `"schoolweek"` (Mon–Fri) period. A weekly target is
satisfied by work on any day; whether that includes Saturday is a question
about the family's week, not about the item, and §9.4's `weekStart` already
answers it.

### 4.4 No score floors

`match` has no `minScorePct`, and this is a decision rather than an omission.

"3 drills at 80% or better" shows a child who honestly did three drills a
progress bar reading **0 of 3**. That is precisely the posture
`docs/spelling-star-games.md` §2 rules out — "a game the child can lose is a
game they stop choosing" — and it applies with more force to required work
than to a game. It also creates a quiet incentive to abandon a sitting that is
going badly rather than finish it, which corrupts the very history the parent
is reading.

**Targets count effort. The dashboard already shows quality**, in the same
card, from the same sessions. Nothing is lost by keeping the two apart.

---

## 5. The mode registry

The one piece of genuinely new shared vocabulary. `parent.html`'s `MODES` is
promoted from a badge-labelling table to the registry both sides evaluate
against, and gains one field.

| App | Mode | Tone | Counts as work |
|---|---|---|---|
| spelling | `pretest` | diagnostic | ✓ |
| spelling | `test` | graded | ✓ |
| spelling | `practice`, `repeat` | practice | ✓ |
| spelling | `spotit`, `missing` | play | ✗ |
| math | `drill` | graded | ✓ |
| math | `practice` | practice | ✓ |
| reading | `quiz` | graded | ✓ |
| reading | `log-session` | practice | ✓ |
| reading | `start`, `finish`, `abandon` | lifecycle | ✗ |
| geography | *(9 modes, collapsed to "round")* | practice | ✓ |
| logic | *(4 modes, collapsed to "puzzle")* | practice | ✓ |

Two rules rather than an enumeration, because the enumeration will be stale:

**Tone `play` does not count.** Spelling Star shipped `spotit`, then `missing`,
and `docs/spelling-star-games.md` is a backlog of more. Each arrives as a new
mode with `tone: 'play'`, and each should land in the plan already knowing it
is not homework — without anyone remembering to come back here. A parent who
wants to encourage games can still target them explicitly by naming the mode.

**Tone `lifecycle` does not count.** Reading Star writes a session row when a
book is *started* (§6 of the reading spec). Counting those would make "5
reading sessions a week" satisfiable by opening five books and reading none of
them.

Geography's nine modes and Logic's four are listed now and unused until §14.
They are here so that the model that ships is already the model those apps
slot into, rather than one that has to be reshaped to admit them.

---

## 6. Where the plan lives

A new `plans` table, holding the whole cross-app plan for one child, revised
in place.

### 6.1 Why not the command queue

The queue is right there, and `set-plan` would be a one-line addition to
`COMMAND_KINDS`. It is still the wrong home, for three reasons that are all
the same reason:

**Commands are events; a plan is state.** A command is a thing that happened
once — "assign this list" — and its whole lifecycle is *queued → delivered →
history*. A plan is a document that is edited repeatedly and read back, and
whose current value is the only interesting thing about it.

**Commands are swept after 30 days** (`COMMAND_RETENTION_MS`). "The current
plan is the newest non-canceled `set-plan` command" is a sentence that stops
being true one month after the last edit, silently, at which point every child
has no plan and nobody has changed anything.

**Delivery semantics are wrong in the safe direction.** A command needs a
per-device ack because applying it twice is a real mutation applied twice. A
plan is idempotent desired-state: last-write-wins, and a device that misses a
delivery self-heals on its next sync with no ack bookkeeping at all.

### 6.2 Delivery: a field in the sync response

The plan rides down in `/api/sync`'s response body as a `plan` field, beside
`commands[]`. No new endpoint for the child, no new request, no acks.

```jsonc
// POST /api/sync response
{
  "accepted": ["1737..."],
  "commands": [ /* unchanged */ ],
  "plan": {
    "revision":  7,
    "timezone":  "America/Chicago",   // §9
    "weekStart": 0,
    "items":     [ /* §4 */ ]
  }
}
```

`revision` is a monotonic integer per child. A client stores the plan only if
the incoming `revision` is higher than the one it holds, which makes the write
idempotent and makes two tablets racing harmless.

### 6.3 Revisions are append-only, with an effective date

`plan_revisions` keeps every version with an `effective_from` local date
(§9). Progress is recomputed from history (§10), so without this, editing the
plan on Thursday silently rewrites what Monday's targets were — and "did she
hit her targets in March?" would return a different answer every time the
parent adjusts something.

A revision that takes effect mid-period applies to the period it lands in.
The alternative — deferring to the next period — means a parent who notices on
Tuesday that a target is wrong has to live with it until Sunday.

---

## 7. The shared plan key

Each of the three synced apps writes the **whole** plan document, verbatim, to
one shared localStorage key:

```
starplan-<childSlug>        →  { revision, timezone, weekStart, items[] }
```

Not each app's own slice. This is what lets the plan cover apps that are not
themselves synced: Spelling Star receives the whole document and writes it, so
Reading Star's items — and, later, Geography's — are on the device even if
Reading Star has sync switched off entirely. **The synced apps are the
delivery mechanism for a plan they do not fully own.**

### 7.1 The writer protocol

One shared key across five apps breaks the "each app owns its own keys"
convention, so the rules are narrow and stated:

1. **Highest `revision` wins.** A writer reads the key first and returns
   without writing if the stored `revision` is greater than or equal to its
   own. Two apps receiving the same plan therefore write once between them.
2. **Writers are the three synced apps only.** `today.html` never writes it,
   and neither do Geography or Logic.
3. **The document is stored verbatim.** No app parses items belonging to
   another app, filters the list, or re-serializes it. An app that rewrote the
   document to hold only its own items would destroy the others' the moment it
   synced first.
4. **A malformed or unreadable value is overwritten, not repaired.** The
   authority is the server; the key is a cache.

Each app still filters to its own items *when rendering*. Filtering happens at
read time, never at write time.

---

## 8. `today.html` — the kid's hub

A new page, linked from `index.html`, that answers "what do I owe today?"
across every app.

### 8.1 It is a pure reader

`today.html` makes **no network requests, holds no device token, and writes no
app's data.** It reads `starplan-<slug>` and the five apps' profile keys, and
renders. That invariant removes an entire class of risk — it cannot corrupt a
profile, cannot double-count a session, cannot leak a token, and cannot fail
in a way a child would notice — and it costs nothing, because everything it
needs is already on the device.

It writes exactly one key of its own: `starhub-lastchild`, the remembered
profile choice.

### 8.2 It displays; it never blocks

Every button in every app stays exactly as live as it is today. The hub shows
"Test ○ · 2 of 3 Practice ✓" and nothing more. A child who wants to do a
fourth practice is not stopped, and a child who has finished everything is not
locked out of the apps.

`data.schedule` remains the only thing that gates, and remains a tablet-side
parent setting. The two are different questions and should stay different:
**schedule is what is available today; the plan is what is owed this week.**

### 8.3 Progress is a count and a bar, never a percentage

`docs/math-star-spec.md` §1: kid-facing views never show a percentage or a
grade. `docs/reading-star-spec.md` §4.2 already resolved the same tension the
same way, and noted that a count reads better anyway. "2 of 3" and a bar.

### 8.4 Which child

The union of profile names across all five prefixes, deduplicated by slug.

- Exactly one profile → show it, no prompt.
- More than one → a picker, remembered in `starhub-lastchild`.
- No profiles → a short "open an app first" message, not an error.

No PIN. The hub shows a child their own counts, which they can already see
inside each app; a PIN would make the page useless to the person it is for.

### 8.5 It reads a whitelist of fields

A profile object holds `pin`. The adapters (§8.6) must pull named fields —
`childName`, and the history array's `date` / `mode` / `score` / `total` — and
never spread a whole profile object into a template. This is a one-line rule
that is very easy to violate by accident with an object spread.

### 8.6 Five adapters

One function per app, normalizing that app's history into the common shape
`{ at, app, mode, scopeId }`:

| App | Source | Notes |
|---|---|---|
| Spelling | `data.sessions[]` | `mode` is already the registry's vocabulary |
| Math | `data.sessions[]` | Same |
| Reading | `data.events[]` | Use the flat events array, not the nested copies in `books[]` — the nested ones share their event's id and would double-count |
| Geography | `data.sessionLog[]` | No `mode` in the registry's sense; map every entry to `round` |
| Logic | `data.sessionLog[]` | Map every entry to `puzzle` |

Geography and Logic entries have no session `id`; their `date` (epoch ms) is
the only identity they have. That is sufficient for counting on one device,
and is one of the gaps §14 has to close before those apps can sync.

### 8.7 Geography and Logic appear, uncounted

The parent cannot set targets for those two apps yet (§14), but their history
is sitting in localStorage and the adapters are written either way. The hub
shows them as a plain context line — "also this week: 3 Geography rounds, 2
Logic puzzles" — with no target, no bar, and no judgment.

Showing nothing would make the hub a partial picture of the child's week while
looking like a complete one. When §14 lands, that line gains a denominator and
nothing else changes.

---

## 9. Time

"3 per day" is meaningless without a day boundary, and the system currently
has nowhere to get one. This section closes that.

### 9.1 What is actually stored

A session's instant is exact and unambiguous: the apps write
`new Date().toISOString()` (UTC, with a `Z`), and `/api/sync` stores
`occurred_at` as epoch milliseconds. What is missing is not the instant but the
**calendar day it belongs to**, which depends on a timezone that nothing
records.

### 9.2 D1 cannot compute a local day

This is the hard constraint that decides the design, so it is worth stating
plainly: **SQLite has no IANA timezone database.** `date(x, 'localtime')`
resolves against the host process's own zone, which on Workers is UTC, and the
only other option is a fixed offset — which is wrong for half the year in any
zone that observes DST.

So `GROUP BY` local day is not merely awkward in D1, it is impossible. Any
design that leaves the local date to be derived at query time has quietly
ruled out ever aggregating a target server-side.

### 9.3 The fix: a family timezone, and a stamped local date

Two additions, and they do different jobs.

**`families.timezone`** — an IANA name, the *policy*. Set from the parent
phone at family creation via
`Intl.DateTimeFormat().resolvedOptions().timeZone`, editable afterwards on the
Devices screen. One family, one school day. A family genuinely spanning zones
still gets one answer, which is the correct answer for a homeschool plan.

**`sessions.local_date`** — `YYYY-MM-DD`, the *record*. Computed by the client
at write time, in the family timezone, and stored as its own column.

This is exactly the move §16.3 already made for `grade` and `scope_id`: lift
out of the payload what the aggregate must `GROUP BY`, because the Worker
cannot compute it inside its CPU budget. Here it is stronger — the Worker
cannot compute it at all.

Stamping at write time also handles DST correctly by construction, including
the 23- and 25-hour days, because the conversion happens in a runtime that has
the full timezone database:

```js
// The one helper this adds to each synced app. 'en-CA' formats as YYYY-MM-DD.
function localDate(instant, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(instant);
}
```

### 9.4 Week boundaries

**`families.week_start`** — `0` for Sunday, `1` for Monday. Delivered in the
plan document alongside the timezone.

Once `local_date` exists, a week bucket is pure date arithmetic on a string
with no timezone involved: the most recent `week_start` weekday on or before
that date. Sunday is the default, matching `data.schedule`'s existing
`0 = Sunday` indexing.

### 9.5 Where each side gets its boundary

| Side | Source of truth | Fallback |
|---|---|---|
| Synced app, stamping a session | `timezone` from the plan document | Leave `local_date` null (§9.6) |
| `today.html` | `timezone` from `starplan-<slug>` | The device's own zone |
| `parent.html` | `timezone` from the family record | — |
| A future aggregate query | `local_date`, grouped as a string | — |

`parent.html` uses the *family's* zone, not the phone's. A parent reading the
dashboard from a different timezone should see their child's week, not their
own.

### 9.6 Rows written before this exists

`local_date` is nullable and additive, in the same posture as the §16 grade
columns: nothing breaks, and an old client that never stamps it keeps working.

A null is backfilled **on the client**, by applying the family timezone to
`occurred_at` — which JavaScript can do and SQL cannot. `parent.html` already
downloads 90 days of sessions, so this is free for the window it displays.
Aggregate queries treat null as "before plans," which it permanently is: plans
start now, and no target has ever applied to a session recorded before this
ships.

A tablet that has never received a plan does not know the family timezone and
therefore stamps nothing. That is correct rather than unfortunate — a tablet
with no plan has no target to bucket, and the phone can still backfill.

### 9.7 A wrong clock

A device with a badly wrong clock stamps a wrong `local_date`, permanently,
and the phone's backfill cannot fix it because `occurred_at` came from the
same wrong clock. This is not a new exposure — every session's `date` already
comes from the client, which is why `received_at` exists as clock-skew
insurance — and it is not worth engineering against here. Worth one sentence
in §15's risks, not a mechanism.

---

## 10. Evaluation

### 10.1 Progress is a query, not a table

The same argument §16.2 makes for grades, and it applies more strongly here:
progress against a target is a `COUNT` over rows already stored, it is cheap,
and a stored counter is a second source of truth that can drift from the first
with nothing to reconcile it.

It also means any past period is answerable retroactively — which is exactly
why plan revisions carry an `effective_from` (§6.3).

### 10.2 The evaluator

One pure function, in three copies, per §3 rule 5's existing precedent for the
sync module:

```js
// sessions: normalized { at, localDate, app, mode, scopeId, deviceId, id }
// returns  { done, count, met }
function evaluateItem(item, sessions, { timezone, weekStart, now })
```

It must **deduplicate on `(deviceId, sessionId)`** before counting. A merged
child holds the same sitting under more than one `childId` (§6.2), and
`/api/summary`'s inner `DISTINCT` exists for precisely this reason. Without it
a re-push under an adopted id inflates every count, and a child appears to have
met a target they did not.

`today.html` has no `deviceId` — everything it reads is by definition from one
device — so it deduplicates on session id alone.

### 10.3 Guard the copies with a test

The evaluator will be the fourth, fifth and sixth copy of a hand-duplicated
function, after the sync module. Add a suite that extracts the function body
from each file and asserts they are byte-identical. Drift between copies of an
evaluator is exactly the silent-wrongness the existing suites were written to
catch (`tests/README.md`, "Why these tests exist") — the app keeps working and
quietly counts differently.

### 10.4 No rollover, and no pacing judgment

An unmet period simply ends. Nothing carries forward, and nothing is written
down: the sessions are still there, so "she missed her Friday test three weeks
running" stays answerable without a `missed` record existing anywhere.

Mid-period, both surfaces show the count and the days remaining — "1 of 5,
4 days left" — and neither renders a judgment until the period closes. A red
badge on Monday morning for every weekly target is a badge everyone learns to
ignore by Wednesday.

---

## 11. What the parent sees

A new **Plan** tab in `parent.html`, beside Dashboard / Years / Assign /
Devices.

- **Editing.** One screen per child, items grouped by app, composed against
  `child_state` (§15.4) so a `scopeId` assignment offers the lists and focus
  areas the tablet actually has. Same argument as §15.4: no second copy of any
  app's data model.
- **Progress.** Computed from the sessions the dashboard already downloads.
  No new endpoint, no new request.
- **Only the three synced apps appear** (§14). An item for an app the phone
  cannot verify would be a row that never fills in.
- **Copy from a sibling.** Most families want one plan with small per-child
  differences. A copy button is a few lines and avoids re-composing a plan by
  hand.
- **Delivery status**, reusing the queue card's existing shape: which devices
  hold which `revision`, derived from `plan_state` (§12).

---

## 12. Data model

`schema-phase5.sql`, and the same statements folded into `schema.sql` so a
fresh deployment needs only that file — the convention `schema-phase3.sql` and
`schema-phase4.sql` already follow. Purely additive.

```sql
-- The current plan for one child, as a document. Parent-owned state (§3):
-- an instruction, not a record, which is why it may live server-side without
-- inverting the one-way rule.
CREATE TABLE plans (
  child_id    TEXT PRIMARY KEY REFERENCES children(id),
  family_id   TEXT NOT NULL REFERENCES families(id),
  revision    INTEGER NOT NULL,
  items       TEXT NOT NULL,        -- JSON, §4
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL REFERENCES devices(id)
);

-- Every version, so a past period evaluates against the plan that was in
-- force (§6.3). Append-only, like sessions and commands.
CREATE TABLE plan_revisions (
  child_id       TEXT NOT NULL REFERENCES children(id),
  revision       INTEGER NOT NULL,
  items          TEXT NOT NULL,
  effective_from TEXT NOT NULL,     -- local date, YYYY-MM-DD (§9)
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL REFERENCES devices(id),
  PRIMARY KEY (child_id, revision)
);

-- Which revision each device holds, for the delivery status in §11. Written
-- by /api/sync from the client's reported planRevision; not an ack, because
-- a plan needs none (§6.1).
CREATE TABLE plan_state (
  child_id    TEXT NOT NULL REFERENCES children(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  revision    INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (child_id, device_id)
);

-- §9.3, §9.4. Nullable: a family created before this ships has no timezone
-- until a parent phone sets one, and the Plan tab asks for it before it will
-- accept a day-period item.
ALTER TABLE families ADD COLUMN timezone   TEXT;
ALTER TABLE families ADD COLUMN week_start INTEGER NOT NULL DEFAULT 0;

-- §9.3. Nullable and additive, exactly like the §16 grade columns: an old
-- client that never stamps it keeps working, and null reads as "before plans".
ALTER TABLE sessions ADD COLUMN local_date TEXT;
CREATE INDEX idx_sessions_local_date ON sessions(child_id, app, local_date);
```

### 12.1 API

Two new endpoints, both parent-role, plus additive fields on `/api/sync`.

| Endpoint | Auth | Body / query | Role |
|---|---|---|---|
| `GET /api/plan` | token | `?childId=` → `{ revision, items, timezone, weekStart }` | parent |
| `PUT /api/plan` | token | `{ childId, items, effectiveFrom }` → `{ revision }` | parent |

`PUT` allocates the next `revision` server-side rather than accepting one from
the client, which makes two phones editing concurrently resolve to
last-write-wins instead of to a silently lost edit.

Family timezone and week start are set through `PUT /api/family/settings` or
folded into the existing devices screen — either is fine; the requirement is
only that a parent-role token is what changes them.

`/api/sync` gains, in the request, an optional `planRevision` (what this
device holds) and `localDate` on each session; in the response, the `plan`
field (§6.2). Every one is optional, so a Phase 1 client is unaffected — the
same compatibility posture §15.2 took.

**Authorization is unchanged**, which is the point of §6.5 being stated as an
invariant: both handlers resolve `family_id` from the bearer token, and a
`childId` from another family matches nothing rather than 403-ing.

---

## 13. What each file changes

| File | Change | |
|---|---|---|
| `schema-phase5.sql`, `schema.sql` | §12 | ✅ |
| `functions/api/family/settings.js` | New. `GET` / `PUT` — the family clock | ✅ |
| `functions/api/sync.js` | Store `local_date`; upsert `plan_state`; return `plan` | ✅ |
| `functions/api/sessions.js` | Return `local_date`, so the phone knows what to backfill | ✅ |
| `functions/api/family.js` | Accept `timezone` and `weekStart` at creation | ✅ |
| `sw.js` | `CACHE_VERSION` bump | ✅ |
| `functions/api/plan.js` | New. `GET` / `PUT` | |
| `parent.html` | Family timezone setting ✅; Plan tab, `MODES` gains `countsAsWork`, the evaluator | partly |
| `spelling-star-v6_3.html`, `math-star-v6_1.html`, `reading-star-v1.html` | Store the plan to the shared key (§7) ✅; stamp `localDate` ✅; report `planRevision` ✅; show their own items on the home screen | partly |
| `today.html` | New (§8) | |
| `index.html` | A link to it | |
| `sw.js` | Cache `today.html` | |
| `tests/` | The §10.3 drift test ✅ (`shared-code.test.mjs`); Phase 5 API + tablet coverage ✅; plan API; a `today.html` suite | partly |

Untouched: `geography-star.html`, `logic-star.html`.

---

## 14. Geography and Logic

They are absent from §11's editor and present in §5's registry and §8.7's
context line. That split is deliberate and this section is the seat they will
sit in.

§2.1 of the sync spec excluded them because their history holds no per-item
detail, so trouble spots — the point of the dashboard — cannot be built from
it. **That objection does not touch counting.** Their `sessionLog` entries are
`{date, mode, region/level, correct, total}`, which is already the shape of an
envelope row with an empty payload. Bringing them in needs no second sync
mechanism and no new conflict semantics: it is the same append-only pipeline.

What it costs, and why it is not in this phase:

1. The sync module and the pairing UI in each app — the Phase 1 client work,
   twice.
2. A stable per-session `id`. Both apps push `{date: Date.now(), …}` with no
   id, so `date` would have to become the identity, or an id added.
3. A `sessionScope()` branch each in `sync.js`, and a `MODES` entry each in
   `parent.html`.
4. A decision about their nine and four modes: collapse to one countable unit
   each (§5), or expose them individually and let a parent target "3 capitals
   rounds a week."

When it lands, the plan model does not change. An app id becomes selectable in
the editor, §8.7's context line gains a denominator, and nothing else moves.

---

## 15. Risks and open questions

- **A wrong device clock** stamps a permanently wrong `local_date` (§9.7).
  Accepted; the same exposure `received_at` already documents.
- **The hub identifies a child by slug; the dashboard identifies them by
  merged `childId`.** Rename a child in one app and the hub sees two children
  where the dashboard sees one. The apps already have this property; the hub
  makes it visible. A rename that changes the slug is worth a warning in the
  app that does it.
- **The hub sees one device.** A child working on two tablets sees a low count
  on each; the dashboard shows the true total. Worth a line of copy on the
  hub rather than a mechanism.
- **Reading Star backdating.** A kid can log a session with a past `dateISO`,
  so a closed week's target can be satisfied after the fact. Probably correct
  behavior — the reading did happen — but it means a period is never truly
  final. Decide before building the parent's "missed" display.
- **Minutes are not a unit here.** "20 minutes of reading a day" is the target
  a reading family will ask for first, and `minutes` lives in the payload, so
  §4.1 rules it out. The honest paths are a generic `quantity` envelope
  column, or accepting that minute targets are evaluable on the device and the
  phone but not in an aggregate. Deferred, not dismissed.
- **`data.schedule` is still tablet-only.** A parent sets targets on the phone
  and then walks to the tablet to turn Tuesday's test off. A `set-schedule`
  command kind is roughly ten lines per app and belongs with this work; it is
  listed here rather than in §13 because it is adjacent, not required.

---

## 16. What this owes Phase 2

Following §15.7's precedent of writing down what a phase hands to the
encryption work that has not landed yet.

- **`plans.items` holds parent-authored labels**, and a `scopeId` assignment
  can carry a list name. Same class of data as `sessions.payload`; it should
  ride the same envelope-plus-ciphertext treatment when §10 lands.
- **`sessions.local_date` is deliberately plaintext.** It is an index, not
  content, and encrypting it would re-create the §9.2 problem it exists to
  solve. It widens what the server sees by exactly one fact — which calendar
  day a child worked — and that belongs in the privacy note rather than being
  quietly assumed.
- **`families.timezone` is plaintext** and is approximately a coarse location.
  Small, but it is the first such field, and it should be named in §10's list
  rather than discovered there.
- **The §10 "delete everything" one-tap** must also clear `plans`,
  `plan_revisions`, and `plan_state` — the same debt §15.7 already records for
  `commands`, `command_acks`, and `child_state`. That button still does not
  exist.

---

## 17. Build order

Each step is useful on its own and shippable without the next.

1. **Timezone and `local_date`** (§9, §12). ✅ **Built.** The migration, the
   family timezone setting, the stamp in three apps, the client-side backfill.
   Nothing visible changes; everything after this depends on it.

   One thing moved forward from step 4 while building it, because the order
   above could not be followed as written: §9.5 makes the tablet's timezone
   come *from the plan document*, so "the stamp in three apps" cannot work
   until the document is being delivered. Step 1 therefore ships the delivery
   pipe — `/api/sync` returns `plan`, and the three apps write it verbatim to
   the shared key under §7.1 — with `items` always empty and `revision` always
   `0`. Step 3 needs the same thing anyway (§9.5 gives `today.html` the same
   source), so the pipe was going to precede step 4 regardless.

   Revision `0` is deliberately below every revision `PUT /api/plan` will
   allocate, so the placeholder can never overwrite a real plan under §7.1's
   highest-revision-wins rule. What is left for step 4 is rendering items and
   nothing else.

   Two smaller things also landed here rather than later, because they are
   edits to handlers this step already touches: `plan_state` is written from
   the client's reported `planRevision` (§12 assigns it to `sync.js`), and
   `/api/sessions` returns `local_date` so the phone can tell which rows still
   need backfilling.
2. **Plan model and the Plan tab** (§4, §6, §11), parent-side only. Progress
   computed from sessions already downloaded. No tablet changes at all — which
   is the point: you find out whether these are the right targets before a
   child ever sees one.
3. **`today.html`** (§8). Reader-only, five adapters. Works against local
   history before any plan exists, so it is useful the day it ships.
4. **Delivery** (§6.2, §7). The sync response carries `plan`; the three apps
   write the shared key and show their own items. The hub gains denominators.
5. **Dated assignments** (§4.3) and delivery status (§11), reusing the queue
   card.
6. **Geography and Logic** (§14), if and when their counts are wanted on the
   phone.
