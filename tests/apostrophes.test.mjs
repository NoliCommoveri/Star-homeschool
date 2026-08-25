// Spelling Star, contractions.
//
// A word list can be nothing but contractions — a week on don't/can't/won't is
// an ordinary week of spelling — and until the keypad grew an apostrophe key
// such a list was not merely awkward but unanswerable: the child could hear
// the word, know the word, and have no key to type it with. The failure was
// silent in the worst way, because it looked to the child like being wrong.
//
// So this suite is mostly about the round trip: the key exists, tapping it
// puts a real apostrophe in the box, and the word that comes back out is
// judged correct. The rest guards the two things that quietly break it — a
// curly apostrophe arriving from a pasted list, and a keypad row wide enough
// to walk off the side of a phone.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const server = await serveRepo();
const BASE = server.url;
const { check, section, report } = createChecker();
const browser = await launchBrowser();

const FILE = 'spelling-star-v6_3.html';
const KEY = 'spellingstar-ada';

// "doesn’t" carries the curly apostrophe a word processor substitutes. A
// parent pasting a week's list out of a document brings it along without ever
// seeing it, and the keypad can only ever type the straight one.
const WORDS = [
  ["don't", 'the short way to say do not'],
  ["can't", 'the short way to say cannot'],
  ['doesn’t', 'the short way to say does not'],
];

function profile(extra = {}) {
  return {
    childName: 'Ada', pin: '1234', scoring: 'percent', gradeLevel: '3', showHistory: true,
    pretestGlobal: false, gamesEnabled: true, advanceEnabled: false, advanceThreshold: 90,
    theme: 'classic', keyboard: 'abc', repeatStandard: 2, repeatHard: 3,
    lists: [{
      id: 'l1', name: 'Contractions', desc: '', pretest: 'skip', grade: '3',
      words: WORDS.map(([word, hint]) => ({ word, hint, sentence: `I ${word} know.` })),
      bonus: [],
    }],
    activeListId: 'l1', practiceListIds: [], reviewWords: [], sessions: [], graduated: [],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', studyEnabled: true, practiceEnabled: true, testEnabled: true, repeatEnabled: true, gamesEnabled: true })),
    sync: { enabled: false, endpoint: '/api', childId: null, deviceId: null, deviceToken: null, ackedIds: [], appliedCommandIds: [], lastPushAt: null },
    ...extra,
  };
}

async function open(p = profile(), viewport) {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });
  await page.addInitScript(([k, prof]) => localStorage.setItem(k, JSON.stringify(prof)), [KEY, p]);
  await page.goto(`${BASE}/${FILE}`);
  await page.waitForTimeout(400);
  return { page, errors, close: () => ctx.close() };
}

// Tapping, not typing: the input is readonly and inputmode=none, so the keypad
// is the only way a word gets into the box, which is the whole point.
async function tap(page, word) {
  for (const ch of word.replace(/’/g, "'")) {
    await page.click(ch === "'" ? '#kb button.kb-punct' : `#kb button:text-is("${ch.toUpperCase()}")`);
  }
}

// ------------------------------------------------------------- the key ------
{
  section('the apostrophe key');
  for (const keyboard of ['abc', 'qwerty']) {
    const t = await open(profile({ keyboard }));
    await t.page.evaluate(() => { startSession('practice'); });
    await t.page.waitForTimeout(150);
    await t.page.evaluate(() => { beginSession(); });
    await t.page.waitForTimeout(200);

    const keys = await t.page.$$eval('#kb button', (bs) => bs.map((b) => b.textContent.trim()));
    check(`${keyboard}: the keypad has an apostrophe`, keys.filter((k) => k === "'").length === 1, keys);
    check(`${keyboard}: it is the last key before erase`, keys[keys.length - 2] === "'", keys.slice(-3));

    // The onclick argument is quoted with &quot; precisely so this works; an
    // apostrophe inside a single-quoted attribute would close the JS string
    // and the key would throw instead of typing.
    await tap(t.page, "can't");
    check(`${keyboard}: tapping it types an apostrophe`, (await t.page.inputValue('#spellInput')) === "can't",
      await t.page.inputValue('#spellInput'));
    check(`${keyboard}: and nothing threw`, t.errors.length === 0, t.errors);
    await t.close();
  }
}

// --------------------------------------------------------- the round trip ---
{
  section('spelling a contraction');
  const t = await open();
  await t.page.evaluate(() => { startSession('practice'); });
  await t.page.waitForTimeout(150);
  await t.page.evaluate(() => { beginSession(); });
  await t.page.waitForTimeout(200);

  const first = await t.page.evaluate(() => S.queue[S.idx].word);
  await tap(t.page, first);   // tap() types the straight apostrophe either way
  await t.page.click('button:has-text("Check it")');
  await t.page.waitForTimeout(200);
  check('a contraction tapped out correctly is marked correct',
    (await t.page.textContent('#fb')).includes('Yes'), await t.page.textContent('#fb'));

  // The straight apostrophe from the keypad against the curly one in the list.
  // Getting this wrong tells a child who spelled the word perfectly that they
  // did not, and no amount of trying again would ever fix it.
  const curly = await t.page.evaluate(() => S.queue.findIndex((q) => q.word.includes('’')));
  check('the pasted list really did keep its curly apostrophe', curly >= 0);
  await t.page.evaluate((i) => { S.idx = i; S.typed = ''; S.attempts = 0; renderWord(); }, curly);
  await t.page.waitForTimeout(150);
  await tap(t.page, "doesn't");
  await t.page.click('button:has-text("Check it")');
  await t.page.waitForTimeout(200);
  check('a word stored with a curly apostrophe accepts the straight one',
    (await t.page.textContent('#fb')).includes('Yes'), await t.page.textContent('#fb'));

  // Same keypad, second engine. Repeat renders its own copy of kbRows(), and
  // its own onclick, so it can regress on its own.
  await t.page.evaluate(() => { go('home'); startRepeat(); });
  await t.page.waitForTimeout(150);
  await t.page.evaluate(() => { beginRepeat(); });
  await t.page.waitForTimeout(200);
  const rw = await t.page.evaluate(() => RP.queue[RP.idx].word);
  await tap(t.page, rw);
  await t.page.click('button:has-text("Check it")');
  await t.page.waitForTimeout(200);
  check('Repeat takes a contraction too', (await t.page.textContent('#fb')).includes('✅'),
    await t.page.textContent('#fb'));

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------------- on the way in -
{
  section('apostrophes fold on entry');
  const t = await open();

  // Door one: a list assigned from the phone dashboard.
  const assigned = await t.page.evaluate(
    () => normalizeAssignedWords(['won’t', { word: 'they’re' }]).map((w) => w.word));
  check('an assigned list is stored with straight apostrophes',
    assigned.join(' ') === "won't they're", assigned);

  // Door two: a parent typing (or pasting) the word into the parent area.
  await t.page.evaluate(() => { parentUnlocked = true; selectedListId = 'l1'; renderParent('words'); });
  await t.page.waitForTimeout(150);
  await t.page.fill('#nw', 'shouldn’t');
  await t.page.click('button:has-text("Add word")');
  await t.page.waitForTimeout(150);
  // Door three, and the likeliest one for a whole week of contractions: a CSV
  // out of a spreadsheet, which curls apostrophes on the parent's behalf
  // whether or not they wanted it to.
  await t.page.setInputFiles('#csvFile', {
    name: 'week.csv', mimeType: 'text/csv',
    buffer: Buffer.from('word,hint\nhaven’t,the short way to say have not\n'),
  });
  await t.page.click('button:has-text("Import CSV")');
  await t.page.waitForTimeout(300);

  const typed = await t.page.evaluate(() => data.lists[0].words.map((w) => w.word));
  check('a word imported from a CSV is stored with a straight apostrophe',
    typed.includes("haven't"), typed);
  check('a word typed in the parent area is stored with a straight apostrophe',
    typed.includes("shouldn't"), typed);
  // Words already saved with a curly apostrophe are left exactly as they are.
  // Rewriting someone's stored list to make a comparison easier is a worse
  // trade than folding at the comparison, which is why both happen.
  check('...and an already-stored curly one is not rewritten behind the parent',
    typed.includes('doesn’t'), typed);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// --------------------------------------------------------------- distractors -
{
  section('Spot the Spelling');
  const t = await open();
  const sample = await t.page.evaluate(() => {
    const out = {};
    for (const w of ["don't", "can't", "doesn't", "won't"]) {
      const seen = new Set();
      for (let i = 0; i < 100; i++) seen.add(generateMisspelling(w));
      out[w] = [...seen];
    }
    return out;
  });

  // The apostrophe is the entire difficulty of a contraction, so it has to be
  // the thing the wrong word gets wrong. Every other rule in RESPELLINGS is
  // anchored to letters and passes a contraction straight through, which is
  // how "don't" used to end up shown against "don'tt" — junk no child writes
  // and none has to read to reject.
  for (const [word, cands] of Object.entries(sample)) {
    const dropped = word.replace("'", '');
    const slid = word.replace(/([a-z])'/, "'$1");
    check(`${word} is offered against ${dropped} or ${slid}`,
      cands.every((c) => c === dropped || c === slid), cands);
  }
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------------------ layout ---
{
  section('the keypad fits a phone');
  // A key nobody can reach is the same bug in a new place. 360px is the narrow
  // end of ordinary phones; the rows overflowed the card at that width even
  // before the apostrophe joined them.
  for (const width of [360, 430]) {
    for (const keyboard of ['abc', 'qwerty']) {
      const t = await open(profile({ keyboard }), { width, height: 900 });
      await t.page.evaluate(() => { startSession('practice'); });
      await t.page.waitForTimeout(150);
      await t.page.evaluate(() => { beginSession(); });
      await t.page.waitForTimeout(250);
      const m = await t.page.evaluate(() => {
        const kb = document.getElementById('kb');
        const rows = [...kb.querySelectorAll('.kb-row')];
        // A row on more than one line is only allowed to be the erase key
        // dropping to a bar of its own; letters must stay in their row.
        const lettersSplit = rows.some((r) => {
          const letters = [...r.children].filter((c) => !c.classList.contains('kb-back'));
          return new Set(letters.map((c) => Math.round(c.getBoundingClientRect().top))).size > 1;
        });
        const apos = kb.querySelector('.kb-punct').getBoundingClientRect();
        return {
          overflows: rows.some((r) => r.scrollWidth > r.clientWidth + 1),
          pageScrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          lettersSplit,
          aposTappable: apos.width >= 24 && apos.height >= 40,
        };
      });
      check(`${width}px ${keyboard}: no row runs off the card`, !m.overflows, m);
      check(`${width}px ${keyboard}: the page does not scroll sideways`, !m.pageScrolls, m);
      check(`${width}px ${keyboard}: a letter row stays one line`, !m.lettersSplit, m);
      check(`${width}px ${keyboard}: the apostrophe is thumb-sized`, m.aposTappable, m);
      await t.close();
    }
  }
}

await browser.close();
await server.close();
process.exit(report('apostrophes') ? 1 : 0);
