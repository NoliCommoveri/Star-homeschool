# Geography Star — build notes

How to regenerate the map data inlined in `geography-star.html`. See
`docs/geography-star-spec.md` §3–4 for why the app ships inlined rather than
fetching `geodata/*` at runtime.

## Regenerating the inlined map block

`geodata/build.js` is checked in but its dependencies are not (no committed
`node_modules`). To run it:

```sh
mkdir -p /tmp/geo-build && cd /tmp/geo-build
npm init -y
npm install us-atlas@3 topojson-client topojson-simplify d3-geo
node /path/to/repo/geodata/build.js > out.txt
```

`out.txt` contains two sections:

1. **`geodata/states.json`** — the human-reviewable source of truth (code,
   name, FIPS, region, capital, `capitalXY`, and small-state `centroid`).
   Copy this section over `geodata/states.json` in the repo.
2. **Paste block** — `STATE_PATHS`, `STATE_NAMES`, `CAPITALS`,
   `SMALL_STATE_CENTROID`, `STATE_REGION` as ready-to-paste `const`
   declarations. Paste this over the `// GENERATED MAP DATA` block near the
   top of the `<script>` in `geography-star.html`, replacing the old one
   verbatim.

Re-run this whenever boundary simplification, the capital list, or region
assignments change. Nothing else in the app needs to change for a data-only
update.

## Simplification threshold

`topojson-simplify`'s `simplify(presimplify(topology), minWeight)` was run at
several thresholds and checked against the spec's fidelity bar (Michigan's
mitten, Florida's panhandle, Cape Cod still recognizable):

| `minWeight` | `STATE_PATHS` size |
|---|---|
| 0.6 | 65.9 KB |
| 1 | 51.0 KB |
| **2** | **36.8 KB** ← used |
| 4 | 27.1 KB |
| 8 | 20.7 KB |

`minWeight=2` was verified visually (rendered to SVG, screenshotted) as the
highest simplification that keeps all three landmarks readable, and lands
inside the spec's 30–40 KB budget (§3).

## Capital coordinates

Capital city lat/long pairs are authored from general geographic knowledge —
stable, well-documented facts, not the "review-gated" content in spec §9
(that gate applies to state symbols, crops, and biographies, not city
locations).

Each is projected with `d3.geoAlbersUsa().scale(1300).translate([487.5,
305])` — the same 975×610 fit the pre-projected `states-albers-10m.json`
already uses — and the result is rounded to 1 decimal and baked into
`capitalXY`. No projection math or library ships in `geography-star.html`
itself.

**DC has no `capital` entry.** DC is the national capital, not a state with
a capital city of its own, so `CAPITALS.DC` doesn't exist and Mode 3 (Click
the Capital) excludes DC from its target set. DC still has a map shape and
participates normally in Modes 1, 2, 4, and 5.

**AK/HI inset verification (spec §4, §12):** both capital dots were checked
by rendering the Alaska and Hawaii insets at high zoom. Juneau's dot lands
on the Alaska panhandle; Honolulu's dot lands on Oahu. Confirmed visually
before baking.

## FIPS → USPS mapping

`build.js` hardcodes the standard 51-entry FIPS-to-postal-code table (public
domain, not derived from any scraped source). `us-atlas`'s `states.geometries[].id`
is the 2-digit FIPS code; `.properties.name` is the state name.

## Small-state hit targets

`SMALL_STATE_CENTROID` covers RI, DE, CT, NJ, NH, VT, MA, MD, DC — the set
called out in spec §4. `geography-star.html` draws a transparent circle at
each centroid, above the state paths, so small/thin shapes remain tappable.
The centroid comes from `d3.geoPath().centroid(feature)` on the *simplified*
geometry (matching what's actually rendered, not the full-resolution shape).

## Content review status

Nothing in this file's output requires the spec §9 review gate — capitals,
FIPS codes, boundaries, and region buckets are all mechanically sourced or
stable factual assignments. The review gate applies starting in Stage 3
(state symbols, crops, biographies).

## Population (Stage 2)

`population2020` in `geodata/states.json`, and the matching `POPULATION_2020`
block inlined in `geography-star.html`, are the 2020 Decennial Census
resident population counts (the official apportionment figures) for the 50
states + DC. Public domain, mechanically sourced — not subject to the spec
§9 review gate.

This data isn't part of `build.js`'s TopoJSON pipeline (it doesn't come from
`us-atlas`), so it's authored by hand directly into both files. If a count
is ever corrected, update `population2020` in `geodata/states.json` first,
then copy the same value into `POPULATION_2020` in `geography-star.html` to
keep the two in sync.

Mode 7 (Population) rounds every displayed choice — the correct answer and
its distractors alike — to the nearest 10,000, so the correct choice isn't
identifiable by being the only non-round number on screen.

## Stage 3 — authored content (state symbols, crops, animals, people)

`bird`, `flower`, `tree`, `crops`, `animals`, `natureConfidence`, and
`people` were added to every record in `geodata/states.json` for Modes 8
and 9, following spec §9's authoring shape and confidence-flag requirement.

**How this was authored:** this session has a working `WebSearch` tool but
no working `WebFetch` to arbitrary sites (every external site fetch
attempted — Wikipedia, Britannica, several state-symbol reference sites —
returned HTTP 403 from this environment's outbound proxy). `WebSearch`
returns short snippets rather than full reference tables, so it was useful
for spot checks but not for exhaustively verifying 51 states of symbols
plus 153 biography entries. Content below is therefore authored from
training-data knowledge, consistent with spec §9's "Verification limits" —
and every entry not confidently well-established is flagged
`"confidence": "review"` (people) or `"natureConfidence": "review"` with a
`natureNote` (symbols/animals) rather than presented as settled fact.

**Regenerating the inlined blocks:** unlike the map/population data, this
content isn't produced by `build.js` (no TopoJSON pipeline involved). Once
reviewed, hand-copy the reviewed fields from `geodata/states.json` into new
`SYMBOLS`/`PEOPLE`-style `const` blocks in `geography-star.html`, next to
`POPULATION_2020`, following the same "authored directly into both files"
pattern documented above for population.

### Review checklist

Per spec §9, this is the review pass before biographical and
symbol/animal content is treated as settled fact. Everything below is
marked `"confidence": "review"` or `"natureConfidence": "review"` in
`geodata/states.json` — nothing else needs a look before Stage 3 is
considered fully reviewed.

**Mode 9 status:** the nature content (bird/flower/tree/crops/animals) is
inlined and Mode 9 ships in this phase — see the size/risk discussion
above. The `review` flags below are follow-up corrections, not blockers;
none of them are the kind of error that teaches a child something
seriously wrong, and the state associations themselves aren't in question.

**Mode 8 status — held, not inlined.** Spec §9 calls the People content
"the highest-risk content in the app" and spec §11 makes the parent review
pass step 12, explicitly before step 13 ("Inline reviewed content"). That
gate is honored here: all 153 people entries are authored into
`geodata/states.json` with confidence flags, but none of it is inlined
into `geography-star.html` yet, and Mode 8 has no UI in this phase. Once
the `review`-flagged entries below are checked (and corrected or removed
as needed), the next phase's job is a straight copy-paste into the app
plus the Mode 8 engine and UI — no further authoring required.

#### Nature (bird/flower/tree/crops/animals) — review needed

- **Connecticut (CT)** — Sperm whale is Connecticut's official state animal (an unusual pick since CT isn't coastal in the way whaling states usually are) — worth a source check.
- **District of Columbia (DC)** — DC is not a state and has no officially designated animal; verify bird/flower/tree, which are DC Council-designated emblems rather than state law.
- **Iowa (IA)** — Iowa's state tree is officially just “Oak” (no single species specified); some sources cite Bur Oak — confirm before printing a species name.
- **Idaho (ID)** — Idaho has no officially designated state animal; Rocky Mountain elk is a regional stand-in, not a legal designation.
- **Indiana (IN)** — Indiana has no officially designated state animal; white-tailed deer is a regional stand-in, not a legal designation.
- **Minnesota (MN)** — Minnesota has no officially designated state mammal; gray wolf is a regional stand-in reflecting the state's wolf population, not a legal designation.
- **Mississippi (MS)** — Mississippi schoolchildren voted for a proposed new state bird (wood duck) around 2021 — confirm whether Northern Mockingbird is still the legally designated bird.
- **North Carolina (NC)** — North Carolina's official tree statute names simply “Pine” without a species; Longleaf Pine is the commonly cited species — confirm before printing.
- **North Dakota (ND)** — Confirm the Nokota horse's exact official designation (state equine vs. honorary status).
- **Oklahoma (OK)** — Oklahoma's floral emblem changed from Mistletoe to Oklahoma Rose in 2004 — confirm Oklahoma Rose is still current.
- **Rhode Island (RI)** — Rhode Island has no officially designated state animal; harbor seal is a regional stand-in (seals winter in Narragansett Bay), not a legal designation.
- **Utah (UT)** — Utah changed its state tree from Blue Spruce to Quaking Aspen in 2014 — confirm this is reflected in current sources.
- **Virginia (VA)** — Virginia has no officially designated state land mammal; white-tailed deer is a regional stand-in, not a legal designation.

#### People (Mode 8 biographies) — review needed

- **Alaska (AK) — Roy Peratrovich** (activist): Roy Peratrovich, a Tlingit leader and Elizabeth Peratrovich's husband, led the Alaska Native Brotherhood's campaign alongside her for the 1945 Anti-Discrimination Act.
- **Alaska (AK) — Benny Benson** (inventor): Benny Benson, a 13-year-old Alutiiq boy, won a territory-wide contest to design Alaska's flag, choosing the Big Dipper and North Star to represent strength and a guiding light.
- **Arkansas (AR) — Wiley Branton** (activist): Wiley Branton was the lawyer who represented the Little Rock Nine, arguing the case that forced Central High School to admit Black students.
- **Arizona (AZ) — Raúl Héctor Castro** (activist): Raúl Héctor Castro grew up in a Mexican immigrant family in Arizona and, after years working as a lawyer for Mexican American communities facing discrimination, became the state's first Latino governor.
- **Arizona (AZ) — Manuelito** (activist): Manuelito, a Navajo leader, resisted the forced removal of his people from their Arizona and New Mexico homeland and later helped negotiate the 1868 treaty that let the Navajo return home.
- **Colorado (CO) — Chin Lin Sou** (both): Chin Lin Sou, a Chinese immigrant, became a respected businessman and leader of Denver's Chinese community during Colorado's mining era, despite intense anti-Chinese discrimination.
- **Colorado (CO) — Chipeta** (activist): Chipeta, a Ute leader, traveled to Washington, D.C. to negotiate on behalf of the Ute people after they were forced from their Colorado homeland, working to protect what land and rights she could.
- **Florida (FL) — Osceola** (activist): Osceola led Seminole resistance in Florida against the U.S. government's attempt to force his people from their homeland during the Seminole Wars.
- **Hawaii (HI) — Prince Jonah Kūhiō Kalanianaʻole** (activist): Prince Jonah Kūhiō Kalanianaʻole served as Hawaii's delegate to Congress and wrote the Hawaiian Homes Commission Act, which set aside land so Native Hawaiians could return to farming and ranching their homeland.
- **Iowa (IA) — Edna Griffin** (activist): Edna Griffin led a 1948 sit-in at a Des Moines, Iowa drugstore that had refused to serve Black customers, a case sometimes called “Iowa's Rosa Parks story.”
- **Iowa (IA) — James B. Morris Sr.** (activist): James B. Morris Sr. published the Iowa Bystander, one of the oldest Black newspapers in the country, using it to report on and fight discrimination in Iowa.
- **Idaho (ID) — Polly Bemis** (both): Polly Bemis was brought to Idaho as a young woman during the mining era and later became a respected rancher along the Salmon River, remembered as one of Idaho's notable Chinese American pioneers.
- **Idaho (ID) — Chief Tendoy** (activist): Chief Tendoy led the Lemhi Shoshone in Idaho and worked to keep peace and protect his people's access to their homeland during a time of growing settler pressure.
- **Illinois (IL) — Jesse Binga** (both): Jesse Binga founded one of the first Black-owned banks in Chicago, Illinois, giving Black families and businesses access to loans when other banks would not.
- **Illinois (IL) — Oscar Stanton De Priest** (activist): Oscar Stanton De Priest, elected from Chicago, Illinois, became the first Black member of Congress from a northern state in the twentieth century and pushed for anti-lynching legislation.
- **Kansas (KS) — Benjamin “Pap” Singleton** (activist): Benjamin “Pap” Singleton helped lead thousands of formerly enslaved people, known as Exodusters, to settle in Kansas and build new lives after the Civil War.
- **Kentucky (KY) — Georgia Davis Powers** (activist): Georgia Davis Powers became Kentucky's first Black state senator and wrote the state's first civil rights and fair housing laws.
- **Maine (ME) — Gerald Talbot** (activist): Gerald Talbot became Maine's first Black state legislator and worked to pass some of the state's first civil rights laws.
- **Maine (ME) — Lucy Nicolar** (activist): Lucy Nicolar, a Penobscot performer and advocate, spent her life sharing Wabanaki culture and pushing for the rights of Maine's Native nations.
- **Michigan (MI) — Ossian Sweet** (activist): Dr. Ossian Sweet defended his Detroit, Michigan home from a mob that attacked it because a Black family had moved in, and his trial became a landmark case for Black Americans' right to live where they chose.
- **Minnesota (MN) — Nellie Stone Johnson** (activist): Nellie Stone Johnson, a Minnesota labor and civil rights leader, was the first Black person elected to citywide office in Minneapolis and helped write job-discrimination protections into state law.
- **Montana (MT) — Plenty Coups** (activist): Plenty Coups, a Crow chief in Montana, chose diplomacy over war to try to protect Crow land and worked to preserve his nation's independence and culture.
- **Montana (MT) — Susie Walking Bear Yellowtail** (activist): Susie Walking Bear Yellowtail, a Crow nurse from Montana, fought to improve healthcare for Native Americans and helped end the forced sterilization of Native women.
- **North Carolina (NC) — James E. Shepard** (activist): James E. Shepard founded what became North Carolina Central University, opening doors to higher education for Black students in North Carolina.
- **North Dakota (ND) — Buffalo Bird Woman (Waheenee)** (both): Buffalo Bird Woman (Waheenee), a Hidatsa woman from North Dakota, shared her detailed knowledge of traditional Hidatsa farming methods, preserving skills that had fed her people for generations.
- **North Dakota (ND) — Era Bell Thompson** (both): Era Bell Thompson grew up on a North Dakota homestead and became a groundbreaking journalist and editor at Ebony magazine, writing about Black life in America.
- **North Dakota (ND) — Elizabeth Preston Anderson** (activist): Elizabeth Preston Anderson led North Dakota's campaign for women's right to vote and helped write it into the state constitution.
- **New Hampshire (NH) — Harriet E. Wilson** (both): Harriet E. Wilson, who lived in New Hampshire, wrote “Our Nig,” believed to be the first novel published in the United States by a Black woman.
- **New Hampshire (NH) — Amos Fortune** (both): Amos Fortune, who had been enslaved, bought his own freedom and later that of others, and became a respected tanner and community founder in Jaffrey, New Hampshire.
- **New Mexico (NM) — Fabiola Cabeza de Baca** (both): Fabiola Cabeza de Baca, a Hispanic New Mexican teacher and writer, worked to preserve Hispanic food traditions and improve rural life through her work as a home economist.
- **Nevada (NV) — James McMillan** (activist): Dr. James McMillan led the effort that peacefully desegregated Las Vegas, Nevada hotels and casinos in 1960 through an agreement known as the Moulin Rouge Agreement.
- **Nevada (NV) — Lubertha Johnson** (activist): Lubertha Johnson helped found the Las Vegas, Nevada NAACP chapter and fought for fair housing so Black families were not forced into only one part of the city.
- **New York (NY) — Chien-Shiung Wu** (inventor): Chien-Shiung Wu, a Chinese American physicist who worked in New York, ran an experiment that disproved a rule scientists had long assumed was always true about how atoms behave.
- **Ohio (OH) — John Mercer Langston** (both): John Mercer Langston, who lived in Ohio, became one of the first Black lawyers in the country and later the first Black man elected to Congress from Virginia.
- **Oklahoma (OK) — Sequoyah** (inventor): Sequoyah, a Cherokee silversmith, invented a full writing system for the Cherokee language so his people could read and write in their own language; he later settled in what became Cherokee Nation land in Oklahoma.
- **Oregon (OR) — Beatrice Morrow Cannady** (activist): Beatrice Morrow Cannady ran a newspaper in Portland, Oregon and spent decades fighting the state's discriminatory laws and pushing for civil rights.
- **Pennsylvania (PA) — James Forten** (both): James Forten, a free Black sailmaker in Philadelphia, Pennsylvania, invented a device that made handling ship sails easier, and used his fortune to support the movement to end slavery.
- **Rhode Island (RI) — George T. Downing** (activist): George T. Downing, a Rhode Island restaurant owner, led the successful fight to desegregate the state's public schools in 1866.
- **Rhode Island (RI) — Christiana Carteaux Bannister** (both): Christiana Carteaux Bannister, a Narragansett and Black businesswoman in Providence, Rhode Island, used her wealth to found a home for elderly Black residents and to support Black artists.
- **Rhode Island (RI) — Sissieretta Jones** (both): Sissieretta Jones, a celebrated singer who lived in Providence, Rhode Island, became one of the first Black artists to perform at Carnegie Hall, opening doors for Black classical performers.
- **South Dakota (SD) — Ben Reifel** (both): Ben Reifel, a Lakota man from South Dakota, became the first enrolled member of a Sioux tribe elected to the U.S. Congress.
- **Tennessee (TN) — Z. Alexander Looby** (activist): Z. Alexander Looby, a lawyer in Nashville, Tennessee, represented students arrested during sit-ins, and after his home was bombed for it, the city ended lunch-counter segregation.
- **Tennessee (TN) — Wilma Rudolph** (activist): Wilma Rudolph, who grew up in Clarksville, Tennessee, became an Olympic champion runner and refused to take part in her hometown's celebration for her until it was integrated.
- **Utah (UT) — Jane Manning James** (both): Jane Manning James, a Black pioneer who walked much of the way to Utah, became a respected member of her Salt Lake City community despite facing discrimination there.
- **Utah (UT) — Green Flake** (both): Green Flake was brought to Utah as an enslaved man among the first Mormon pioneers in 1847; he later gained his freedom and became a respected early settler in Union, Utah.
- **Vermont (VT) — Lucy Terry Prince** (both): Lucy Terry Prince, who had been enslaved, became known as an early Black American poet and later successfully argued a land case before the Vermont Supreme Court, likely the first Black person to do so.
- **Vermont (VT) — Daisy Turner** (both): Daisy Turner, the daughter of a formerly enslaved man who settled in Vermont, spent her long life preserving her family's history through storytelling, work later recognized by the Smithsonian.
- **Washington (WA) — Chief Seattle** (activist): Chief Seattle, a Duwamish and Suquamish leader, worked to keep peace with settlers while trying to protect his people's land and way of life in what is now Washington state.
- **Washington (WA) — Nettie Craig Asberry** (both): Nettie Craig Asberry co-founded one of the first NAACP chapters on the West Coast, in Tacoma, Washington, and fought for Black civil rights in the region for decades.
- **Wisconsin (WI) — Mabel Watson Raimey** (both): Mabel Watson Raimey became Wisconsin's first Black woman lawyer and spent her career fighting discrimination in Milwaukee's schools and workplaces.
- **West Virginia (WV) — Memphis Tennessee Garrison** (activist): Memphis Tennessee Garrison, a teacher in the coal towns of West Virginia, organized NAACP chapters across the state and fought for equal pay for Black teachers.
- **Wyoming (WY) — William Jefferson Hardin** (activist): William Jefferson Hardin became one of the first Black lawmakers in the Wyoming Territory legislature, pushing for Black residents' civil rights in the 1870s.

## State Nicknames (Mode 10)

`nickname` in `geodata/states.json`, and the matching `NICKNAMES` block
inlined in `geography-star.html`, hold each state's best-known traditional
nickname (e.g. "The Golden State" for California). DC has no state
nickname, so it's excluded from `NICKNAMES`/`NICKNAME_CODES` — the same
pattern `CAPITALS` uses for excluding DC.

Like population, this isn't part of `build.js`'s TopoJSON pipeline, so it's
authored by hand directly into both files. If a nickname is ever corrected,
update `geodata/states.json` first, then copy the same value into
`NICKNAMES` in `geography-star.html`.

Mode 10 (State Nicknames) shows the nickname and asks the child to pick the
matching state from four choices — one direction only, unlike Mode 9's
either-direction format. It's gated into the `g35` and `g6` tiers alongside
Capitals and Natural World, tracked in `MASTERY_MODE_COLUMNS`, and its
mastery grid column uses `NICKNAME_CODES` (49 states, no DC) rather than
`ALL_CODES`.

## Stage 4 — profiles, difficulty tiers, mastery, region progression

Spec §11 calls this stage's job "port the Math Star pattern" for profiles,
PIN, and settings, and §6-§7 for difficulty tiers, region progression, and
per-state-per-mode mastery. All of it lives directly in
`geography-star.html` — there's no `geodata/` source for this stage, since
none of it is authored content; it's app logic and per-child state that
only ever exists in a browser's `localStorage`.

**Storage.** `geostar-<name>` keys, same shape as `mathstar-`/`spellingstar-`:
`listProfiles()`/`nameToKey()`/`load()`/`persist()` mirror Math Star's
functions of the same name, including corrupted-profile detection (a key
under the prefix that fails to parse, or parses but is missing
`childName`/`pin`) surfaced on the profile picker with a "Remove & start
fresh" action rather than silently dropped.

**Difficulty tiers** (spec §6) are a `TIERS` map (`k2`, `g35`, `g6`) each
declaring which mode IDs unlock and a `regionScope`:

- `k2` — Modes 1-2 only, `regionScope: "single"` — the child works one
  region at a time.
- `g35` — Modes 1-6 and 9, `regionScope: "progress"` — unlocked regions
  accumulate.
- `g6` — all 8 built modes (Famous People/Mode 8 still has no UI — see
  above), `regionScope: "all"` — the full 50 states + DC, no region
  restriction.

`renderHome()` filters the `MODES` array by `m.tiers.includes(data.tier)`,
so a K-2 profile's home screen only ever renders two mode cards — the
Facts Deck heading doesn't render at all rather than rendering empty.

**Region progression** (spec §6) is one counter, `unlockedRegionCount`,
interpreted differently per tier's `regionScope`: `single` tiers show only
`REGION_ORDER[unlockedRegionCount - 1]`; `progress` tiers show the union of
`REGION_ORDER[0..unlockedRegionCount-1]`. A region unlocks the next one in
`REGION_ORDER` once every state in it has graduated in Mode 1 (Find the
State) — chosen as the gating mode because map recognition is the
prerequisite skill the other modes build on. This is intentionally
simpler than tying progression to every mode independently.

**Mastery** (spec §7) is tracked per mode per state code: `data.mastery`
holds an in-progress streak, `data.graduated` holds states that hit
`masteryStreakRequired` (default 3) and dropped out of rotation, and
`data.reviewFacts` flags a state after a miss so `buildQueue()` weights it
back up to `reviewBankPercent` (default 30%) of the next round. A
graduated state resurfaces (leaves `data.graduated`, re-enters normal
rotation) once `data.sessionsByMode[mode] - graduatedAtSession >=
resurfaceAfterSessions` (default 10 rounds of that mode). All three
numbers are parent-adjustable on the dashboard's Mastery tab, which also
renders the per-region-per-mode mastery grid spec §7 calls for (states
mastered / states in region, one row per region, one column per mode).

**Round composition.** `buildQueue(modeId, pool, size)` replaces the old
`sample(ALL_CODES, ROUND_SIZE)` call in every mode: it scopes `pool` down
to the child's unlocked region(s) first, drops graduated states out of
rotation (falling back to the full scoped pool if literally everything in
scope is graduated, so a round is always playable), then mixes in review
states up to `reviewBankPercent`. A region with fewer states than
`ROUND_SIZE` (New England has 6) simply produces a shorter round rather
than repeating a state within it.

**Parent dashboard.** PIN-gated (`parentGate()`/`pinSubmit()`), two tabs —
Settings (tier, `allowChildFocusSwitch`, rename, change PIN, add another
child, reset progress, delete profile) and Mastery (the streak/resurface/
review-bank numbers plus the per-region grid) — plus an always-visible
Export CSV button. `allowChildFocusSwitch` only matters for `single`-scope
tiers (K-2): when on, a "Switch region" link appears on the child's home
screen letting them pick any already-unlocked region as current, mirroring
the existing `allowChildFocusSwitch` pattern's intent from spec §6.

**CSV export** is one row per completed round (not per question, since
Geography Star doesn't keep a full answer-by-answer session log the way
Math Star does): child, date, time, mode, region(s) in scope at the time,
correct, total, percentage. Filename is `<name>-geography-results.csv`
per spec §6. `data.sessionLog` is capped at the most recent 500 rounds for
the same reliability reason Math Star caps at 300 sessions — CSV export is
the permanent record, not `localStorage`.

**Verified in a headless browser** (Playwright/Chromium, this environment's
pre-installed copy): full setup wizard through all three tiers; K-2's
region restriction and round-size shrinking on a 6-state region; three
winning rounds graduating all of New England in Find the State and
auto-unlocking Mid-Atlantic; the mastery grid rendering correct per-region
counts; tier switching correctly changing which modes render; multi-profile
picker, wrong-PIN rejection, corrupted-profile detection and removal, and
profile deletion; and CSV export producing the expected rows and filename.
