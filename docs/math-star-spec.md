# Math Star — Specification

Status: **v6.1 shipped (12 categories, mastery grid, rounding subgroup
prototype, review/graduation with resurfacing, parent dashboard, CSV export).
v6.2 (Phase A, §5) shipped: N-field numeric widget, options-driven choice
widget, decimal numpad key (unused so far), `promptText`/`formatAnswer()`,
object-aware `answerSig()`, `strand`/`reviewable` on `CATS`, full problem
descriptors in review/graduated entries with a migration for pre-existing
numeric2 entries, and subgroup `defaultRequired`. No new categories yet and no
visible behavior change — see §5 and the changelog (§13). §6 onward (the
fractions/decimals/percentages categories themselves, v6.3/v6.4) is not yet
implemented.**

Target file: `math-star-v6_1.html` (self-contained, alongside Spelling Star and
Geography Star)

---

## 1. Goals

Extend Math Star past whole-number arithmetic into the three strands that
follow it in a typical grade 3-6 sequence: fractions, decimals, and
percentages. Serve them through the same category/focus-area/mastery machinery
that already exists, rather than bolting on a parallel system.

Design constraints inherited from the existing app, all of which hold here:

- Single self-contained HTML file, no build step, no network dependency
- `localStorage` per child profile, parent-gated by PIN
- Kid-facing views never show a percentage or a grade
- Practice allows retries and is low-stakes; **only Drill moves mastery**
- New fields are added tolerantly in `load()`; an older profile must always
  open without losing progress

### Non-goals

- Negative numbers, exponents, algebra, ratios/proportions as a strand
- Fraction arithmetic (adding, subtracting, multiplying, dividing fractions).
  This spec covers *fraction sense* — simplifying, mixed numbers,
  equivalence. Arithmetic is a later strand that builds on it.
- Word problems in any strand
- Any change to the Practice/Drill session loop, scheduling, or profile model

---

## 2. Current architecture (v6.1)

A "mode" in Math Star is an entry in `CATS` plus four things behind it. Adding
a mode means answering four questions:

| Axis | Where it lives | v6.1 options |
|---|---|---|
| **Generation** | `gen*()` + `buildProblem()` switch | one function per category |
| **Answer widget** | `p.type`, `renderProblem()` | `numeric`, `numeric2`, `comparison` |
| **Mastery model** | `GRID_CATS` / `SUBGROUP_CATS` / fallback | heatmap, subgroups, flat accuracy |
| **Review policy** | `GRID_CATS` gate in `finishSession()` | bounded fact spaces only |

### 2.1 Category metadata

`CATS` is a flat list of `{ id, label, band, widget }`. `band` is a display-only
grade-range string. A **focus area** is a named set of one or more category ids;
a mixed focus shuffles categories problem-by-problem within one session.

### 2.2 Problem descriptor

`buildProblem()` returns `{ key, prompt, answer, category, type, subgroup? }`.

- `key` — stable identity for a specific fact. Used for in-session
  de-duplication (`buildUniqueProblem`) and as the review-pool identity.
- `prompt` — injected as **raw HTML** on the problem screen for `numeric` and
  `numeric2`, but **escaped** for `comparison`, in session detail, and in
  review chips. This inconsistency is a latent bug today (multiplication's
  `&times;` renders literally as `5 &times; 3` in session history) and becomes
  a blocker for fractions — see §7.3.
- `answer` — `number` for `numeric`, `{ q, r }` for `numeric2`, a `<`/`=`/`>`
  string for `comparison`.

### 2.3 Mastery models

Three, picked by `renderCategoryBodyHtml()`:

1. **Heatmap** (`GRID_CATS`) — bounded fact spaces only: addition, subtraction,
   multiplication, division facts. A per-fact streak in `data.masteryGrid`,
   keyed `"{cat}::{row}-{col}"`. A miss zeroes the streak.
2. **Subgroups** (`SUBGROUP_CATS`) — the rounding prototype. Named
   subcategories, each with its own streak in `data.subgroupMastery`, keyed
   `"{cat}::{subgroupId}"`, and its own configurable goal in
   `data.subgroupMasteryRequired[cat][subId]`. **A miss halves the streak
   rather than zeroing it**, because these are freshly generated problems, not
   one specific fact.
3. **Flat accuracy** — the fallback for everything else. Honest but not
   motivating; the progress bar has no bounded total.

### 2.4 Review pool and graduation

Drill-only. A missed fact enters `data.reviewFacts`; first-try-correct answers
build its streak; at the category/subgroup goal it moves to `data.graduated`,
and after N further Drill sessions in that category it resurfaces back into
review.

**This is gated on `GRID_CATS` in two places**, and both matter for §6:

- `finishSession()` only banks a missed fact if `GRID_CATS[r.category]`
- `load()` **prunes** any `reviewFacts`/`graduated` entry whose category isn't
  in `GRID_CATS`

The second one is the dangerous one: an open-ended category that banks review
facts without updating the prune would have them deleted on the next page load.

---

## 3. What the new strands need that v6.1 doesn't have

| Need | v6.1 status |
|---|---|
| Numerator/denominator entry | No widget; `numeric2` is hardcoded to quotient+remainder |
| Whole + fraction entry (mixed numbers) | No widget |
| Decimal point on the numpad | Digits only |
| Multiple choice with arbitrary options | `comparison` is a fixed 3-button `<`/`=`/`>` row |
| Answers that are objects, displayed as text | `String(answer)` → `[object Object]` in history and reveal |
| Answer spacing for object answers | `answerSig()` falls through to `String()` — every fraction collides into one bucket |
| Review pool for a non-heatmap category | Blocked, and actively pruned |
| Review entries that can re-render a choice/multi-field problem | Only a 6-field subset is persisted |
| A category list that stays browsable past ~20 entries | Flat checkbox list in a 220px scroll box |

None of these is deep. All of them are load-bearing, which is why §5 does them
first, alone, with no new modes attached.

---

## 4. Strand overview

Eight new categories in three strands. Each one is subgroup-mastered — none
falls back to flat accuracy.

**Fractions** (band 3-5)

| id | label | widget | subgroups |
|---|---|---|---|
| `fraction-simplify` | Simplify fractions | `fields[n,d]` | `factor-2`, `factor-3`, `factor-4`, `factor-5` |
| `fraction-mixed` | Mixed numbers | `fields[w,n,d]` / `fields[n,d]` | `improper-to-mixed`, `mixed-to-improper` |
| `fraction-equivalent` | Equivalent fractions | `choice` / `numeric` | `choose-equivalent`, `missing-part` |

**Decimals** (band 4-5)

| id | label | widget | subgroups |
|---|---|---|---|
| `decimal-place-value` | Decimal place value | `numeric` +decimal | `tenths`, `hundredths`, `thousandths` |
| `decimal-compare` | Comparing decimals | `choice` | `same-places`, `ragged`, `with-wholes` |
| `decimal-arithmetic` | Decimal add & subtract | `numeric` +decimal | `add-tenths`, `add-hundredths`, `subtract` |

**Percentages** (band 5-6)

| id | label | widget | subgroups |
|---|---|---|---|
| `percent-of-number` | Percent of a number | `numeric` | `benchmark`, `multiples-of-10`, `any-percent` |
| `percent-convert` | Percent conversions | `numeric` / `fields[n,d]` | `percent-to-decimal`, `decimal-to-percent`, `percent-to-fraction`, `fraction-to-percent` |

This takes `CATS` from 12 to 20, so it also adds a `strand` field for grouping
headers in the focus-area picker and the Mastery dropdown (§5.6).

`percent-convert`'s `percent-to-fraction` subgroup deliberately reuses the
fraction widget *and* the simplest-form rule from `fraction-simplify` — 40% is
`2/5`, not `40/100`. That cross-link is the reason percentages ship after
fractions rather than alongside them.

---

## 5. Phase A — plumbing (v6.2, no new modes)

Ships with **zero user-visible change**. The acceptance criterion is that
division facts and comparing numbers behave identically to v6.1.

### 5.1 Generalize `numeric2` → N-field numeric

Replace `S.typedQ` / `S.typedR` / `S.activeField` with a field descriptor on the
problem and a keyed map in session state:

- Problem gains `fields: [{ id, label }]`
- Session state holds `S.fields = { [id]: "" }`, `S.activeField = fields[0].id`
- `kbType` / `kbBack` / `kbClear` / `setField` / `submitNumeric` operate on the
  active field id; submit requires every field non-empty
- Division facts declare `fields: [{id:"q",label:"Quotient"}, {id:"r",label:"Remainder"}]`
  and keep `type: "numeric2"` as an accepted alias, so stored sessions and
  review entries from v6.1 still render

Layout is per-widget: `numeric2` keeps the side-by-side boxes; the fraction
layout stacks numerator over denominator with a rule between; mixed numbers put
a whole-number box to the left of a stacked pair.

### 5.2 Generalize `comparison` → `choice`

`comparison` is already a fixed multiple choice. Give the problem an `options`
array; comparing-numbers declares `options: ["<", "=", ">"]` and is otherwise
unchanged. Options render as buttons, are shuffled per problem where order
isn't semantic (i.e. everywhere except `<`/`=`/`>`), and carry HTML labels so
fraction options can display stacked.

### 5.3 Decimal key on the numpad

`numpadHtml()` gains an `allowDecimal` flag, sourced from the problem. The `.`
key is disabled once the active field already contains one. Existing categories
pass `false` and are unaffected.

### 5.4 Text rendering: `promptText` and `formatAnswer()`

Two helpers, applied everywhere a problem or answer is shown outside the
problem screen:

- Problems gain `promptText` — plain text, no markup — used by session detail
  (`:820`), review chips (`:1384`), and CSV. `prompt` stays HTML and stays raw
  on the problem screen. Generators supply both.
- `formatAnswer(item)` returns a display string per answer shape: `12`,
  `4 r2`, `3/4`, `2 1/3`, `0.45`, `>`. Replaces the hardcoded `q r` reveal at
  `:1020` and the `String(r.answer)` at `:821`.

This also fixes the existing `&times;`-renders-literally bug as a side effect.

### 5.5 `answerSig()` for object answers

Extend to canonicalize every answer shape to a string — `{n,d}` → `"n/d"`,
`{w,n,d}` → `"w n/d"`, choice → the option value. Without this,
`orderNoAdjacentAnswers()` buckets every fraction problem together and the
no-two-identical-answers-in-a-row spacing silently stops working.

### 5.6 `CATS` gains `strand` and `reviewable`

- `strand` — display-only grouping (`"Whole numbers"`, `"Fractions"`,
  `"Decimals"`, `"Percentages"`). Existing categories get `"Whole numbers"`.
  Used for headers in the focus-area checkbox list (`:1434`) and `<optgroup>`
  in the Mastery dropdown (`:1325`).
- `reviewable` — replaces the `GRID_CATS` gate on the review pool, in **both**
  `finishSession()` and the `load()` prune at `:396-397`. All four heatmap
  categories get `reviewable: true`, so behavior is identical at this stage.

### 5.7 Full problem descriptor in review and graduated entries

`reviewFacts` and `graduated` currently store
`{key, category, subgroup, prompt, answer, type}`. A resurfaced `choice`
problem would have lost its `options`, and a multi-field problem its `fields`,
so it couldn't render. Persist the whole descriptor instead of a subset.

`load()` must tolerate old entries missing `fields`/`options`: for a
`numeric2`-typed entry, synthesize the quotient/remainder fields; drop any
entry it can't reconstruct rather than rendering a broken problem.

### 5.8 Subgroup goal defaults

`freshData()` hardcodes rounding's seed at `:305`, and both `subgroupRequired()`
(`:186`) and the `load()` migration (`:361`) fall back to a literal `30`. Move
the default onto the subgroup definition itself as `defaultRequired`, so each
subgroup carries its own sensible goal. Rounding's five subgroups declare `30`
and nothing about existing profiles changes.

---

## 6. Phase B — fractions (v6.3)

### 6.1 `fraction-simplify`

Generated **by construction**, never by searching for a common factor: pick the
answer first, then scale it up.

- Pick `d₀ ∈ 2..12`, `n₀ ∈ 1..d₀-1` with `gcd(n₀, d₀) = 1`
- Pick `k` from the subgroup (`factor-2` → 2, … `factor-5` → 5)
- Present `(n₀·k) / (d₀·k)`; the answer is `{ n: n₀, d: d₀ }`

Because `n₀/d₀` is already in lowest terms, the presented fraction's GCF is
exactly `k` — so the subgroup label is a true statement about the problem, and
"simplify by a factor within 5" is enforced rather than hoped for.

- Prompt: "Write ⁸⁄₁₂ in simplest form."
- `promptText`: `Write 8/12 in simplest form.`
- Key: `simp-8/12`
- Bounds: `d₀ ≤ 12` and `k ≤ 5` cap the denominator at 60
- Constraint: `d₀ ≥ 2` always, so the answer never wants a bare whole number
  the widget can't express

### 6.2 `fraction-mixed`

Two subgroups, one shared triple `(w, n, d)` with `gcd(n, d) = 1`, `n < d`,
`w ∈ 1..9`, `d ∈ 2..12`. The fraction part is always already in lowest terms —
this category tests conversion, not simplification.

**`improper-to-mixed`** — present `(w·d + n) / d`, answer `{ w, n, d }`.
Prompt: "Write ²³⁄₅ as a mixed number." Key: `imp-23/5`.

**`mixed-to-improper`** — present `w n/d`, answer `{ n: w·d + n, d }`.
Prompt: "Write 4 ³⁄₅ as an improper fraction." Key: `mix-4_3/5`.

### 6.3 `fraction-equivalent`

Base fraction `n₀/d₀` in lowest terms, `d₀ ∈ 2..10`, `n₀ < d₀`. The correct
equivalent is always `(n₀·k)/(d₀·k)` for `k ∈ 2..5` — **never a larger
scaling**. For `1/5` the correct option is one of `2/10`, `3/15`, `4/20`,
`5/25`; `25/125` is out of scope by construction.

**`choose-equivalent`** — `choice` widget, exactly one correct option and three
incorrect ones. The teaching value is in the distractors, so they are
error-shaped rather than random:

| Distractor | Misconception it targets |
|---|---|
| `(n₀+k)/(d₀+k)` | Adding to both parts instead of multiplying |
| `(n₀·k)/d₀` | Scaling the numerator only |
| `n₀/(d₀·k)` | Scaling the denominator only |
| `(n₀·j)/(d₀·k)`, `j ≠ k`, both in 2..5 | Using two different factors |

Generate candidates, then **reject any candidate `a/b` where `a·d₀ = n₀·b`** —
a distractor must never be accidentally equivalent (e.g. `(n₀+k)/(d₀+k)` is
equivalent when `n₀ = d₀`, which the `n₀ < d₀` rule already excludes, but the
check is cheap and guards future edits). Dedupe, take three, shuffle all four
positions. Key: `eqv-1/5-x3`.

**`missing-part`** — `numeric` widget, single blank. "³⁄₄ = ▢⁄₁₂" or
"³⁄₄ = ⁹⁄▢", blank side chosen at random, `k ∈ 2..5`. Key:
`eqvm-3/4-x3-num`.

### 6.4 Mastery and review for fractions

All three categories are `reviewable: true`. Their keys are stable and their
descriptors fully re-renderable, and a missed `8/12` is a genuinely reusable
fact worth resurfacing.

---

## 7. Phase C — decimals and percentages (v6.4)

### 7.1 `decimal-place-value`

Mirrors the existing whole-number `place-value` generator on the other side of
the point. Subgroup sets the depth: `tenths` → 1 place, `hundredths` → 2,
`thousandths` → 3.

"In 3.472, what is the value of the digit 7?" → `0.07`. Key: `dpv-3.472-2`.

### 7.2 `decimal-compare`

`choice` with `["<", "=", ">"]`, reusing the generalized comparison widget.

- `same-places` — equal decimal places, straightforward
- `ragged` — unequal places. **At least half of these must have the *shorter*
  number be the larger one** (0.5 vs 0.45), which is the entire point of the
  subgroup: it defeats "more digits means bigger."
- `with-wholes` — non-zero whole parts on both sides

### 7.3 `decimal-arithmetic`

Two-place addition and subtraction, money-shaped. Compute in scaled integers,
never in floats (§9.2). Subtraction always yields a non-negative result.
Subgroups: `add-tenths`, `add-hundredths`, `subtract`.

### 7.4 `percent-of-number`

Answers are always whole numbers; the base is chosen to guarantee it.

- `benchmark` — `p ∈ {10, 25, 50, 75, 100}`, base divisible by 4 and 10
- `multiples-of-10` — `p ∈ {10, 20, …, 90}`, base a multiple of 10
- `any-percent` — `p ∈ 1..99`, base a multiple of 100

"What is 25% of 80?" → `20`. Key: `pct-25-80`.

### 7.5 `percent-convert`

- `percent-to-decimal` — 45% → `0.45` (`numeric` + decimal key)
- `decimal-to-percent` — 0.6 → `60` (`numeric`)
- `percent-to-fraction` — 40% → `{n:2, d:5}` (fraction widget, **simplest form
  required**, §9.1)
- `fraction-to-percent` — ³⁄₄ → `75` (`numeric`); denominators restricted to
  divisors of 100: 2, 4, 5, 10, 20, 25, 50

Decimals and percentages are **not** `reviewable`. Their key spaces are
effectively unbounded (`decimal-arithmetic` alone has millions of distinct
keys), so a review pool would accumulate one-off facts a child will never see
again and crowd out the fresh problems. Their progress lives entirely in
subgroup mastery, which is the right granularity for a generated-problem
category.

---

## 8. Mastery goals

Rounding's goal of 30 suits a category whose problems are endlessly generated
and individually easy. The new subgroups are harder per problem and there are
more of them, so 30 across the board would be a slog. Defaults, all
parent-adjustable per subgroup on the Mastery tab exactly as rounding is today:

| Subgroup | Default | Rationale |
|---|---|---|
| `fraction-simplify` × 4 | 12 | Four subgroups; 48 clean Drill answers to master the category |
| `fraction-mixed` × 2 | 12 | |
| `fraction-equivalent` / `missing-part` | 15 | Free-entry, but a narrow answer space |
| `fraction-equivalent` / `choose-equivalent` | **20** | 1-in-4 guessing inflates a streak |
| `decimal-place-value` × 3 | 12 | |
| `decimal-compare` × 3 | **15** | 1-in-3 guessing |
| `decimal-arithmetic` × 3 | 12 | |
| `percent-of-number` × 3 | 12 | |
| `percent-convert` × 4 | 12 | |

**Multiple choice stays in Drill** rather than being Practice-only. Excluding
it would mean a category the child can practice but never make progress in,
which reads as broken. The guessing risk is handled three ways instead: four
options rather than three, the higher streak goal above, and error-shaped
distractors — a child guessing their way through `choose-equivalent` will still
land on the additive-error distractor often enough to leave a visible signal in
the parent's results view.

The halve-on-miss rule inherited from the subgroup model matters more here than
it did for rounding: with a goal of 20, zeroing on a single slip would make
`choose-equivalent` feel unwinnable.

---

## 9. Answer checking

### 9.1 Form matters, not just value

`checkAnswer()` compares with `Number()` today. Fractions need **exact
canonical-form** comparison, not cross-multiplication:

- `fraction-simplify` — `4/6` must be **wrong** for "simplify 8/12". Accepting
  any equivalent fraction would defeat the exercise entirely.
- `percent-to-fraction` — same rule: `40/100` is wrong, `2/5` is right.
- `fraction-mixed`, `missing-part` — exact match on the expected shape.

Each problem carries a `strictForm` flag so the rule is explicit per generator
rather than implied by category.

### 9.2 Near-miss feedback

Because "right value, wrong form" is now a distinct outcome, it deserves a
distinct response. Problems may declare a `nearMiss(given)` hook returning a
hint string:

- Equivalent but not simplified → "That's the same amount — but it can go
  smaller."
- Correct fraction part, wrong whole number → "The fraction part is right —
  check the whole number."

Shown **in Practice only**. Drill stays one-shot and silent, as it is today.

### 9.3 Float safety

Never compare decimals with `===`. Scale both sides to integers by the
problem's decimal depth and compare those. `0.1 + 0.2 !== 0.3` would otherwise
mark a correct answer wrong in `decimal-arithmetic`, and the failure would be
rare enough to look random to a parent.

Decimal generators must also avoid producing non-terminating values —
`fraction-to-percent` restricting denominators to divisors of 100 is an
instance of this rule, not a coincidence.

---

## 10. Data model and migration

No stored shape is removed or repurposed. Every change is additive.

| Change | Phase | Migration |
|---|---|---|
| `CATS` gains `strand`, `reviewable` | A | Code-only; no stored data |
| Problem gains `fields`, `options`, `promptText`, `strictForm` | A | Code-only for fresh problems; see below for stored ones |
| Review/graduated store full descriptor | A | Old 6-field entries: synthesize `fields` for `numeric2`, drop anything unreconstructable |
| Review-pool gate moves from `GRID_CATS` to `reviewable` | A | **Must land before Phase B**, in `finishSession()` *and* the `load()` prune at `:396-397` |
| Subgroup `defaultRequired` replaces the literal `30` | A | Rounding declares 30; existing profiles unchanged |
| `freshData()` seeds all of `SUBGROUP_CATS` | A | Generalize the rounding-only line at `:305` |
| 8 new `CATS` entries + their `SUBGROUP_CATS` | B, C | The `load()` loop at `:356` already seeds new subgroups generically |

Existing profiles need no explicit upgrade step: category-keyed maps
(`categoryStats`, `subgroupMastery`, `subgroupMasteryRequired`) are populated
lazily, and the migration loop at `:356-364` already handles subgroups that
didn't exist when a profile was created.

`resetProfile()` already preserves `subgroupMasteryRequired` generically and
needs no change.

**CSV export** keeps its current column shape through all three phases. Adding
a subgroup column would break any spreadsheet a parent has already built
against it; if it's wanted, it should be a deliberate, separately versioned
change.

---

## 11. Rollout

| Version | Contents | Acceptance |
|---|---|---|
| **v6.2** | §5 in full. No new categories. **Shipped.** | Division facts and comparing numbers behave identically to v6.1. Old profiles open with no visible change. |
| **v6.3** | §6 — three fraction categories | Fraction entry works on a phone-sized numpad. Simplify rejects unsimplified equivalents with a near-miss hint in Practice. Review facts survive a reload. |
| **v6.4** | §7 — three decimal + two percentage categories | Decimal key behaves. `ragged` comparisons include shorter-is-larger cases. No float-comparison misses. |

Doing §5 alone, first, is what keeps this from becoming a rewrite. After it
lands, each new category is a generator function plus a `CATS` row plus a
`SUBGROUP_CATS` entry — no changes to the session loop, the mastery
bookkeeping, or the parent dashboard.

---

## 12. Open items

- **Fraction entry ergonomics.** The plan is a `/` key that advances to the
  denominator, with tapping between fields still available. Worth watching a
  child use once before committing to it — the alternative is auto-advance on
  a fixed digit count, which is worse for two-digit denominators.
- **Category list length.** `strand` headers handle 20 categories. Past ~30 the
  focus-area picker likely wants collapsible sections.
- **Fraction arithmetic** is the natural next strand and would reuse the
  fraction widget wholesale, but needs its own answer-form decisions (is
  `6/8` acceptable for `1/4 + 1/2`?) — out of scope here.
- **`missing-part` and `choose-equivalent` overlap** in what they teach. If one
  proves redundant in use, drop it rather than keeping both for symmetry.

---

## 13. Changelog

Per the convention in `math-star-v6_1.html`, `APP_VERSION` is bumped on any
behavior or data-model change and noted here.

| Version | Change |
|---|---|
| v6.1 | Shipped: 12 categories, mastery heatmap, rounding subgroup prototype, per-category mastery/resurface overrides, review + graduation with resurfacing, parent dashboard, CSV export. |
| v6.2 | Shipped — §5 plumbing: N-field numeric widget, options-based choice widget, decimal numpad key, `promptText`/`formatAnswer()`, `answerSig()` for object answers, `strand`/`reviewable` on `CATS`, full descriptors in review entries (with a migration for pre-existing numeric2 entries), subgroup `defaultRequired`. No new categories; no visible behavior change. |
| v6.3 | *Planned* — §6 fractions: `fraction-simplify`, `fraction-mixed`, `fraction-equivalent`. |
| v6.4 | *Planned* — §7 decimals and percentages: `decimal-place-value`, `decimal-compare`, `decimal-arithmetic`, `percent-of-number`, `percent-convert`. |
