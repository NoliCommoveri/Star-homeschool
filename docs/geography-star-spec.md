# Geography Star — Specification

Status: **Stage 1 (map deck) and Stage 2 (capitals + population) shipped.
Stage 3 (famous people, natural world) not yet started.**
Target file: `geography-star.html` (self-contained, alongside Math Star and Spelling Star)

---

## 1. Goals

A US geography practice app matching the existing Star Apps: single-file, offline-capable,
localStorage progress, parent-managed profiles. Serves multiple children of different ages
from the same install.

Nine game modes across two decks — map skills and state facts — with the facts decks
covering population, notable inventors and activists, and the natural world.

### Non-goals (v1)

- World geography, or US regions beyond the 50 states + DC
- Counties, cities other than capitals, rivers, or landforms
- Any network dependency at runtime

---

## 2. Data sourcing and licensing

All map and boundary data traces to public-domain federal sources. Verified available and
downloaded during planning.

| Content | Source | License |
|---|---|---|
| State boundaries | US Census TIGER/Line, packaged as npm `us-atlas@3` (`states-albers-10m.json`) | Census data is public domain (US government work); Bostock's packaging is ISC |
| State names, FIPS codes | Same file — 51 geometries, 50 states + DC, each with `id` (FIPS) and `name` | Public domain |
| Postal abbreviations | npm `us-state-codes` or hand-entered (52 two-letter codes) | Trivially factual |
| Capital cities and coordinates | Authored — city names and lat/long are facts, not copyrightable | n/a |
| Population | 2020 Decennial Census official counts | Public domain |
| State symbols (bird/flower/tree) | Authored from state legislative designations | Facts |
| People, crops, animals | Authored — see §9 | n/a |

**Explicitly avoided:** map tiles or SVG outlines scraped from Google Maps, Mapbox,
Wikipedia media, or textbook publishers. All carry license terms this project doesn't need
to inherit.

**Environment note:** this session's network permits package registries only
(`registry.npmjs.org`, `pypi.org`). The npm route is not just convenient, it is the only
working path. `us-atlas@3.0.1` is already downloaded and verified.

---

## 3. File layout

```
geography-star.html          ← the app; everything inlined, no fetch
geodata/states.json          ← source of truth for authored content, human-reviewable
geodata/build-notes.md       ← how to regenerate the inlined blocks
```

### Why both

Math Star and Spelling Star are both fully self-contained — neither calls `fetch`. Only
`resources.html` fetches, and it is always served over HTTP. That precedent exists for a
reason: `fetch()` of a local JSON file fails under the `file://` protocol, so a split app
would break for anyone who opens the HTML directly from disk rather than through GitHub
Pages.

So the app ships **inlined**, matching precedent. `geodata/states.json` is kept in the repo
as the reviewable source, and a documented copy-paste step regenerates the inlined block
when content changes.

This matters most for §9. Reviewing 200 biography entries as formatted JSON is a
twenty-minute read; reviewing them embedded in a 300KB HTML file is not.

### Size budget

| Block | Estimate |
|---|---|
| Simplified SVG paths, 51 states | 30–40 KB |
| `STATES` data (all facts, all people blurbs) | 60–90 KB |
| Engine, UI, CSS | ~60 KB |
| **Total** | **~180 KB** |

Larger than Math Star (90 KB) and Spelling Star (99 KB), but the same order of magnitude
and well within tolerance for a local-first page.

---

## 4. Map rendering

### Projection

Use `states-albers-10m.json`, which is **pre-projected** into Albers USA — Alaska scaled and
Hawaii repositioned into the lower-left, the standard classroom layout. No runtime
projection math and no `d3-geo` dependency.

- Verified bbox: `[-57.66, 12.98, 957.52, 606.57]`
- SVG viewBox: `0 0 975 610`

### Build step (run once, offline)

1. Load `states-albers-10m.json`, convert TopoJSON → GeoJSON.
2. Simplify coordinates. 10m detail far exceeds what a tap-target game needs; target a
   visible-fidelity threshold that keeps recognizable shapes (Michigan's mitten, Florida's
   panhandle, Cape Cod) while shedding coastline noise.
3. Round coordinates to 1 decimal.
4. Emit `{ "AL": "M...Z", "AK": "M...Z", ... }` keyed by postal code.

### Capital marker coordinates

Project each capital's lat/long through the same Albers USA transform used to generate the
atlas file (`d3.geoAlbersUsa().scale(1300).translate([487.5, 305])` — the standard 975×610
fit), then **bake the results** into `states.json` as `capitalXY: [x, y]`. Runtime just
plots a dot. No projection library ships with the app.

Alaska and Hawaii capitals must be verified to land inside their repositioned insets —
`geoAlbersUsa` handles this, but Juneau and Honolulu get an explicit visual check.

### Hit targets

Tap targets are the `<path>` elements themselves, so hit areas follow the real state shapes.

Small states — RI, DE, CT, NJ, NH, VT, MA, MD, DC — additionally get a transparent circle of
a minimum tap radius centered on their centroid, rendered above the paths. Without this the
game is unplayable for small fingers on a tablet.

A leader-line label treatment is used for the Northeast cluster in modes that show labels.

---

## 5. Game modes

Nine modes in two decks. Each mode declares which profile difficulty tiers unlock it (§6).

### Map deck

| # | Mode | Prompt | Answer |
|---|---|---|---|
| 1 | Find the State | "Where is Ohio?" | Click the state |
| 2 | Name the State | One state highlights | Multiple choice, 4 names |
| 3 | Click the Capital | Unlabeled dots on map | Click the right dot |
| 4 | State → Abbreviation | "Kentucky" | Multiple choice or type-in |
| 5 | Abbreviation → State | "KY" | Multiple choice or type-in |

Modes 4 and 5 need no map. Both offer a **map-hidden mode** so they work as a car-ride
flashcard drill on a phone.

Mode 3 hardest-in-deck: reuses the small-state minimum tap radius, and at easier tiers shows
only the capitals of states in the current region rather than all 51 dots at once.

### Facts deck

| # | Mode | Prompt | Answer |
|---|---|---|---|
| 6 | Capitals | Either direction: state → capital, or capital → state | Multiple choice or type-in |
| 7 | Population | "About how many people live in Nevada?" | Multiple choice, 4 options |
| 8 | Famous People | Blurb shown, or person named | Which state, or who is this |
| 9 | Natural World | State bird / flower / tree / crop / animal | Multiple choice, either direction |

### Mode 7 — population detail

**Use the 2020 Decennial Census count, not a current estimate.** Estimates drift annually,
so an app built on them goes quietly wrong and nobody notices. The 2020 count is a fixed
historical figure and is what school materials cite.

- UI labels the figure **"2020 Census"** on every question, so the child learns that a
  population number carries a date.
- Distractors are generated as plausible near-misses, rounded to the nearest 10,000, spread
  around the true value so the answer isn't guessable by magnitude alone.
- Easier tiers can switch to a coarser comparison framing ("which state has more people?")
  rather than absolute numbers.

### Mode 8 — famous people detail

Target 3–5 people per state: inventors and activists, deliberately weighted toward Black,
Latino, Indigenous, and Asian American figures. Each entry carries a one-to-two sentence
blurb on what the person actually did.

Question forms:
- Blurb + name shown → which state
- State shown → which of these four people
- Blurb shown → who is this

See §9 for tone and accuracy handling. This is the highest-risk content in the app.

### Mode 9 — natural world detail

**Lead with official state symbols, use crops selectively.** State bird, flower, and tree are
legislated designations — unambiguous and verifiable. Top agricultural products are solid
where a state has a signature crop (Idaho potatoes, Georgia peaches, Iowa corn) and mushy
elsewhere; include crops only where genuinely distinctive rather than forcing all 50.

Native animals are included as a third category, drawn from species with a clear regional
association.

---

## 6. Profiles and difficulty

Mirrors the existing apps exactly. Both Math Star and Spelling Star already implement
per-child profiles with a parent PIN, so Geography Star follows the same shape rather than
inventing a new one.

- Storage keys: `geostar-<childname>`, matching `mathstar-` / `spellingstar-`
- Same `childName` + `pin` + parent settings panel structure
- Same corrupted-profile detection on key enumeration
- Same CSV export (`<name>-geography-results.csv`)

### Difficulty tiers

Set per profile by the parent. Each tier controls unlocked modes, scope, and scaffolding:

| Tier | Modes unlocked | Scope | Scaffolding |
|---|---|---|---|
| K–2 | 1, 2 | One region at a time | Labels visible, unlimited retries, no timer |
| 3–5 | 1–6, 9 | Region progression → all 50 | Hints on request, no timer |
| 6+ | All 9 | All 50 states | Minimal hints, optional timer and streak scoring |

A 2nd grader sees two modes on screen, not nine. Tier is a parent setting; the existing
`allowChildFocusSwitch` pattern decides whether the child may change region themselves.

### Region progression

New England, Mid-Atlantic, Southeast, Midwest, Great Plains, Southwest, Mountain West,
Pacific, Non-contiguous. Regions unlock in sequence at lower tiers, all available at 6+.

---

## 7. Progress and mastery

Follows the Math Star model (`masteryStreakRequired`, `resurfaceAfterSessions`,
`reviewFacts`, `graduated`, `sessions`).

- Mastery is tracked **per state per mode** — knowing where Ohio is and knowing its capital
  are separate facts with separate streaks.
- A state graduates out of rotation after `masteryStreakRequired` consecutive correct
  answers in that mode (default 3, parent-adjustable).
- Graduated states resurface after `resurfaceAfterSessions` (default 10) to check retention.
- Missed states enter `reviewFacts` and are weighted up in subsequent drills.
- `reviewBankPercent` controls the review/new mix, same as Math Star.

Parent panel shows a per-region mastery grid so it's visible at a glance which states are
sticking.

---

## 8. Visual design

Inherit the existing palette verbatim from `index.html`:

```
--bg: #FDF6EC   --text: #2A3A50   --card: #FFFFFF
--accent: #2A5D9F   --green: #2E8B57   --gold: #E8A013
--muted: #6B7686   --eyebrow: #B0763A   --line: #EDE4D3
```

Same Lexend font stack, same 20px card radius, same shadow treatment.

Map-specific colors:

| State | Fill |
|---|---|
| Default | `--card` with `--line` stroke |
| Hover / focus | `--accent-soft` |
| Correct | `--green-soft`, green stroke |
| Wrong | muted red wash, settling to default |
| Prompted (mode 2) | `--gold-soft` |

Correct/incorrect feedback must not rely on color alone — pair with a check/cross glyph and
the state name, for colorblind accessibility.

A fourth card is added to `index.html`:

```
🗺️  Geography Star — States, capitals, and what makes each place
```

using an `.icon.geography` class with `--green-soft` or a new soft tint.

---

## 9. Content authoring — accuracy and tone

This is the part of the build that carries real risk. Two things to be clear about.

### Verification limits

Boundaries, FIPS codes, and 2020 Census counts are mechanically sourced and reliable.
**Capitals, state symbols, crops, and biographies are authored from model knowledge, and
this environment cannot reach primary sources to verify them.**

Biographical errors in a homeschool app are the worst kind — a child memorizes the wrong
thing and it sticks. "Born in" vs. "worked in" vs. "is associated with" is genuinely murky
for many historical figures, and getting it wrong turns a mode-8 answer key into
misinformation.

**Mitigation, and this is a required build step, not a nice-to-have:**

1. All authored content lands in `geodata/states.json` first, formatted for reading.
2. Every entry carries a `confidence` field: `high` for well-documented facts, `review` for
   anything where the state association or a detail is uncertain.
3. Parent reviews and corrects before the content is inlined into the app.
4. Only then does the copy-paste build step run.

Entries flagged `review` are listed in `geodata/build-notes.md` so the review pass is a
checklist, not a hunt.

### Tone for hard history

**Decision: direct but plain, one version for everyone.**

Blurbs are honest about what activists fought against — slavery, lynching, segregation,
forced removal of Native families — in language a third grader can follow. No separate
softened version for younger profiles.

Writing rules:

- State plainly what was happening and what the person did about it. "Laws said Black
  children and white children could not go to the same schools. She sued, and won."
- Short declarative sentences. No euphemism ("relocation" for forced removal), no
  abstraction that hides the actor.
- No graphic detail. Plain is not the same as vivid.
- Lead with the person's agency and achievement, not with what was done to them.
- Every blurb names something concrete the person made, founded, argued, or won.

### Entry shape

```json
{
  "code": "NM",
  "name": "New Mexico",
  "capital": "Santa Fe",
  "capitalXY": [215, 412],
  "population2020": 2117522,
  "region": "southwest",
  "bird": "Greater Roadrunner",
  "flower": "Yucca",
  "tree": "Piñon Pine",
  "crops": ["pecans", "chile peppers", "dairy", "hay"],
  "animals": ["black bear", "pronghorn", "collared lizard"],
  "people": [
    {
      "name": "...",
      "role": "inventor | activist | both",
      "blurb": "One to two sentences on what they did.",
      "confidence": "high | review"
    }
  ]
}
```

---

## 10. Accessibility

- Every state path gets `role="button"`, `tabindex`, and an `aria-label` with the state name,
  so the map is keyboard-navigable and screen-reader usable.
- Arrow keys move between states in reading order; Enter/Space selects.
- Feedback is never color-only (§8).
- Minimum tap target enforced for small states (§4).
- Text-only modes (4, 5, 6) work fully without the map, which is also the accessibility
  fallback if SVG interaction fails.

---

## 11. Recommended build order

Staged so a playable app arrives well before 200 biography blurbs are written and reviewed.

### Stage 1 — Map engine and map deck
*Largest technical chunk. No authored content required, so nothing blocks on review.*

1. Build step: TopoJSON → simplified SVG paths, emit keyed object
2. Inline paths; render the map with hover, focus, and selection states
3. Small-state hit targets and Northeast label treatment
4. Modes 1, 2, 4, 5 (Find, Name, and both abbreviation directions)
5. Bake `capitalXY` coordinates; verify AK and HI insets visually; add mode 3

**Deliverable: a playable geography game.**

### Stage 2 — Data scaffold and low-risk facts
*Factual, mechanically sourced, low review burden.*

6. Create `geodata/states.json` with all 51 records: names, codes, capitals, `capitalXY`,
   2020 Census counts, regions
7. Mode 6 (capitals, both directions)
8. Mode 7 (population, with "2020 Census" labeling and distractor generation)

**Deliverable: six of nine modes, all content verifiable.**

### Stage 3 — Authored content
*The review-gated stage.*

9. State symbols, animals, crops → mode 9
10. People entries with `confidence` flags → mode 8
11. `build-notes.md` review checklist
12. **Parent review pass** — hold before inlining
13. Inline reviewed content

**Deliverable: all nine modes, content reviewed.**

### Stage 4 — Profiles, progress, integration
*Deliberately last: the mastery model is easiest to tune once every mode exists and their
relative difficulty is observable.*

14. Profile creation, PIN, parent settings panel (port the Math Star pattern)
15. Difficulty tiers and mode gating
16. Per-state-per-mode mastery, review bank, resurfacing
17. Region progression
18. CSV export
19. Fourth card on `index.html`; `manifest.json` untouched (no new icons needed)

**Deliverable: shippable.**

### Order rationale

Stage 1 first because it is the most technical work and has zero content dependencies — it
can be finished and tested while nothing else is decided. Stage 3 sits behind a human review
gate, so it must not block earlier stages. Stage 4 last because difficulty tuning wants all
nine modes present to calibrate against.

---

## 12. Open risks

| Risk | Handling |
|---|---|
| Biography accuracy (§9) | Mandatory review gate before inlining; `confidence` flags |
| Crop/product claims are soft | Include only distinctive crops; skip states without one |
| File size at ~180 KB | Acceptable; revisit path simplification if it overruns |
| Small-state tap targets | Minimum-radius overlay; test on an actual tablet |
| Population data ages | Pinned to 2020 Census and labeled as such, so it never silently drifts |
| AK/HI inset coordinates | Explicit visual verification of Juneau and Honolulu in Stage 1 |
