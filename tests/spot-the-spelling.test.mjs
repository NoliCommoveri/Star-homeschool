// Spot the Spelling's distractors — the wrong word the child is asked to
// reject. This is the suite for the thing that fails *silently*: a bad
// distractor does not crash, does not error, and does not show up in any
// score. The game keeps working and quietly stops teaching, because a child
// rejects "levae" on shape without reading it and wins every round blind.
//
// So the checks below are mostly about plausibility, which is the property
// with no other alarm on it.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const server = await serveRepo();
const BASE = server.url;
const { check, report } = createChecker();
const browser = await launchBrowser();

const WORDS = [
  ['said', 'past tense of say'], ['catch', 'to grab something'], ['many', 'a large number'],
  ['should', 'ought to'], ['help', 'to give assistance'], ['habit', 'something you do often'],
  ['leave', 'to go away'], ['please', 'a polite word'], ['believe', 'to think it is true'],
  ['three', 'the number 3'], ['stay', 'to remain'], ['swim', 'to move through water'],
  ['stand', 'to be on your feet'], ['often', 'many times'], ['young', 'not old'],
  ['touch', 'to put a hand on'], ['move', 'to change place'], ['have', 'to own'],
  ['light', 'not dark'], ['open', 'not closed'], ['next', 'the one after'],
  ['much', 'a large amount'], ['drink', 'to swallow liquid'], ['your', 'belonging to you'],
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

const sorted = (s) => s.split('').sort().join('');
const isVowel = (c) => 'aeiou'.includes(c);

// An anagram of the word is the signature of the generator this replaced: its
// whole repertoire was moving letters around, which is how "leave" became
// "levae" and "help" became "ehlp".
//
// With two exceptions, and they matter, because they are the difference
// between the two kinds of transposition. English has exactly two places where
// swapping a pair of adjacent letters still spells the same sound:
//
//   ie / ei — "beleive" is the commonest misspelling in the language and reads
//             aloud as "believe"
//   le / el — the syllabic L at the end of a word is spelled both ways for
//             real (circle / tunnel, little / camel), so "circel" and "littel"
//             read correctly and are what children genuinely write
//
// Any other rearrangement destroys the syllable and the word stops being
// readable: "levae", "tsay", "ehlp". Those are slips of the fingers, and no
// child makes them by ear.
const SWAPPABLE = ['ei', 'el'];   // sorted letter pairs that may trade places
function isLetterSalad(word, cand) {
  if (cand.length !== word.length || sorted(cand) !== sorted(word)) return false;
  for (let i = 0; i < word.length; i++) {
    if (word[i] === cand[i]) continue;
    const swapped = word[i + 1] === cand[i] && cand[i + 1] === word[i];
    if (swapped && SWAPPABLE.includes(sorted(word[i] + word[i + 1]))) { i++; continue; }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- generator --
{
  const t = await open();
  console.log('\n[the generator never returns letter salad]');

  // 200 draws per word, because the generator picks at random inside its best
  // rank and a rare bad branch is exactly what would slip through by hand.
  const sample = await t.page.evaluate((words) => {
    const out = {};
    for (const w of words) {
      out[w] = [];
      for (let i = 0; i < 200; i++) out[w].push(generateMisspelling(w));
    }
    return out;
  }, WORDS.map(([w]) => w));

  const anagrams = [];
  const unchanged = [];
  const empty = [];
  for (const [word, cands] of Object.entries(sample)) {
    for (const c of new Set(cands)) {
      if (!c) { empty.push(word); continue; }
      if (c === word) unchanged.push(word);
      if (isLetterSalad(word, c)) anagrams.push(`${word} -> ${c}`);
    }
  }
  check('no distractor moves a consonant around (the "levae" regression)', anagrams.length === 0, anagrams.slice(0, 8));
  check('no distractor is the word itself', unchanged.length === 0, unchanged.slice(0, 8));
  check('every word gets a non-empty distractor', empty.length === 0, empty.slice(0, 8));

  // Regular words have no interesting error to make and must still get a fair
  // round: keeping them is what makes the game confidence-building.
  check('a fully regular word still gets one', new Set(sample.swim).size > 0 && sample.swim.every(Boolean), sample.swim.slice(0, 3));
  check('...and it is not junk', !sample.swim.some((c) => isLetterSalad('swim', c)), sample.swim.slice(0, 3));

  // The errors this child actually makes, per the words their parent reported.
  const has = (w, v) => new Set(sample[w]).has(v);
  check('catch offers cetch', has('catch', 'cetch'), [...new Set(sample.catch)]);
  check('should offers shood or shud', has('should', 'shood') || has('should', 'shud'), [...new Set(sample.should)]);
  check('many offers meny', has('many', 'meny'), [...new Set(sample.many)]);
  check('help offers halp or hilp', has('help', 'halp') || has('help', 'hilp'), [...new Set(sample.help)]);
  check('have keeps its silent e problem (hav, not haiv)', has('have', 'hav'), [...new Set(sample.have)]);

  check('the two same-sound swaps are allowed through',
    !isLetterSalad('believe', 'beleive') && !isLetterSalad('circle', 'circel') && !isLetterSalad('fuel', 'fule'));
  check('...and every other rearrangement is not',
    isLetterSalad('leave', 'levae') && isLetterSalad('stay', 'tsay') && isLetterSalad('three', 'trhee') && isLetterSalad('help', 'ehlp'));

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------- the child's own error --
{
  const withHistory = profile({
    sessions: [
      { id: 9001, date: new Date().toISOString(), mode: 'test', listName: 'Week 1', score: 1, total: 2,
        results: [{ word: 'catch', correct: false, attempts: 1, type: 'main', missedAs: ['cetch'] }] },
      { id: 9002, date: new Date().toISOString(), mode: 'practice', listName: 'Week 1', score: 1, total: 2,
        results: [{ word: 'catch', correct: true, attempts: 3, type: 'main', missedAs: ['cetch', 'ketch'] }] },
    ],
  });
  const t = await open(withHistory);
  console.log('\n[the child\'s own misspelling outranks anything generated]');

  const got = await t.page.evaluate(() => ({
    observed: observedErrorsFor('catch'),
    chosen: distractorsFor({ word: 'catch', hint: 'to grab something' }),
    clean: distractorsFor({ word: 'stand', hint: 'to be on your feet' }),
  }));
  check('their misspellings are read back out of session history', got.observed.includes('cetch'), got.observed);
  check('the one they wrote twice comes first', got.observed[0] === 'cetch', got.observed);
  check('...and it leads the distractor list', got.chosen[0] === 'cetch', got.chosen);
  check('a word they have never missed falls through to the generator', got.clean.length >= 1 && got.clean[0] !== 'cetch', got.clean);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ----------------------------------------------------------- recording misses --
{
  const t = await open();
  console.log('\n[a wrong spelling is recorded, not thrown away]');

  // Test mode: one shot per word, the miss is the result.
  const testRow = await t.page.evaluate(() => {
    startSession('test', 'l1');
    S.queue = [{ word: 'catch', hint: 'h', sentence: 's', type: 'main', listId: 'l1' }];
    S.idx = 0; S.results = []; S.misses = [];
    S.typed = 'cetch';
    submitWord();
    return S.results[0];
  });
  check('a missed word records what the child wrote', JSON.stringify(testRow.missedAs) === '["cetch"]', testRow);
  check('...and the row is still marked wrong', testRow.correct === false, testRow);

  // Practice mode: retries used to vanish entirely — nothing was pushed until
  // the child finally got it right, so every wrong attempt was lost.
  const practiceRow = await t.page.evaluate(() => {
    startSession('practice', 'l1');
    S.queue = [{ word: 'many', hint: 'h', sentence: 's', type: 'main', listId: 'l1' }];
    S.idx = 0; S.results = []; S.misses = [];
    S.typed = 'meny'; submitWord();
    S.typed = 'menny'; submitWord();
    S.typed = 'many'; submitWord();
    return S.results[0];
  });
  check('practice retries are kept even though the word ended correct',
    JSON.stringify(practiceRow.missedAs) === '["meny","menny"]', practiceRow);
  check('...and the row still counts as correct', practiceRow.correct === true, practiceRow);

  const reveal = await t.page.evaluate(() => {
    startSession('practice', 'l1');
    S.queue = [{ word: 'said', hint: 'h', sentence: 's', type: 'main', listId: 'l1' }];
    S.idx = 0; S.results = []; S.misses = [];
    S.typed = 'sed'; submitWord();
    revealWord();
    return S.results[0];
  });
  check('giving up still keeps the attempt', JSON.stringify(reveal.missedAs) === '["sed"]', reveal);

  const carry = await t.page.evaluate(() => {
    startSession('practice', 'l1');
    S.queue = [{ word: 'said', hint: 'h', sentence: 's', type: 'main', listId: 'l1' },
               { word: 'swim', hint: 'h', sentence: 's', type: 'main', listId: 'l1' }];
    S.idx = 0; S.results = []; S.misses = [];
    S.typed = 'sed'; submitWord();
    S.typed = 'said'; submitWord();
    nextWord();
    S.typed = 'swim'; submitWord();
    return S.results[1];
  });
  check('one word\'s misses do not leak onto the next', !carry.missedAs, carry);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------------------ the round --
{
  const t = await open();
  console.log('\n[the round itself]');

  const round = await t.page.evaluate(() => {
    startSpotIt();
    renderSpotItRound();
    const r = SP.rounds[SP.idx];
    return { html: document.getElementById('app').innerHTML, word: r.word, hint: r.hint, misspelled: r.misspelled };
  });
  // Without the hint a homophone round has two right answers and no way to
  // tell which is meant — the child is marked wrong for being right.
  check('the round carries the word\'s hint', !!round.hint, round);
  check('...and shows it on screen', round.html.includes(round.hint), round.hint);
  check('both spellings are offered', round.html.includes(round.word) && round.html.includes(round.misspelled), round);

  const feedback = await t.page.evaluate(() => {
    const out = {};
    renderSpotItRound('correct'); out.correct = document.getElementById('app').innerHTML;
    renderSpotItRound('wrong'); out.wrong = document.getElementById('app').innerHTML;
    out.word = SP.rounds[SP.idx].word;
    return out;
  });
  // Ending on the right spelling either way: seeing a plausible misspelling is
  // the point of the game and also its one risk for a child who spells by sight.
  check('a correct answer ends on the real spelling', feedback.correct.includes(`<strong>${feedback.word}</strong>`), feedback.word);
  check('a wrong answer ends on the real spelling', feedback.wrong.includes(`<strong>${feedback.word}</strong>`), feedback.word);

  const spread = await t.page.evaluate(() => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) { startSpotIt(); SP.rounds.forEach((r) => seen.add(r.word + '|' + r.misspelled)); }
    return [...seen];
  });
  check('the same word is not always shown against the same misspelling',
    new Set(spread.map((s) => s.split('|')[0])).size < spread.length, spread.length);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ----------------------------------------------------------- curated column --
{
  const t = await open(profile({
    lists: [{
      id: 'l1', name: 'Week 1', desc: '', pretest: 'global', grade: '3',
      words: [
        { word: 'said', hint: 'past tense of say', sentence: 's', misspellings: ['sed', 'sead'] },
        { word: 'catch', hint: 'to grab', sentence: 's' },
        { word: 'swim', hint: 'to move in water', sentence: 's' },
      ],
      bonus: [],
    }],
  }));
  console.log('\n[curated misspellings]');

  const got = await t.page.evaluate(() => ({
    said: distractorsFor({ word: 'said', hint: 'h', misspellings: ['sed', 'sead'] }),
    parsedPipe: parseMisspellings('sed|sead'),
    parsedMessy: parseMisspellings(' SED | sead ; sed |'),
    parsedEmpty: parseMisspellings(''),
    // A distractor that is a word the child is separately studying invites
    // them to file it away as a misspelling.
    banned: distractorsFor({ word: 'catch', hint: 'h', misspellings: ['swim', 'cetch'] }),
  }));
  check('curated alternatives are offered', got.said.includes('sed') && got.said.includes('sead'), got.said);
  check('"sed" is reachable only by curation, and now is', got.said[0] === 'sed', got.said);
  check('the pipe column parses', JSON.stringify(got.parsedPipe) === '["sed","sead"]', got.parsedPipe);
  check('...tolerating case, spaces, semicolons and duplicates', JSON.stringify(got.parsedMessy) === '["sed","sead"]', got.parsedMessy);
  check('...and an empty column means none', JSON.stringify(got.parsedEmpty) === '[]', got.parsedEmpty);
  check('a curated word off the child\'s own list is dropped', !got.banned.includes('swim'), got.banned);
  check('...but the rest of the curation survives', got.banned.includes('cetch'), got.banned);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

await browser.close();
await server.close();
process.exit(report('spot-the-spelling') ? 1 : 0);
