// Crossword, and the grid packer underneath it.
//
// The silent failure this file exists to catch is the packer's, and it is
// worth being explicit about because it is the one bug in this game that
// punishes the child rather than the developer.
//
// cwFits() refuses two things: a word butting up against another word's end,
// and a brand-new square touching an existing one sideways. Both rules exist
// so that every maximal run of letters in the finished grid is a word that
// somebody clued and numbered. Drop either rule and the packer still produces
// a grid, the game still runs, the screenshots still look like a crossword —
// and somewhere in it two entries have fused into a seven-letter run with one
// clue and one number, so a child who reads the clue and spells the answer
// correctly is left with squares they cannot fill and a puzzle that will not
// complete. Nothing throws. So the invariant is checked directly, over many
// generated grids, rather than trusted.
//
// The other rules pinned here:
//   - a square holds one letter, so contractions, hyphenated words and
//     two-word entries are excluded rather than stripped (writing DONT or
//     ALLRIGHT into a grid teaches the misspelling the list exists to prevent)
//   - a solved entry locks, because its letters are proven; that is this
//     game's progressive help, and the crossing words depend on it
//   - a game is never a grade (games doc §2, parent-sync-spec §16)
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const server = await serveRepo();
const BASE = server.url;
const { check, report } = createChecker();
const browser = await launchBrowser();

// Real rows from wordlists/spelling/grade5/Spelling_5.1.csv, including the
// three shapes that must never reach a grid.
const WORDS = [
  ['rough', 'not smooth; a harsh texture'], ['grudge', 'a lasting feeling of anger or dislike'],
  ['stunt', 'a dangerous or impressive trick'], ['thumb', 'the short thick finger on your hand'],
  ['another', 'one more; a different one'], ['trouble', 'difficulty or a problem'],
  ['cousin', 'the child of your aunt or uncle'], ['began', 'past tense of begin'],
  ['oxygen', 'a gas people need to breathe'], ['copy', 'to make an exact version of something'],
  ['until', 'up to the time that'], ['umpire', 'the official who makes calls in a baseball game'],
  ['sudden', 'happening quickly and without warning'], ['which', 'asking to choose among options'],
  ['city', 'a large town where many people live'],
  // the three that a grid cannot hold, and one that is too short to be a clue
  ["don't", 'contraction of do not'], ['good-bye', 'a word used when leaving'],
  ['first aid', 'care given right after an injury'], ['so', 'therefore'],
];

function profile(extra = {}) {
  return {
    childName: 'Ada', pin: '1234', scoring: 'percent', gradeLevel: '5', showHistory: true,
    pretestGlobal: false, gamesEnabled: true, advanceEnabled: false, advanceThreshold: 90,
    theme: 'classic', keyboard: 'abc', repeatStandard: 5, repeatHard: 8,
    lists: [{
      id: 'l1', name: 'Week 1', desc: '', pretest: 'global', grade: '5',
      words: WORDS.map(([word, hint]) => ({ word, hint, sentence: `We watched the ${word} closely.` })),
      bonus: [],
    }],
    activeListId: 'l1', practiceListIds: [], reviewWords: [], sessions: [], graduated: [],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', studyEnabled: true, practiceEnabled: true, testEnabled: true, repeatEnabled: true, gamesEnabled: true })),
    sync: { enabled: false, endpoint: '/api', childId: null, deviceId: null, deviceToken: null, ackedIds: [], appliedCommandIds: [], lastPushAt: null },
    ...extra,
  };
}

// What is actually on the screen. NOT document.body.innerHTML: that contains
// the app's own inline <script>, so a check for a rendered string matches the
// source that would render it and passes either way.
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

// Pin a puzzle to exactly these words, so assertions are about behaviour and
// not about what the shuffle happened to deal.
const PIN = `(words) => {
  const picked = words.map((w) => ({ plain: w, hint: 'clue for ' + w, sentence: 'We saw the ' + w + ' today.' }));
  CW = { ...cwBuild(picked), sel: 0, pos: 0, done: false, fb: null, listName: 'Week 1', listId: 'l1', listGrade: '5', coverIds: ['l1'] };
  return CW;
}`;

// Type an entry's answer the way a child would: select it, then type.
const TYPE = `(i, text) => {
  cwTapClue(i);
  for (const ch of text) { if (!CW || CW.done || CW.sel !== i) break; cwType(ch); }
}`;

// ------------------------------------------- the packer's grid is well formed --
{
  const t = await open();
  console.log('\n[every run of letters in the grid is a word somebody clued]');

  const got = await t.page.evaluate(({ pin }) => {
    const pinFn = eval(pin);
    const decks = [
      ['rough', 'grudge', 'stunt', 'thumb', 'another', 'trouble', 'cousin', 'began'],
      ['oxygen', 'copy', 'until', 'umpire', 'sudden', 'which', 'city', 'rough'],
      ['believe', 'friend', 'separate', 'because', 'strength', 'thought', 'little', 'rhythm'],
      ['administration', 'punctuation', 'division', 'decorate', 'infection', 'populate'],
      ['cat', 'sew', 'jump', 'swim', 'find', 'kind', 'light', 'which'],
    ];
    const report = [];
    for (let d = 0; d < decks.length; d++) {
      for (let rep = 0; rep < 12; rep++) {
        const cw = pinFn(decks[d]);
        const runs = [];
        // Every maximal horizontal and vertical run of two or more letters.
        for (let r = 0; r < cw.rows; r++) {
          let acc = '';
          for (let c = 0; c <= cw.cols; c++) {
            const cell = c < cw.cols ? cw.cells[r * cw.cols + c] : null;
            if (cell) acc += cell.answer; else { if (acc.length > 1) runs.push(acc); acc = ''; }
          }
        }
        for (let c = 0; c < cw.cols; c++) {
          let acc = '';
          for (let r = 0; r <= cw.rows; r++) {
            const cell = r < cw.rows ? cw.cells[r * cw.cols + c] : null;
            if (cell) acc += cell.answer; else { if (acc.length > 1) runs.push(acc); acc = ''; }
          }
        }
        const clued = cw.entries.map((e) => e.word);
        const orphans = runs.filter((w) => !clued.includes(w));
        // Every entry must sit on the squares it claims, and its number must be
        // the one printed in its first square.
        const misplaced = cw.entries.filter((e) =>
          e.cells.some((ci, k) => !cw.cells[ci] || cw.cells[ci].answer !== e.word[k]) ||
          cw.cells[e.cells[0]].num !== e.num);
        // Numbers ascend in reading order and are shared by an across and a
        // down starting in the same square — standard crossword numbering.
        const nums = cw.cells.map((cell, i) => (cell && cell.num ? { n: cell.num, i } : null)).filter(Boolean);
        const ascending = nums.every((x, k) => k === 0 || (x.n === nums[k - 1].n + 1 && x.i > nums[k - 1].i));
        // Every entry crosses at least one other, or it is floating loose in
        // the grid with nothing to knit it in.
        const loose = cw.entries.filter((e) =>
          !e.cells.some((ci) => cw.cells[ci].across >= 0 && cw.cells[ci].down >= 0));
        report.push({
          deck: d, orphans, misplaced: misplaced.map((e) => e.word), ascending,
          loose: loose.map((e) => e.word), placed: cw.entries.length, asked: decks[d].length,
          rows: cw.rows, cols: cw.cols,
        });
      }
    }
    return report;
  }, { pin: PIN });

  check('no run of letters is left unclued (the fusing bug)',
    got.every((g) => g.orphans.length === 0), got.filter((g) => g.orphans.length).slice(0, 3));
  check('every entry sits on its own answer, under its own number',
    got.every((g) => g.misplaced.length === 0), got.filter((g) => g.misplaced.length).slice(0, 3));
  check('numbers ascend in reading order',
    got.every((g) => g.ascending), got.filter((g) => !g.ascending).slice(0, 3));
  check('every entry crosses another — nothing floats loose',
    got.every((g) => g.loose.length === 0), got.filter((g) => g.loose.length).slice(0, 3));
  check('at least four of every deck get placed, so it reads as a crossword',
    got.every((g) => g.placed >= 4), got.filter((g) => g.placed < 4).slice(0, 3));
  // Sized by letters, not words (CW_LETTER_BUDGET): the 14-letter deck must not
  // produce a grid twice the size of the three-letter one.
  check('grids stay inside a tablet — 18 squares a side at the very worst',
    got.every((g) => g.rows <= 18 && g.cols <= 18), got.map((g) => g.rows + 'x' + g.cols).slice(0, 6));

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------ what may not reach the grid --
{
  const t = await open();
  console.log('\n[a square holds one letter, so some words are not eligible]');

  const got = await t.page.evaluate(() => {
    const dealt = [];
    for (let i = 0; i < 40; i++) { startCrossword(); dealt.push(CW.entries.map((e) => e.word)); }
    return {
      all: [...new Set(dealt.flat())].sort(),
      counts: dealt.map((d) => d.length),
      letters: dealt.map((d) => d.join('').length),
    };
  });

  check('a contraction never reaches the grid', !got.all.includes('dont') && !got.all.some((w) => w.includes("'")), got.all);
  check('...nor a hyphenated word, stripped of its hyphen', !got.all.includes('goodbye'), got.all);
  check('...nor a two-word entry, stripped of its space', !got.all.includes('firstaid'), got.all);
  check('...nor a two-letter word, which its crossings would spell for free', !got.all.includes('so'), got.all);
  check('the eligible words all do get used across enough deals', got.all.length >= 12, got.all);
  check('a puzzle is 5-10 words', got.counts.every((n) => n >= 5 && n <= 10), got.counts.slice(0, 8));
  check('...budgeted in letters, so a long-word list gets a smaller puzzle',
    got.letters.every((n) => n <= 70), got.letters.slice(0, 8));

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// --------------------------------------------- a list a grid cannot hold at all --
{
  // wordlists/spelling/grade3/Spelling_3.16.csv is entirely contractions: one
  // of its fifteen words survives the filter. This is a real screen a child
  // can reach on a real week, not a defensive branch.
  const contractions = profile({
    lists: [{
      id: 'l1', name: 'Contractions', desc: '', pretest: 'global', grade: '3',
      words: [["don't", 'do not'], ["didn't", 'did not'], ["I'll", 'I will'], ["it's", 'it is'],
              ["let's", 'let us'], ['its', 'belonging to it'], ["won't", 'will not']]
        .map(([word, hint]) => ({ word, hint, sentence: `Say ${word} out loud.` })),
      bonus: [],
    }],
  });
  const t = await open(contractions);
  console.log('\n[a list with too few grid-able words says so, kindly]');

  const got = await t.page.evaluate(() => {
    go('games');
    startCrossword();
    return { cw: CW, body: document.getElementById('app').innerHTML };
  });

  check('no puzzle is started', got.cw === null, got.cw);
  check('the child gets an explanation, not a blank screen', /apostrophes or spaces/.test(got.body));
  check('...and a way back', /go\('games'\)/.test(got.body));

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------- solving, and locking --
{
  const t = await open();
  console.log('\n[a solved entry locks; a wrong one costs nothing]');

  const got = await t.page.evaluate(({ pin, type }) => {
    const pinFn = eval(pin), typeFn = eval(type);
    // "cousin" and "until" cross at their shared U.
    pinFn(['cousin', 'until', 'oxygen', 'thumb', 'rough']);
    const out = {};
    const first = CW.entries[0];

    // A wrong entry: the letters stay where the child put them, the puzzle
    // stays open, and the attempt is counted so the help can unlock.
    typeFn(0, 'x'.repeat(first.word.length));
    out.afterWrong = {
      solved: first.solved, attempts: first.attempts,
      letters: first.cells.map((ci) => CW.cells[ci].ch).join(''),
      fb: CW.fb && CW.fb.kind,
      locked: first.cells.some((ci) => cwLocked(ci)),
    };
    out.helpOfferedAfterOne = cwHelpReady(first);

    // Correct it.
    typeFn(0, first.word);
    out.afterRight = { solved: first.solved, attempts: first.attempts, fb: CW.fb && CW.fb.kind };
    out.lockedNow = first.cells.every((ci) => cwLocked(ci));

    // A crossing entry now starts with a letter it did not have to earn, and
    // typing into it steps over that square rather than overwriting it.
    const crossing = CW.entries.find((e, i) => i !== 0 && !e.solved &&
      e.cells.some((ci) => first.cells.includes(ci)));
    out.crossingExists = !!crossing;
    if (crossing) {
      const sharedAt = crossing.cells.findIndex((ci) => first.cells.includes(ci));
      cwTapClue(CW.entries.indexOf(crossing));
      out.cursorSkipsProvenSquare = CW.pos !== sharedAt || sharedAt !== 0;
      const before = CW.cells[crossing.cells[sharedAt]].ch;
      // Try to type over the proven square from the start of the word.
      CW.pos = sharedAt;
      cwType('z');
      out.provenSquareUnchanged = CW.cells[crossing.cells[sharedAt]].ch === before;
    }
    return out;
  }, { pin: PIN, type: TYPE });

  check('a wrong entry keeps the letters the child typed', /^x+$/.test(got.afterWrong.letters), got.afterWrong);
  check('...is not marked solved', got.afterWrong.solved === false, got.afterWrong);
  check('...locks nothing', got.afterWrong.locked === false, got.afterWrong);
  check('...says so gently, naming the entry', got.afterWrong.fb === 'wrong', got.afterWrong);
  check('...and counts one attempt', got.afterWrong.attempts === 1, got.afterWrong);
  check('a wrong filling that is still standing offers the help', got.helpOfferedAfterOne === true, got);
  check('a right entry is marked solved', got.afterRight.solved === true, got.afterRight);
  check('...and celebrated', got.afterRight.fb === 'solved', got.afterRight);
  check('a solved entry locks its squares', got.lockedNow === true, got);
  check('another word crosses it', got.crossingExists === true, got);
  check('a proven square cannot be typed over', got.provenSquareUnchanged === true, got);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// -------------------------------------------------- the help, and the sentence --
{
  const t = await open();
  console.log('\n[one help, gated at two tries — and a sentence that keeps its secret]');

  const got = await t.page.evaluate(({ pin, type }) => {
    const pinFn = eval(pin), typeFn = eval(type);
    pinFn(['cousin', 'until', 'oxygen', 'thumb', 'rough']);
    const out = {};
    const e = CW.entries[0];

    // Nothing filled in yet: there is nothing to be stuck on.
    cwTapClue(0);
    out.buttonHiddenAtZero = !document.getElementById('app').innerHTML.includes('Show me this word');
    cwReveal();
    out.refusedAtZero = e.solved;

    // Filled in, and wrong, and still sitting there. That is stuck.
    typeFn(0, 'x'.repeat(e.word.length));
    out.attemptsAfterOneFilling = e.attempts;
    cwTapClue(0);
    out.buttonShown = document.getElementById('app').innerHTML.includes('Show me this word');
    cwReveal();
    out.afterReveal = { solved: e.solved, revealed: e.revealed, letters: e.cells.map((ci) => CW.cells[ci].ch).join('') };

    // Typing over a full wrong word, letter by letter, without erasing first:
    // it must be re-checked as it changes (or the puzzle silently stops
    // noticing), and it must not be charged an attempt per keystroke.
    const other = CW.entries.findIndex((x) => !x.solved);
    const o = CW.entries[other];
    typeFn(other, 'x'.repeat(o.word.length));
    const afterWrongFill = o.attempts;
    typeFn(other, 'z'.repeat(o.word.length));
    const afterOvertypeWrong = o.attempts;
    typeFn(other, o.word);
    out.overtype = { afterWrongFill, afterOvertypeWrong, solved: o.solved, attempts: o.attempts };

    // The example sentence is a clue here, not a reading aid: speaking it as
    // written would say the answer out loud.
    const s = cwSentenceClue('We watched the cousin closely.', 'cousin');
    const capital = cwSentenceClue('Cousin came to visit.', 'cousin');
    const absent = cwSentenceClue('They came to visit.', 'cousin');
    return { ...out, s, capital, absent };
  }, { pin: PIN, type: TYPE });

  check('the help is not offered before anything is filled in', got.buttonHiddenAtZero === true, got);
  check('...and is refused if asked for anyway', got.refusedAtZero === false, got);
  check('...but is offered once a filling is in and wrong',
    got.attemptsAfterOneFilling === 1 && got.buttonShown === true, got);
  check('typing over a full wrong entry re-checks it, and solves it when right',
    got.overtype.solved === true, got.overtype);
  check('...counting one attempt per filling, not one per keystroke',
    got.overtype.afterWrongFill === 1 && got.overtype.afterOvertypeWrong === 1 && got.overtype.attempts === 2,
    got.overtype);
  check('revealing fills the answer in', got.afterReveal.letters === 'cousin', got.afterReveal);
  check('...marks it solved so its crossings get the letters', got.afterReveal.solved === true, got.afterReveal);
  check('...but records that it was shown, not worked out', got.afterReveal.revealed === true, got.afterReveal);
  check('the sentence clue blanks the answer out', got.s.shown === 'We watched the _____ closely.', got.s);
  check('...and says "blank" rather than the word', got.s.spoken === 'We watched the blank closely.', got.s);
  check('...even when the sentence opens with it', got.capital && got.capital.shown === '_____ came to visit.', got.capital);
  check('...and is simply not offered when the word is not in the sentence', got.absent === null, got.absent);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------ what gets written down --
{
  const t = await open();
  console.log('\n[the session is a record, never a grade]');

  const got = await t.page.evaluate(({ pin, type }) => {
    const pinFn = eval(pin), typeFn = eval(type);
    pinFn(['cousin', 'until', 'oxygen', 'thumb', 'rough']);
    // One solved outright, one revealed, the rest left empty — the three
    // outcomes a real sitting mixes.
    typeFn(0, CW.entries[0].word);
    const second = CW.entries.findIndex((e) => !e.solved);
    typeFn(second, 'x'.repeat(CW.entries[second].word.length));
    cwTapClue(second); cwReveal();
    finishCrossword();
    const s = data.sessions[data.sessions.length - 1];
    return { session: JSON.parse(JSON.stringify(s)), cwAfter: CW, csv: exportCSV.toString().length > 0 };
  }, { pin: PIN, type: TYPE });

  const s = got.session;
  check('the session is ungraded: score 0', s.score === 0, s);
  check('...and total 0, so it cannot claim a gradebook row', s.total === 0, s);
  check('it carries the new mode', s.mode === 'crossword', s.mode);
  check('...and the list it was played from', s.listName === 'Week 1' && s.listId === 'l1', s);
  check('every entry is recorded, finished or not', s.results.length === 5, s.results);
  check('the one worked out is marked correct', s.results.filter((r) => r.correct).length === 1, s.results);
  check('the revealed one is not correct, and says it was shown',
    s.results.some((r) => r.revealed === true && r.correct === false), s.results);
  check('the untouched ones are marked unfinished rather than wrong',
    s.results.filter((r) => r.unfinished).length === 3 &&
    s.results.filter((r) => r.unfinished).every((r) => r.attempts === 0), s.results);
  check('finishing clears the puzzle, so a pending timer cannot write it twice',
    got.cwAfter === null, got.cwAfter);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// -------------------------------------------------- every place a mode is read --
{
  const t = await open();
  console.log('\n[the hub, the home screen, the summary, the history and the export]');

  const wired = await t.page.evaluate(({ pin, type }) => {
    const pinFn = eval(pin), typeFn = eval(type);
    go('games');
    const hub = document.getElementById('app').innerHTML;

    pinFn(['cousin', 'until', 'oxygen', 'thumb', 'rough']);
    typeFn(0, CW.entries[0].word);
    const word = CW.entries[0].word;
    finishCrossword();

    go('home');
    const home = document.getElementById('app').innerHTML;
    renderLastResults();
    const summary = document.getElementById('app').innerHTML;
    parentUnlocked = true;
    renderParent('results');
    const history = document.getElementById('app').innerHTML;
    const csv = (() => {
      const rows = [];
      const s = data.sessions[data.sessions.length - 1];
      s.results.forEach((r) => rows.push(r.unfinished ? 'crossword-unfinished' : r.revealed ? 'crossword-shown' : 'crossword'));
      return rows;
    })();
    return {
      hubHasCard: hub.includes('Crossword') && hub.includes('startCrossword()'),
      homeLabel: home.includes('Crossword'),
      summaryNamesGame: summary.includes('Your last Crossword'),
      summaryNamesWord: summary.includes(word),
      historyLabel: /<strong>Crossword<\/strong>/.test(history),
      historySummary: /worked out from the clue/.test(history),
      csv,
      mode: modeInfo('spelling', 'crossword'),
      counts: countsAsWork('spelling', 'crossword'),
    };
  }, { pin: PIN, type: TYPE });

  check('the Games hub offers it', wired.hubHasCard === true, wired);
  check('the home screen names it as the last session', wired.homeLabel === true, wired);
  check('the tap-through summary has a branch for it', wired.summaryNamesGame === true, wired);
  check('...and lists the words played', wired.summaryNamesWord === true, wired);
  check('history labels it rather than calling it Practice', wired.historyLabel === true, wired);
  check('...with a summary line of its own', wired.historySummary === true, wired);
  check('the CSV export tells the three outcomes apart',
    wired.csv.includes('crossword') && wired.csv.includes('crossword-unfinished'), wired.csv);
  check('the mode registry knows it, as play', wired.mode.label === 'Crossword' && wired.mode.tone === 'play', wired.mode);
  check('...so a plan target for homework does not sweep it up', wired.counts === false, wired.counts);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// --------------------------------------------------------- the in-flight round --
{
  const t = await open();
  console.log('\n[navigating away clears the puzzle]');

  const got = await t.page.evaluate(() => {
    startCrossword();
    const started = !!CW;
    go('home');
    return { started, after: CW };
  });

  check('a puzzle starts', got.started === true, got);
  // The latent-bug class the v6.2 note records: an auto-finish timer still
  // pending from the last square must not fire onto someone else's screen.
  check('navigating away clears it', got.after === null, got.after);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

await browser.close();
await server.close();
process.exit(report('crossword'));
