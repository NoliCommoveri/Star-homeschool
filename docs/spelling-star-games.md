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

### 5.1 Unscramble — tap a slot, tap a letter

The child sees an empty slot per letter and a bank holding the word's letters
in scrambled order. Tap a slot to select it, then tap a letter from the bank to
drop it in. Hear-it and the hint are available; the word itself is not shown.

This started as a drag-and-drop design and became a tapping one, which is the
single most important decision in this file. The drag version needed pointer
events the codebase has never used, and it fought the render model — every
screen here is a full `app.innerHTML` rewrite, which destroys the element under
the child's finger mid-gesture. **Tap-to-place needs none of that.** Two
`onclick` handlers mutating a state object, rendered the way every other screen
is rendered. It is the same idiom as the keypad: `kbType()` is one line that
appends a character and updates the display, and the slot board is that with a
destination.

It is also better for the child, not merely cheaper. Two discrete taps beat a
sustained precision gesture on a tablet, there is nothing to drop on the way,
and a mis-tap costs one tap to fix.

**Round shape.** 6–8 words. The board is complete when every slot is filled;
"Check it" then grades it, following the app's existing button pattern. Wrong
→ nothing is lost, letters stay put, have another go. (The alternative is
auto-checking the moment the last slot fills, which saves a tap but takes away
the child's chance to look it over and change their mind. The explicit button
is the better default here, and it is what every other screen does.)

**Selection model.** After placing a letter, selection auto-advances to the
next empty slot. That matters: it means straightforward left-to-right filling
is just tap-tap-tap-tap with no slot-selecting at all, while a child who wants
to anchor the hard part first — putting the `ie` in the middle of "believe"
before anything else — taps that slot and gets it. The out-of-order path is
there for the child who thinks that way without taxing the child who doesn't.

**Taking a letter back.** Tapping a filled slot lifts its letter back to the
bank and leaves that slot selected. One rule covers correction, and it means
the bank is always exactly the letters not yet used.

**Reuses:** `practiceLists()`, `reviewWords`, `speak()`, the hint field, the
"Check it" button pattern, the session/stamp/history path — and the keypad's
whole tap-a-tile-to-build-a-string idiom.

**New:** a slot board and a consumable bank. State is roughly
`{ slots: [], bank: [], sel: 0 }` with `unSelect(i)`, `unPlace(bankIdx)` and
`unLift(i)`, plus the null-out in `go()` that §4 requires.

**What tapping fixes for free.** The drag version had a tile-identity hazard:
410 of 855 words repeat a letter, and swapping the two `t`s in "little" changes
the DOM while looking identical, so comparing tile arrangement rather than the
assembled string marks a correct board wrong. Tapping makes this vanish — the
child places a *character* into a slot, so the assembled string is built
directly and compared directly. Length gets easier too: slots and bank are
static layout that can wrap, so the 120 words of 9+ letters and the 14-letter
longest ("characteristic", "administration") are a wrapping problem rather than
a drag-geometry one.

**What remains true regardless of interaction:**

- **Anagrams that are also real words.** Six pairs collide in the existing
  corpus: silent/listen, dear/read, grown/wrong, three/there, quiet/quite,
  tired/tried. Asked to unscramble "listen", a child who builds "silent" is
  right about English and would be marked wrong. Check the assembled string
  against the child's own word set before rejecting it, and when it is another
  real word, say so — "that's a word! but not this one" — rather than buzzing.
  Note the limit: `realWordSet()` is the child's own lists, review and graduated
  words, not a dictionary, so it catches these six and nothing else.
- **36 words are 3 letters or shorter**, which is not a puzzle. Filter them out
  or accept wasted rounds.
- **Apostrophes.** `o'clock`, `don't`, `we're` and friends are in the lists.
  Pre-place the apostrophe in its slot and keep it out of the bank — the kinder
  reading, and it matches the v6.4 apostrophe work, where the key is always
  present so it never signals which words need one.
- **The scramble must not be the answer.** Reshuffle until the bank order
  differs from the word.

**One thing the bank gives away.** Showing the exact letter inventory answers
"is it one `l` or two" before the child starts. Doubling is a real spelling
skill and this game cannot test it — seeing two `t`s and having to place both
still teaches something, but it is recognition of the doubling rather than
recall of it. Worth knowing rather than worth fixing; Missing Letters (5.2) is
where doubling can actually be tested, by blanking one half of the pair.

**Cost:** low, where the drag version was high. This is now a peer of 5.2 and
5.3 rather than the expensive idea, and it is the only one of the three that
is a game rather than a Practice variant.

---

### 5.1a The slot board is one primitive, not one game

Worth noticing before anything gets built: with 5.1 as tapping rather than
dragging, **5.1 and 5.2 are the same machine**. Both are a row of per-letter
slots filled by tapping a source. They differ in exactly two parameters:

| | Unscramble | Missing Letters |
|---|---|---|
| Slots pre-filled | none | all but 2–3 |
| Tap source | a consumable bank of the word's letters | the existing keypad, unrestricted |
| Answers "one `l` or two" | the bank does | the child must |

Build the slot board once — slots, selection, auto-advance, lift-to-correct,
assemble-and-compare — and the second game is its configuration rather than a
second engine. That is a real argument for doing 5.1 and 5.2 together, and for
doing them before 5.3 or 5.5, either of which could then reuse the same board.

---

### 5.2 Missing Letters

The word appears with two or three letters blanked — `b_lie_e` — and the child
fills them from the existing on-screen keypad. Hear-it and hint available.

**Reuses:** the slot board from 5.1 if it exists (see 5.1a — this game is that
board with most slots pre-filled and the keypad as the tap source), `kbRows()`
and the whole keypad idiom, `foldApos()`, `speak()`, plus — the point of the idea — `observedErrorsFor(word)`. The blanks do not
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

**Reuses:** tap-to-choose, the same as everything else here — a word and two
or three bucket buttons. No new interaction at all. If 5.1 and 5.2 have
already established the slot board, this does not even need it: Rule Sort is
one tap per word.

It is also the game that can teach what 5.1 structurally cannot. The bank in
Unscramble answers "one `l` or two" for free; a Rule Sort bucket asks it
directly.

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
| 5.2 Missing Letters | slot board + existing keypad | none | Low |
| 5.3 Sentence Slot | existing keypad | none | Low |
| 5.1 Unscramble | slot board + a letter bank | none | Low |
| 5.5 Rule Sort | tap a bucket | **a rule tag on 855 words** | Highest |

Four of the five are now cheap, and the ranking barely separates them. That is
a change from this file's first draft, where Unscramble was the expensive idea
because it was specified as a drag; respecifying it as tapping (5.1) moved it
down a whole tier and made it share an engine with 5.2 (5.1a).

The useful split is no longer cost but what each one asks of the child:

| | What the child does | Teaches |
|---|---|---|
| 5.4 Four-Up | picks the right spelling from four | recognition |
| 5.1 Unscramble | orders letters they are given | sequence; not doubling |
| 5.2 Missing Letters | recalls the missing letters | the specific trap, from their own error history |
| 5.3 Sentence Slot | spells the whole word in context | production, with meaning attached |
| 5.5 Rule Sort | classifies by pattern | the rule behind the word |

The shipped game is recognition only. Every idea here except 5.4 moves toward
production, and they do it in that order — which is also a reasonable build
order, since each step reuses the one before it.

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
