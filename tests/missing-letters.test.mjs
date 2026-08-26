// Missing Letters, and the slot board underneath it.
//
// Two different silent failures live in this file.
//
// The first is the game's whole reason for existing. The blanks are supposed
// to land on the letters THIS child actually gets wrong, diffed out of their
// own recorded misspellings — that is the only thing Missing Letters does that
// Spot the Spelling cannot. If pickBlanks() quietly stops reading history and
// falls back to blanking vowels, nothing crashes, no score moves, and the game
// keeps running while it stops being the idea it was built for. A child who
// writes "beleive" every week would go on being asked to fill in a random hole
// in "believe" forever, and nothing would say so.
//
// The second is the board. It is a shared primitive by design (games doc
// §5.0): Unscramble is meant to be the same slots, selection and
// assemble-and-compare with a letter bank instead of the keypad. So the checks
// below drive makeBoard/boardPlace/boardLift directly rather than through the
// game, because they are pinning down the primitive's contract, not this one
// configuration of it.
//
// Plus the rule that outranks both: a game is never a grade (§2, and
// parent-sync-spec §16 — one graded row per list per sitting). A game that
// starts writing score/total competes for the gradebook row that a Test owns.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const server = await serveRepo();
const BASE = server.url;
const { check, report } = createChecker();
const browser = await launchBrowser();

const WORDS = [
  ['believe', 'to think it is true'], ['which', 'what one'], ['little', 'small'],
  ['separate', 'to keep apart'], ['because', 'for the reason that'], ['friend', 'someone you like'],
  ['rhythm', 'a regular beat'], ['strength', 'how strong you are'], ["don't", 'do not'],
  ["o'clock", 'the hour'], ['cat', 'a small pet'], ['sew', 'to join with thread'],
  ['jump', 'to leap'], ['thought', 'past tense of think'], ['characteristic', 'a feature of something'],
];

function profile(extra = {}) {
  return {
    childName: 'Ada', pin: '1234', scoring: 'percent', gradeLevel: '3', showHistory: true,
    pretestGlobal: false, gamesEnabled: true, advanceEnabled: false, advanceThreshold: 90,
    theme: 'classic', keyboard: 'abc', repeatStandard: 5, repeatHard: 8,
    lists: [{
      id: 'l1', name: 'Week 1', desc: '', pretest: 'global', grade: '3',
      words: WORDS.map(([word, hint]) => ({ word, hint, sentence: `A sentence with ${word}.` })),
      bonus: [],
    }],
    activeListId: 'l1', practiceListIds: [], reviewWords: [], sessions: [], graduated: [],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', studyEnabled: true, practiceEnabled: true, testEnabled: true, repeatEnabled: true, gamesEnabled: true })),
    sync: { enabled: false, endpoint: '/api', childId: null, deviceId: null, deviceToken: null, ackedIds: [], appliedCommandIds: [], lastPushAt: null },
    ...extra,
  };
}

// A sitting in which the child wrote these words wrong, in the shape the app
// really records (resultRow's missedAs).
function historyOf(pairs) {
  return [{
    id: 9001, date: new Date().toISOString(), mode: 'practice', listName: 'Week 1', listId: 'l1',
    score: 0, total: 0,
    results: pairs.map(([word, ...misses]) => ({ word, correct: false, attempts: 2, type: 'main', listId: 'l1', missedAs: misses })),
  }];
}

async function open(p = profile()) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript((prof) => localStorage.setItem('spellingstar-ada', JSON.stringify(prof)), p);
  await page.goto(`${BASE}/spelling-star-v6_3.html`);
  await page.waitForTimeout(500);
  return { page, errors, close: () => ctx.close() };
}

// Render a word with its blanks the way the child sees it, so a failure prints
// "bel__ve" rather than a list of indices.
const shown = (word, blanks) => [...word].map((ch, i) => (blanks.includes(i) ? '_' : ch)).join('');

// -------------------------------------------------- the blanks are the point --
{
  const t = await open(profile({
    sessions: historyOf([
      ['believe', 'beleive', 'beleive'],   // written twice: their commonest error
      ['which', 'wich'],
      ['separate', 'seperate'],
      ['friend', 'freind'],
    ]),
  }));
  console.log("\n[the blanks land on the child's own errors, not at random]");

  const got = await t.page.evaluate(() => ({
    believe: pickBlanks('believe'),
    which: pickBlanks('which'),
    separate: pickBlanks('separate'),
    friend: pickBlanks('friend'),
    observed: observedErrorsFor('believe'),
  }));

  check('their misspellings are still read out of session history',
    got.observed.includes('beleive'), got.observed);
  check('believe blanks the ie, the letters they actually swapped',
    shown('believe', got.believe) === 'bel__ve', shown('believe', got.believe));
  check('which blanks the h they dropped (a shorter misspelling still diffs)',
    got.which.includes(1), shown('which', got.which));
  check('separate blanks the a they wrote as e',
    got.separate.includes(3), shown('separate', got.separate));
  check('friend blanks the ie they reversed',
    got.friend.includes(2) && got.friend.includes(3), shown('friend', got.friend));

  // The diff itself, independent of any word history.
  const spans = await t.page.evaluate(() => ({
    believe: errorSpan('believe', 'beleive'),
    which: errorSpan('which', 'wich'),
    same: errorSpan('believe', 'believe'),
    longer: errorSpan('until', 'untill'),
  }));
  check('errorSpan finds the middle that disagrees', JSON.stringify(spans.believe) === '{"from":3,"to":5}', spans.believe);
  check('...handles a missing letter', JSON.stringify(spans.which) === '{"from":1,"to":2}', spans.which);
  check('...handles an extra letter', spans.longer && spans.longer.from <= 4, spans.longer);
  check('...and returns null when their spelling was right', spans.same === null, spans.same);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------ the fallback, and the rules --
{
  const t = await open();   // no history at all
  console.log('\n[a word with no error history still gets a fair board]');

  const got = await t.page.evaluate(() => {
    const words = ['believe', 'which', 'little', 'rhythm', 'strength', "don't", "o'clock", 'thought', 'characteristic'];
    const out = {};
    // 60 draws each: the fallback picks at random among the vowels, and a rare
    // bad branch is exactly what would slip past a single call.
    for (const w of words) out[w] = Array.from({ length: 60 }, () => pickBlanks(w));
    return out;
  });

  const every = (word, fn) => got[word].every(fn);
  const flat = (word) => got[word].flat();

  check('a word with no history still gets blanks', Object.values(got).every((draws) => draws.every((b) => b.length >= 2)),
    Object.entries(got).filter(([, d]) => d.some((b) => b.length < 2)).map(([w]) => w));
  check('vowels are where the fallback blanks (believe)',
    every('believe', (b) => b.every((i) => 'aeiouy'.includes('believe'[i]))), got.believe.slice(0, 4).map((b) => shown('believe', b)));
  check('a word with too few vowels still fills its quota (rhythm)',
    every('rhythm', (b) => b.length === 2), got.rhythm.slice(0, 4).map((b) => shown('rhythm', b)));

  // The apostrophe is given, always. The keypad's apostrophe key is always
  // present so it never signals which words need one; a blank that could fall
  // on an apostrophe would signal it right back.
  const aposIdx = { "don't": 3, "o'clock": 1 };
  for (const [word, idx] of Object.entries(aposIdx)) {
    check(`the apostrophe in ${word} is never blanked`, !flat(word).includes(idx),
      got[word].slice(0, 4).map((b) => shown(word, b)));
  }

  check('a long word gets three blanks, a short one two',
    every('characteristic', (b) => b.length === 3) && every('which', (b) => b.length === 2),
    [got.characteristic[0].length, got.which[0].length]);
  check('never every letter — something is always given',
    Object.entries(got).every(([w, draws]) => draws.every((b) => b.length < [...w].filter((c) => c !== "'").length)));
  check('blanks are never repeated within a board',
    Object.values(got).every((draws) => draws.every((b) => new Set(b).size === b.length)));
  check('blanks come back in reading order',
    Object.values(got).every((draws) => draws.every((b) => b.every((v, i) => i === 0 || b[i - 1] < v))));

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------------- the slot board --
{
  const t = await open();
  console.log('\n[the slot board: selection, auto-advance, lift-to-correct]');

  const b = await t.page.evaluate(() => {
    const out = {};
    // "little" with both t's blanked. This is the case that killed the
    // drag-and-drop design: two identical tiles whose arrangement is
    // indistinguishable in the DOM. The board compares the assembled STRING,
    // so it never arises here — and that is worth a check, because a future
    // change to comparison-by-arrangement would look fine and mark a correct
    // board wrong.
    const dup = makeBoard('little', [2, 3]);
    out.startsOnFirstBlank = dup.sel;
    boardPlace(dup, 't');
    out.advanced = dup.sel;
    boardPlace(dup, 't');
    out.assembled = boardString(dup);
    out.complete = boardComplete(dup);

    // Given letters are not the child's to move.
    const g = makeBoard('believe', [3, 4]);
    boardSelect(g, 0);
    out.givenNotSelectable = g.sel;
    boardLift(g, 0);
    out.givenNotLiftable = g.slots[0].ch;

    // Lift-to-correct: one rule for taking a letter back, and it leaves the
    // slot selected so the next tap replaces it.
    const c = makeBoard('believe', [3, 4]);
    boardPlace(c, 'e'); boardPlace(c, 'i');
    out.wrongOrder = boardString(c);
    boardLift(c, 3);
    out.afterLift = boardString(c);
    out.selAfterLift = c.sel;
    boardPlace(c, 'i');
    out.halfFixed = boardString(c);
    boardLift(c, 4); boardPlace(c, 'e');
    out.fixed = boardString(c);

    // Out-of-order filling: anchor the hard part first.
    const o = makeBoard('believe', [3, 4]);
    boardSelect(o, 4); boardPlace(o, 'e');
    out.anchoredSel = o.sel;         // wraps back to the remaining blank
    boardPlace(o, 'i');
    out.anchored = boardString(o);

    // An incomplete board is never mistaken for a finished one.
    const p = makeBoard('believe', [3, 4]);
    boardPlace(p, 'i');
    out.partialComplete = boardComplete(p);
    return out;
  });

  check('selection starts on the first blank', b.startsOnFirstBlank === 2, b);
  check('placing a letter advances to the next blank', b.advanced === 3, b);
  check('two identical letters assemble correctly (the tile-identity hazard)', b.assembled === 'little', b);
  check('...and the board reports itself complete', b.complete === true, b);
  check('a given letter cannot be selected', b.givenNotSelectable === 3, b);
  check('...or lifted out', b.givenNotLiftable === 'b', b);
  check('a wrong order assembles wrongly, as it should', b.wrongOrder === 'beleive', b);
  check('lifting clears just that slot', b.afterLift === 'bel ive', b);
  check('...and leaves it selected so the next tap replaces it', b.selAfterLift === 3, b);
  // Two letters in the wrong order means two corrections, not one: replacing
  // only the first slot leaves the letter that was already in the second.
  check('...where one lift and one tap changes only that slot', b.halfFixed === 'beliive', b);
  check('...so correcting a swap takes both slots', b.fixed === 'believe', b);
  check('a child can anchor a later blank first', b.anchoredSel === 3 && b.anchored === 'believe', b);
  check('a half-filled board is not complete', b.partialComplete === false, b);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------------ playing a round --
{
  const t = await open(profile({ sessions: historyOf([['believe', 'beleive']]) }));
  console.log('\n[a wrong board costs nothing; the session is never a grade]');

  const play = await t.page.evaluate(async () => {
    startMissing();
    // Pin the rounds so the assertions are about behaviour, not about which
    // words the shuffle happened to deal.
    ML.rounds = [
      { word: 'believe', hint: 'h', sentence: 's', blanks: [3, 4] },
      { word: 'friend', hint: 'h', sentence: 's', blanks: [2, 3] },
    ];
    ML.idx = 0; ML.results = []; ML.attempts = 0; ML.locked = false;
    ML.board = makeBoard('believe', [3, 4]);

    const out = {};
    // A wrong board: the letters stay put and nothing is recorded.
    mlType('e'); mlType('i');
    submitMissing();
    out.afterWrong = { board: boardString(ML.board), results: ML.results.length, locked: ML.locked, attempts: ML.attempts };
    out.retryOffered = document.body.innerHTML.includes('Check it');

    // Fix it the way a child would: tap the wrong slot, retype.
    mlTapSlot(3); mlType('i'); mlTapSlot(4); mlType('e');
    out.beforeCheck = boardString(ML.board);
    submitMissing();
    out.afterRight = { results: JSON.parse(JSON.stringify(ML.results)), locked: ML.locked };

    // The auto-advance timer, without waiting on it.
    nextMissing();
    out.secondWord = ML.rounds[ML.idx].word;
    out.freshBoard = boardString(ML.board);
    out.attemptsReset = ML.attempts;

    // Finish, and inspect what got written.
    mlType('i'); mlType('e');
    submitMissing();
    nextMissing();
    const session = data.sessions[data.sessions.length - 1];
    return { ...out, session: JSON.parse(JSON.stringify(session)) };
  });

  check('a wrong board keeps the letters the child placed', play.afterWrong.board === 'beleive', play.afterWrong);
  check('...records nothing', play.afterWrong.results === 0, play.afterWrong);
  check('...does not lock the board', play.afterWrong.locked === false, play.afterWrong);
  check('...and leaves "Check it" there for another go', play.retryOffered === true, play.retryOffered);
  check('tapping a filled slot and retyping fixes it', play.beforeCheck === 'believe', play);
  check('a right board is recorded once', play.afterRight.results.length === 1, play.afterRight);
  check('...marked as not-first-try, with the attempt count', play.afterRight.results[0].correct === false && play.afterRight.results[0].attempts === 2, play.afterRight);
  check('the next word starts on a fresh empty board',
    play.secondWord === 'friend' && play.freshBoard === 'fr  nd' && play.attemptsReset === 0, play);

  // The rule that outranks everything else in this file.
  check('the session is ungraded: score 0', play.session.score === 0, play.session);
  check('...and total 0, so it cannot claim a gradebook row', play.session.total === 0, play.session);
  check('the session carries the new mode', play.session.mode === 'missing', play.session.mode);
  check('...and is stamped with the list it was played from', play.session.listName === 'Week 1', play.session);
  check('both words are in the session', play.session.results.length === 2, play.session.results);
  check('the second word, filled first time, is marked correct', play.session.results[1].correct === true, play.session.results[1]);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ----------------------------------------------- what the game must NOT write --
{
  const t = await open(profile({ sessions: historyOf([['believe', 'beleive']]) }));
  console.log('\n[a game miss never becomes a recorded misspelling]');

  const got = await t.page.evaluate(() => {
    const before = observedErrorsFor('believe').slice();
    startMissing();
    ML.rounds = [{ word: 'believe', hint: 'h', sentence: 's', blanks: [3, 4] }];
    ML.idx = 0; ML.results = []; ML.attempts = 0; ML.locked = false;
    ML.board = makeBoard('believe', [3, 4]);
    mlType('a'); mlType('a');       // "belaave" — a wrong board
    submitMissing();
    mlTapSlot(3); mlType('i'); mlTapSlot(4); mlType('e');
    submitMissing();
    nextMissing();
    const session = data.sessions[data.sessions.length - 1];
    return {
      before,
      after: observedErrorsFor('believe'),
      rowKeys: Object.keys(session.results[0]).sort(),
      distractors: distractorsFor({ word: 'believe', hint: 'to think it is true' }),
    };
  });

  // The blanks constrain what the child could possibly have typed, so feeding
  // a game miss back into the history that PICKS the blanks would be a loop
  // rather than evidence: blank the position they get wrong, record that they
  // got it wrong, blank it again forever. Free-typed errors from Practice and
  // Test stay the only source.
  check('a wrong board is not added to the error history',
    JSON.stringify(got.after) === JSON.stringify(got.before), { before: got.before, after: got.after });
  check('...so no result row carries missedAs', !got.rowKeys.includes('missedAs'), got.rowKeys);
  check("...and Spot the Spelling's distractors are unmoved by playing", got.distractors[0] === 'beleive', got.distractors);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------- pool, navigation, plumbing --
{
  const t = await open();
  console.log('\n[the pool, and the in-flight round]');

  const got = await t.page.evaluate(() => {
    startMissing();
    const words = ML.rounds.map((r) => r.word);
    const boards = ML.rounds.map((r) => r.blanks.length);
    // The latent-bug class the v6.2 note records: navigating away must clear
    // the in-flight round, or a pending timer fires onto someone else's screen.
    go('home');
    return { words, boards, mlAfterNav: ML, count: words.length };
  });

  check('every dealt word is long enough to be a puzzle',
    got.words.every((w) => [...w].filter((c) => c !== "'").length >= 4), got.words);
  check('...so the three-letter words are left out', !got.words.includes('cat') && !got.words.includes('sew'), got.words);
  check('a burst is 6-8 words', got.count >= 6 && got.count <= 8, got.count);
  check('every round has blanks', got.boards.every((n) => n >= 2), got.boards);
  check('navigating away clears the in-flight round', got.mlAfterNav === null, got.mlAfterNav);

  // The hub, the home-screen label and the tap-through summary all switch on
  // the mode string, and each one is a place a new mode gets forgotten.
  const wired = await t.page.evaluate(async () => {
    go('games');
    const hub = document.body.innerHTML;
    startMissing();
    ML.rounds = [{ word: 'believe', hint: 'h', sentence: 's', blanks: [3, 4] }];
    ML.idx = 0; ML.results = []; ML.attempts = 0; ML.locked = false;
    ML.board = makeBoard('believe', [3, 4]);
    mlType('i'); mlType('e');
    submitMissing();
    nextMissing();
    go('home');
    const home = document.body.innerHTML;
    renderLastResults();
    const summary = document.body.innerHTML;
    return {
      hubHasCard: hub.includes('Missing Letters'),
      homeLabel: home.includes('Missing Letters game'),
      summaryNamesGame: summary.includes('Your last Missing Letters game'),
      summaryNamesWord: summary.includes('believe'),
    };
  });

  check('the Games hub offers it', wired.hubHasCard === true, wired);
  check('the home screen names it as the last session', wired.homeLabel === true, wired);
  check('the tap-through summary has a branch for it', wired.summaryNamesGame === true, wired);
  check('...and lists the words played', wired.summaryNamesWord === true, wired);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

await browser.close();
await server.close();
process.exit(report('missing-letters'));
