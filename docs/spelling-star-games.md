# Spelling Star — Game Ideas

Status: **backlog.** Nothing in this file is committed to being built, and
nothing here has been designed past the point where the real problems show up.
The purpose is to have the ideas written down with their costs attached, so
picking one is a decision rather than a fresh start.

Target file: `spelling-star-v6_3.html` (self-contained, like every Star app).

---

## 1. Why this file exists

Spelling Star ships one game — Spot the Spelling — and the Games hub was built
to hold more: `renderGames()` lays its cards out in a `flex-wrap` row that has
only ever had one card in it. The distractor engine carries a comment saying as
much (`// Shared generator: reusable by future recognition games.`), and that
comment was, before this file, the entire documented plan for a second game.

Spelling Star also has no specification of its own — its design record is the
comment changelog at the top of the HTML file. This file is not that spec. It
covers games only.

---

## 2. What a Spelling Star game is

Spot the Spelling set the shape, and it is worth stating explicitly, because
every idea below either follows it or has to argue for not following it.

| Property | How Spot the Spelling does it | Why |
|---|---|---|
| Ungraded | `score: 0, total: 0` on the session | The gradebook holds one row per graded sitting per list (parent-sync-spec §16). A game must not compete with a Test for that row |
| Short | A burst of 8–10 rounds, `Math.min(pool.length, 8 + rand(3))` | It is a sparkle break between the real work, not a second Test |
| Drawn from the practice set | Every list in `practiceLists()`, plus `data.reviewWords` | The child plays with the words they are actually on |
| Never punishing | Framed as "Quick eyes, quick tap — just for fun!"; a wrong tap costs nothing | A game the child can lose is a game they stop choosing |
| Parent-gateable | `data.gamesEnabled` and the per-day `today.gamesEnabled` | Games are off on test day if the parent says so |
| Recorded anyway | A session with `mode` and `results[]` | The parent can see it happened; it just is not a grade |

A game that wants to be graded, timed, or losable is not disqualified — but it
is a change to the app's posture, not just a new card in the hub, and should be
argued for on its own.

---

## 3. What a new game inherits

The reason a second game is cheaper than the first:

| Machinery | Where | What you get |
|---|---|---|
| `distractorsFor(wordObj)` | Three ranked sources: misspellings the child has really written (mined from session history by `observedErrorsFor()`), the parent's curated `misspellings` column, then generated | Plausible wrong answers, free, for any word |
| `generateMisspelling(word, banned)` | Ranked respelling rules, guaranteed to return something readable | A distractor even for a word with no history and no curation |
| `practiceLists()` | The assigned list plus any practice-set extras | Correct word sourcing, including multi-list sittings |
| `listStamp()` / `carryListStamp()` / `coverStamp()` | Stamps a sitting with the list it belongs to, or `coverIds` for a sitting spanning several | History and the parent dashboard can read the game per-list |
| `speak(text, slow)` | `SpeechSynthesisUtterance`, rate 0.85 (0.7 slow) | Hear-the-word, free |
| `kbRows()` | `abc` or `qwerty`, apostrophe key on the last row | An on-screen keypad matching the child's setting |
| `foldApos()` | Folds curly and straight apostrophes on both entry and checking | Contractions compare correctly |
| Theme tokens | `--accent`, `--soft`, `--green`, `--danger`, `--gold`, `--line` across four themes | A game that themes itself if it uses the variables |
| Curated content | 60 list files under `wordlists/spelling/`, 855 unique words, each with `hint`, `sentence`, and often `misspellings` | Real material to play against on day one |

---

## 4. What a new game costs

A game is not just its engine. Shipping `mode: "unscramble"` means touching
every place that switches on a mode string:

1. `renderGames()` — a card in the hub
2. The engine itself, plus a module-level state object (`SP`, `RP`, `S` are the
   existing three) **and** its null-out in `go()` — every navigation clears the
   in-flight round, and the v6.2 note records that forgetting this is a latent
   bug the app has already had once
3. `finishX()` — push a session with the new `mode`
4. Home screen "Last session" label
5. `renderLastResults()` — the tap-through summary
6. History: `modeLabel`, the per-row summary, and the expanded detail
7. The CSV export's per-result `type` column
8. `parent.html` — the mode map (`spotit: { label: 'Spot it', tone: 'play' }`)
9. `docs/parent-sync-spec.md` §2 — the `mode` enum in the session-payload table
10. A test suite, following `tests/spot-the-spelling.test.mjs`
11. `sw.js` — bump `CACHE_VERSION`

The server needs nothing: `functions/api/sync.js` stores `mode` as free text
and never validates it against a list. Ungraded modes are invisible to
`summary.js`, which filters on `total > 0`.

---

## 5. The ideas

### 5.1 Unscramble — drag the letters into place

The child sees the word's letters as tiles in scrambled order and drags them
into the right order. Hear-it and the hint are available; the word itself is
not shown.

**Round shape.** 6–8 words, same burst length as Spot the Spelling. Correct on
drop → tiles flash green and the next word slides in. Wrong → tiles stay put,
nothing is lost, "have another go".

**Reuses:** `practiceLists()`, `reviewWords`, `speak()`, the hint field, the
whole session/stamp/history path.

**New:** a drag interaction, which the codebase has never had — no app in the
repo contains a single `pointerdown`, `touchstart`, `draggable`, or
`ondragstart`. This is the real cost of the idea, and it is not in the shuffle
logic. Four things follow:

- **Pointer events, not HTML5 drag-and-drop.** HTML5 DnD is unreliable-to-inert
  on tablets, which is the primary device. Use `pointerdown`/`pointermove`/
  `pointerup`, which covers mouse and touch in one path.
- **The render model fights the drag.** Every screen in Spelling Star is a full
  `app.innerHTML = ...` rewrite. A drag cannot survive that — rebuilding the DOM
  mid-gesture destroys the element under the child's finger. The tile row has to
  be rendered once per word and then mutated in place (transform only) for the
  duration of the drag, with a re-render only on drop. This is a genuine
  departure from how the app is written and should be contained to the game.
- **`touch-action: none` on the tiles**, or the drag scrolls the page instead.
- **Tap-to-swap as an equal path, not a fallback.** Tap a tile, tap where it
  goes. Small fingers on a tablet is the stated constraint elsewhere in this
  codebase — the geography spec adds minimum tap radii to small states for
  exactly this reason — and a child who cannot complete a drag must not be
  locked out of the game.

**Content problems, with numbers from the curated lists:**

- **Anagrams that are also real words.** Six pairs collide in the existing
  corpus: silent/listen, dear/read, grown/wrong, three/there, quiet/quite,
  tired/tried. Asked to unscramble "listen", a child who builds "silent" is
  right about English and would be marked wrong. Check the assembled string
  against the child's own word set before rejecting it, and when it is another
  real word, say so — "that's a word! but not this one" — rather than buzzing.
  Note the limit: `realWordSet()` is the child's own lists, review and graduated
  words, not a dictionary, so it catches these six and nothing else.
- **Repeated letters — 410 of 855 words have one.** Tiles must be identified by
  position, not by character, and correctness must compare the *assembled
  string* against the word. Compare tile identity instead and "little" with its
  two `t`s exchanged reads as wrong while looking exactly right on screen.
- **Length.** 120 words are 9+ letters; the longest are 14
  ("characteristic", "administration", "representative"). Fourteen tiles do not
  fit one tablet row at a tappable size — either wrap to two rows or cap the
  game's word length and say so.
- **36 words are 3 letters or shorter**, which is not a puzzle. Filter them out
  or accept wasted rounds.
- **Apostrophes.** `o'clock`, `don't`, `we're` and friends are in the lists.
  Decide whether the apostrophe is a tile like any other or pre-placed as a
  freebie. Pre-placing is the kinder reading and matches the v6.4 apostrophe
  work, where the key is always present so it never signals which words need one.
- **The scramble must not be the answer.** Reshuffle until it differs from the
  word; for a 2-letter word that is one specific arrangement.

**Cost:** the largest of the five. Everything except the drag is ordinary.

---

### 5.2 Missing Letters

The word appears with two or three letters blanked — `b_lie_e` — and the child
fills them from the existing on-screen keypad. Hear-it and hint available.

**Reuses:** `kbRows()` and the whole keypad idiom, `foldApos()`, `speak()`,
plus — the point of the idea — `observedErrorsFor(word)`. The blanks do not
have to be random. The letters this child actually gets wrong are already
recorded, per word, in `missedAs`: diff the misspelling against the word and
blank *that* position. A child who writes "beleive" gets `b_l__ve` and drills
the exact trap, and the game teaches something Spot the Spelling cannot, which
is production rather than recognition.

Fall back to blanking vowels and vowel teams when a word has no error history.

**New:** the blank-position picker and the diff. No new interaction at all.

**Cost:** the cheapest of the five, and the one with the best
teaching-per-line-of-code. If only one game gets built, this is the argument
for it being this one.

---

### 5.3 Sentence Slot

The word's sentence is shown with the word blanked out, and the child spells it
into the gap — "She ____ she would be here soon." Hear-the-sentence already
exists as a button in Practice.

**Reuses:** the `sentence` field, which is the most underused asset in the app.
Every word has one, 987 of 988 curated sentences contain their word, and the
child ever meets it in exactly one place: a "Hear a sentence" button in
Practice that speaks it aloud. The only other reference in the file is the CSV
importer setting its default. It is never shown on screen anywhere.

**New:** blanking the word out of its sentence, which is where the edge cases
live:

- `sentence` defaults to the word itself when a parent leaves it blank
  (`String(raw.sentence || "").trim() || word`). A word whose sentence *is* the
  word gives a blank and no context — skip those words rather than showing a
  bare gap.
- Blank on a word boundary. The one sentence in the corpus that fails a
  `\b`-anchored match is `fire`, whose sentence is "We roasted marshmallows over
  the campfire." A naive substring blank turns that into "the camp____," which
  hands the child a different word to spell. Skip when the anchored match fails.
- Match case-insensitively but keep the sentence's capitalisation around the gap.

**Cost:** low. Closer to a Practice variant than a game, which is either the
appeal or the objection.

---

### 5.4 Spot the Spelling: Four-Up

The existing game with four options instead of two, for a child who has
outgrown the coin-flip.

**Reuses:** everything. `distractorsFor()` already returns a ranked *list* and
the game currently picks one entry from it and discards the rest.

**New:** filling out to three wrong options when history and curation supply
fewer, by calling `generateMisspelling()` repeatedly with the already-chosen
ones banned. The plausibility bar matters more here: a round with one real
error and two obviously-typo distractors is *easier* than the two-option
version, because the child eliminates on shape without reading. That is exactly
the silent failure `tests/spot-the-spelling.test.mjs` was written to catch, and
the test suite would need extending alongside.

**Cost:** lowest of all, but it is a difficulty tier rather than a new game, and
it does not add a second card to the hub so much as a setting to the first.

---

### 5.5 Rule Sort

Words are dealt one at a time and the child drops each into one of two or three
buckets — "drop the /j/ sound: **-ge** or **-dge**", "one **l** or two". Sorting
by pattern is what the curated lists are actually organised around week to week.

**Reuses:** the drag mechanics from 5.1, if that gets built first. Otherwise
tap-to-choose works fine and this becomes cheap.

**New — and this is the blocker:** a rule tag per word, which no list has and
no CSV column carries. Adding one means a sixth column, a parent UI for it, an
import path, and 855 words to tag before the game has anything to play with.
Alternatively derive buckets from spelling patterns at runtime, which is a real
piece of linguistics and will be wrong in ways a parent has to correct.

**Cost:** highest, almost all of it content rather than code. Worth keeping on
the list because it is the only idea here that teaches the *rule* rather than
the word, but it should not be picked without accepting the tagging work.

---

## 6. Ranked by build cost

| Idea | Interaction | New content needed | Cost |
|---|---|---|---|
| 5.4 Four-Up | none — existing | none | Trivial |
| 5.2 Missing Letters | existing keypad | none | Low |
| 5.3 Sentence Slot | existing keypad | none | Low |
| 5.1 Unscramble | **drag, new to the codebase** | none | High |
| 5.5 Rule Sort | drag or tap | **a rule tag on 855 words** | Highest |

Both cheap ideas are production practice — the child writes the letters — where
the shipped game is recognition. That is the gap in the hub, and it is worth
noticing that Unscramble sits between the two: the letters are given, so it is
neither quite recognition nor quite production.

---

## 7. Open questions

These apply to any of the five and are the parent's call, not the code's:

- **Does a game feed the review list?** Nothing adds a review word
  automatically today. The parent area offers "pull into review?" checkboxes
  built from the missed `main` words of the **last test or pretest only**, and
  the parent ticks them; Practice, Repeat and Spot the Spelling never
  contribute a candidate, and sessions only ever *graduate* review words out
  (three first-try correct in a row). A child who repeatedly fails "believe" in
  a game has shown the parent something worth seeing — but surfacing it means
  widening that candidate list, and a game whose misses follow the child around
  is in tension with the "just for fun" promise in §2.
- **Does a game count as the day's activity?** The per-day schedule has separate
  toggles for study, practice, test, repeat and games, so the app currently says
  no. Worth confirming that stays true.
- **One card per game, or one card with a mode picker?** Five cards in the hub
  is a lot of choosing for a five-minute break.

## Non-goals

- Timers, streaks the child can break, or anything losable
- Leaderboards, or any comparison between children
- Sound effects beyond the existing speech synthesis
- A game that requires the network, or any content not in the repo
