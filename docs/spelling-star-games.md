# Spelling Star — Game Ideas

Status: **mostly backlog.** 5.2 Missing Letters is built and shipped, and with
it the slot board of §5.0 — so 5.1 Unscramble is now a configuration of
existing machinery rather than a new engine. Everything else here is still
unbuilt, and nothing else has been designed past the point where the real
problems show up. The purpose is to have the ideas written down with their
costs attached, so picking one is a decision rather than a fresh start.

Target file: `spelling-star-v6_3.html` (self-contained, like every Star app).

---

## 1. Why this file exists

Spelling Star shipped one game — Spot the Spelling — and the Games hub was
built to hold more: `renderGames()` lays its cards out in a `flex-wrap` row
that had only ever had one card in it (it now has two). The distractor engine carries a comment saying as
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
| Curated content | 60 list files under `wordlists/spelling/`, 988 rows and 855 unique words, **every one** carrying `hint`, `sentence` and two curated `misspellings` (seven rows carry three) | Real material to play against on day one |

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
8. `parent.html` — the mode map (`spotit: { label: 'Spot it', tone: 'play' }`).
   The map's key *order* is semantic as well as its contents: `modeOrder()`
   reads `Object.keys(MODES[appId]).indexOf(mode)` to sort a day's sittings
   on the dashboard, so a new mode picks a position, not just a label
9. `docs/parent-sync-spec.md` §2 — the `mode` enum in the session-payload table
10. A test suite, following `tests/spot-the-spelling.test.mjs`
11. `sw.js` — bump `CACHE_VERSION`

The server needs nothing: `functions/api/sync.js` stores `mode` as free text
and never validates it against a list. Ungraded modes are invisible to
`summary.js`, which filters on `total > 0`.

---

## 5. The ideas

### 5.0 The slot board is one primitive, not one game

This comes first because it changes what the rest of the section is a list of.
With 5.1 specified as tapping rather than dragging, **5.1 and 5.2 are the same
machine**. Both are a row of per-letter slots filled by tapping a source. They
differ in exactly two parameters:

| | Unscramble (5.1) | Missing Letters (5.2) |
|---|---|---|
| Slots pre-filled | none | all but 2–3 |
| Tap source | a consumable bank of the word's letters | the existing keypad, unrestricted |
| Answers "one `l` or two" | the bank does | the child must |

Build the slot board once — slots, selection, auto-advance, lift-to-correct,
assemble-and-compare — and the second game is its configuration rather than a
second engine.

**This is now built**, as `makeBoard()` / `boardSelect()` / `boardPlace()` /
`boardLift()` / `boardComplete()` / `boardString()`, and it deliberately knows
nothing about where the letters come from. Missing Letters (5.2) is the
configuration where most slots arrive given and the keypad is the tap source.
Unscramble (5.1) is the same board with nothing given and a consumable bank,
and should be built as a configuration of those six functions rather than as a
second engine — that is the only thing keeping it cheap.

So the decision this file supported was never "which of five games." It was:

1. **Build the board, or not.** The only medium-sized piece of work in the
   file, and it is paid once. *Paid.*
2. **Which configuration ships first**, and whether 5.3 or 5.5 later reuse it.
   Neither needs it, but both could.

Ranking the five games against each other (§6) hid that, because it charged
5.1 and 5.2 each for a board that only one of them ever pays for.

---

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
static layout that can wrap, so the 120 words of 9+ letters and the three
14-letter longest ("administration", "characteristic", "representative") are a
wrapping problem rather than a drag-geometry one.

**What remains true regardless of interaction:**

- **Anagrams that are also real words.** Six pairs collide in the existing
  corpus: silent/listen, dear/read, grown/wrong, three/there, quiet/quite,
  tired/tried. Asked to unscramble "listen", a child who builds "silent" is
  right about English and would be marked wrong. Check the assembled string
  against the child's own word set before rejecting it, and when it is another
  real word, say so — "that's a word! but not this one" — rather than buzzing.

  **That mitigates the problem rather than solving it, and the gap is wider
  than the six pairs suggest.** `realWordSet()` is the child's own lists plus
  review and graduated words — not the corpus, and not a dictionary — so both
  halves of a pair must be loaded at once for the guard to fire. Only one pair
  ever is: `tired` and `tried` share `Spelling_5.19.csv`. The other five are
  split across lists and mostly across grades (silent 3.18/5.6 vs listen 5.24;
  dear 3.18 vs read 3.19; grown 3.17 vs wrong 3.26/5.24; three 3.2 vs there
  3.29; quiet 5.15 vs quite 5.6), so the guard fires only when the partner
  happens to be in review or graduated — weeks later, if ever.

  It is also aimed at the narrower risk. A child unscrambling "listen" is
  likelier to build *enlist* or *tinsel* than specifically the anagram that is
  on their list, and no list-derived word set will ever hold those. So
  Unscramble will sometimes buzz a child who is right about English. That is
  probably an acceptable price for a game that costs nothing to lose — but it
  should be picked as an accepted cost, not filed as handled.
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

### 5.2 Missing Letters — **built**

*Shipped. `startMissing()` and the slot board in `spelling-star-v6_3.html`,
tests in `tests/missing-letters.test.mjs`. What follows is the idea as
specified; three things changed on contact with the code, noted at the end.*

The word appears with two or three letters blanked — `b_lie_e` — and the child
fills them from the existing on-screen keypad. Hear-it and hint available.

**Reuses:** the slot board (§5.0 — this game is that
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

**Three things the build changed:**

1. **The error span is the board; it is not padded to a quota.** The first
   version treated "two or three blanks" as a target and topped a two-letter
   span up with a random vowel — which turned `bel__ve`, the exact trap, into
   `bel__v_`, a meaningful hole next to a meaningless one. The rule is now:
   where there is error history, the diff decides how many blanks there are
   (capped at three, widened to two if the span is a single letter so the
   board still reads as a puzzle). The 2–3 quota governs only the no-history
   fallback.
2. **A pure insertion has no wrong position to find.** A child who writes
   "untill" for "until" has disagreed with no letter of the real word, so
   trimming the matching head and tail leaves an empty span. `errorSpan()`
   returns the letter beside the insertion instead — which for a doubled
   consonant is the "one `l` or two" question, exactly the thing §5.1 notes
   Unscramble structurally cannot ask.
3. **The game does not write `missedAs`.** Tempting, since a wrong board is a
   real misspelling the child produced — but the blanks constrain what they
   could possibly have typed, so feeding it back into the history that picks
   the blanks is a loop rather than evidence: blank the position they get
   wrong, record that they got it wrong, blank it again forever. Free-typed
   errors from Practice and Test stay the only source. This is narrower than
   the §7 question about the review list and was settled in code; the review
   question is still open and still the parent's.

---

### 5.3 Sentence Slot

The word's sentence is shown with the word blanked out, and the child spells it
into the gap — "She ____ she would be here soon." Hear-the-sentence already
exists as a button in Practice.

**Reuses:** the `sentence` field, which is the most underused asset in the app.
Every word has one, all 988 curated sentences contain their word somewhere in
the string (984 of them on a word boundary), and the child ever meets it in
exactly one place: a "Hear a sentence" button in Practice that speaks it aloud. The only other reference in the file is the CSV
importer setting its default. It is never shown on screen anywhere.

**New:** blanking the word out of its sentence, which is where the edge cases
live:

- `sentence` defaults to the word itself when a parent leaves it blank
  (`String(raw.sentence || "").trim() || word`). A word whose sentence *is* the
  word gives a blank and no context — skip those words rather than showing a
  bare gap.
- Blank on a word boundary. Four sentences in the corpus fail a `\b`-anchored
  match, and they fail for two different reasons:

  | word | sentence | why |
  |---|---|---|
  | fire | "We roasted marshmallows over the **campfire**." | compound |
  | segment | "…divided the lesson into three separate **segments**." | inflection |
  | infect | "…help stop germs from **infecting** others." | inflection |
  | oyster | "…a plate of fresh **oysters** at the restaurant." | inflection |

  Only `fire` is the case the naive-substring worry describes: blanking it
  turns the sentence into "the camp____," which hands the child a different
  word to spell. The other three contain the word plus a suffix, where the
  kinder handling is to blank the inflected form and accept the stem — the
  child spelling "segment" into a gap that was "segments" has done the thing
  being asked. Skipping on a failed anchored match covers all four and costs
  three words out of 855, which is the right first cut; the inflection case is
  worth revisiting only if the corpus grows a lot more of them.
- Match case-insensitively but keep the sentence's capitalisation around the gap.

**Cost:** low. Closer to a Practice variant than a game, which is either the
appeal or the objection.

---

### 5.4 Spot the Spelling: Four-Up

The existing game with four options instead of two, for a child who has
outgrown the coin-flip.

**Reuses:** everything. `distractorsFor()` already returns a ranked *list* and
the game currently picks one entry from it and discards the rest.

**New:** filling out to three wrong options. This is a slightly bigger change
than it sounds, because `distractorsFor()` reaches the generator only when
everything else came up empty:

```js
if (!out.length) push(generateMisspelling(word, banned));
```

Four-Up needs it restructured from *fall back if empty* to *top up to N* —
still small, but it is a change to a shared function rather than a call site.

And that restructure is where the risk actually sits. Because every curated
row carries two misspellings (§3), `generateMisspelling()` almost never fires
on the shipped lists today; it is reserved for parent-typed words with no
curation. Four-Up would make it routine — three distractors from two curated
ones means a generated third on most rounds — so Four-Up is the first feature
that would put a ranked generator on the critical path for real content.

The plausibility bar also matters more with four options than two: a round with
one real error and two obviously-typo distractors is *easier* than the
two-option version, because the child eliminates on shape without reading. That
is exactly the silent failure `tests/spot-the-spelling.test.mjs` was written to
catch, and the suite would need extending alongside.

**Cost:** lowest of all in lines of code, but not in risk, and it is a
difficulty tier rather than a new game — it does not add a second card to the
hub so much as a setting to the first.

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

Costed honestly, per §5.0: the slot board is one shared item, and 5.1 and 5.2
are configurations of it rather than two engines.

| Item | Interaction | New content needed | Cost |
|---|---|---|---|
| **The slot board** (§5.0) | slots, selection, auto-advance, lift-to-correct | none | **Medium — the only real work in this file. ✅ Built** |
| 5.2 Missing Letters | board + existing keypad as the source | none | ✅ Built |
| 5.1 Unscramble | board + a consumable letter bank | none | Low — the board exists; this is a bank and a config |
| 5.4 Four-Up | none — existing | none | Trivial in code; see §5.4 on risk |
| 5.3 Sentence Slot | existing keypad; board optional | none | Low |
| 5.5 Rule Sort | tap a bucket | **a rule tag on 855 words** | Highest |

Read that as one medium decision and a set of cheap ones, not as five
comparable options. An earlier version of this table ranked 5.1 and 5.2 as
peers at "Low" while charging each of them for a slot board — which contradicts
§5.0, where the board is built once. Missing Letters shipped first and carried
the board, so Unscramble is now genuinely cheap.

That is still a large change from the file's first draft, where Unscramble was
the expensive idea because it was specified as a drag. Respecifying it as
tapping (5.1) is what made the board shared in the first place (§5.0).

The useful split is no longer cost but what each one asks of the child:

| | What the child does | Teaches |
|---|---|---|
| 5.4 Four-Up | picks the right spelling from four | recognition |
| 5.1 Unscramble | orders letters they are given | sequence; not doubling |
| 5.2 Missing Letters | recalls the missing letters | the specific trap, from their own error history |
| 5.3 Sentence Slot | spells the whole word in context | production, with meaning attached |
| 5.5 Rule Sort | classifies by pattern | the rule behind the word |

Spot the Spelling was recognition only, and that was the gap. Every idea here
except 5.4 moves toward production, and they do it in that order — which is
also a reasonable build order, since each step reuses the one before it.
Missing Letters was built first for that reason rather than for its cost: it
is the shortest distance from recognition to production, and it is the only
one of the five that aims at the trap a particular child actually falls into.

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
