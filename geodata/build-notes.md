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
