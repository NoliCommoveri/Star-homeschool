// Spelling Star v6.4: practice sets, per-list tests, and list order.
//
// The two claims this suite exists to hold down are the two the redesign was
// for: practicing several lists together never merges or retires a list, and a
// Test is always exactly one list, recorded under that list's own title — which
// is what a gradebook needs to file it as its own assignment. The third is the
// reordering that "the next list" always depended on and that nothing could
// actually change until now.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const server = await serveRepo();
const BASE = server.url;
const { check, report } = createChecker();
const browser = await launchBrowser();

const FILE = 'spelling-star-v6_3.html';
const KEY = 'spellingstar-ada';

function profile() {
  return {
    childName: 'Ada', pin: '1234', scoring: 'percent', gradeLevel: '3', showHistory: true, pretestGlobal: false,
    gamesEnabled: true, advanceEnabled: true, advanceThreshold: 90, theme: 'classic', keyboard: 'abc',
    repeatStandard: 5, repeatHard: 8,
    lists: [
      { id: 'w1', name: 'Week 1', desc: '', pretest: 'skip', grade: '3',
        words: [{ word: 'cat', hint: 'A pet', sentence: 'The cat sat.' }], bonus: [] },
      { id: 'w2', name: 'Week 2', desc: '', pretest: 'skip', grade: '3',
        words: [{ word: 'dog', hint: 'A pet', sentence: 'The dog ran.' }], bonus: [] },
      // Requires a pretest and has never been sat: gated, and so not practicable.
      { id: 'u5', name: 'Unit 5', desc: '', pretest: 'require', grade: '5',
        words: [{ word: 'rhythm', hint: 'h', sentence: 's' }], bonus: [] },
    ],
    activeListId: 'w1',
    practiceListIds: [],
    reviewWords: [],
    sessions: [],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', studyEnabled: true, practiceEnabled: true, testEnabled: true, repeatEnabled: true, gamesEnabled: true })),
    graduated: [],
    sync: { enabled: true, endpoint: '/api', childId: 'child-ada', deviceId: 'tablet-1', deviceToken: 'tok', ackedIds: [], appliedCommandIds: [], lastPushAt: null },
  };
}

async function open(label, p = profile()) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const syncBodies = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });
  await page.route('**/api/**', async (route) => {
    syncBodies.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ accepted: [], commands: [] }) });
  });
  await page.addInitScript(([k, prof]) => {
    localStorage.setItem(k, JSON.stringify(prof));
    localStorage.setItem('starhomeschool-childid-ada', 'child-ada');
  }, [KEY, p]);
  await page.goto(`${BASE}/${FILE}`);
  await page.waitForTimeout(500);
  const read = async () => JSON.parse(await page.evaluate((k) => localStorage.getItem(k), KEY));
  console.log('\n[' + label + ']');
  return { page, read, errors, syncBodies, close: () => ctx.close() };
}

// Spells every queued word correctly. Test/Pretest auto-advance on a timer;
// Practice waits for the child, so it is stepped by hand.
async function answerAll(page) {
  await page.evaluate(() => beginSession());
  for (let guard = 0; guard < 40; guard++) {
    const more = await page.evaluate(() => {
      if (!S || S.idx >= S.queue.length) return false;
      S.typed = S.queue[S.idx].word;
      submitWord();
      if (!S.isTest) nextWord();
      return true;
    });
    if (!more) break;
    await page.waitForTimeout(1150);
  }
}

// ------------------------------------- adding a list is additive and undoable ---
{
  const t = await open('Practice set: adding and removing');

  check('home offers the practice-set door', (await t.page.textContent('#app')).includes('Choose lists to practice'));
  check('it is not one of the big activity buttons', await t.page.evaluate(() =>
    ![...document.querySelectorAll('button.big')].some((b) => /Choose lists/.test(b.textContent))));

  await t.page.evaluate(() => go('practiceset'));
  const setScreen = await t.page.textContent('#app');
  check('the gated list is not offered', !setScreen.includes('Unit 5'), setScreen.slice(0, 200));
  check('an ungated list is', setScreen.includes('Week 2'));

  // Step one changes nothing — the whole point of the two-step.
  await t.page.evaluate(() => askAddPracticeList('w2'));
  check('the confirm screen names the list', (await t.page.textContent('#app')).includes('Practice "Week 2" too?'));
  check('nothing is committed until it is confirmed', (await t.read()).practiceListIds.length === 0);

  await t.page.evaluate(() => doAddPracticeList('w2'));
  let d = await t.read();
  check('confirming adds it', JSON.stringify(d.practiceListIds) === '["w2"]', d.practiceListIds);
  check('no words moved between lists', d.lists.find((l) => l.id === 'w1').words.length === 1
    && d.lists.find((l) => l.id === 'w2').words.length === 1, d.lists.map((l) => l.words.length));
  check('no list was retired', d.lists.length === 3, d.lists.map((l) => l.name));
  check('the assigned list did not change', d.activeListId === 'w1', d.activeListId);

  await t.page.evaluate(() => go('home'));
  check('home names what is being practiced alongside', (await t.page.textContent('#app')).includes('Also practicing'));

  // A misfire is undoable from the same screen, and undoing costs nothing.
  await t.page.evaluate(() => doRemovePracticeList('w2'));
  d = await t.read();
  check('removing it puts things back', d.practiceListIds.length === 0, d.practiceListIds);
  check('the list itself survives being taken out', d.lists.some((l) => l.id === 'w2'));
  check('a gated list cannot be added at all', await t.page.evaluate(() => { addPracticeList('u5'); return (data.practiceListIds || []).length === 0; }));
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------ practice spans, tests never do ---
{
  const p = profile();
  p.practiceListIds = ['w2'];
  const t = await open('Practice spans the set; a test is one list', p);

  await t.page.evaluate(() => go('practice'));
  const queue = await t.page.evaluate(() => S.queue.map((w) => w.word).sort());
  check('practice draws from both lists', JSON.stringify(queue) === '["cat","dog"]', queue);
  await answerAll(t.page);
  let d = await t.read();
  const practice = d.sessions.find((s) => s.mode === 'practice');
  check('the practice sitting is stamped with the assigned list', practice.listId === 'w1', practice.listId);
  check('and records every list it covered', JSON.stringify(practice.coverIds) === '["w1","w2"]', practice.coverIds);
  check('each answer remembers which list lent the word',
    practice.results.every((r) => r.listId) && practice.results.some((r) => r.listId === 'w2'), practice.results);

  // Test: the child is asked which list, and the answer is what the score is filed under.
  await t.page.evaluate(() => go('test'));
  const picker = await t.page.textContent('#app');
  check('a multi-list set asks which list the test is on', picker.includes('Which list are you testing on?'));
  check('no session started until the child picks', await t.page.evaluate(() => S === null));

  await t.page.evaluate(() => startSession('test', 'w2'));
  const testQueue = await t.page.evaluate(() => S.queue.map((w) => w.word));
  check('the test holds only the chosen list', JSON.stringify(testQueue) === '["dog"]', testQueue);
  await answerAll(t.page);
  d = await t.read();
  const test = d.sessions.find((s) => s.mode === 'test');
  check('the score is filed under the chosen list', test.listName === 'Week 2' && test.listId === 'w2', test);
  check('under that list\'s own grade', test.listGrade === '3', test.listGrade);
  check('and is not marked as spanning lists', test.coverIds === undefined, test.coverIds);
  check('the assigned list has no test on record from it', !d.sessions.some((s) => s.mode === 'test' && s.listId === 'w1'));

  // Now the other list's test, so the gradebook has two rows under two titles.
  await t.page.evaluate(() => { go('home'); startSession('test', 'w1'); });
  await answerAll(t.page);
  d = await t.read();
  const titles = d.sessions.filter((s) => s.mode === 'test').map((s) => s.listName).sort();
  check('two tests, two titles', JSON.stringify(titles) === '["Week 1","Week 2"]', titles);

  const csv = await t.page.evaluate(async () => {
    let captured = null;
    const realCreate = URL.createObjectURL;
    const realClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = (blob) => { captured = blob; return 'about:blank'; };
    HTMLAnchorElement.prototype.click = function () {};
    try { exportGradebookCSV(); } finally {
      URL.createObjectURL = realCreate;
      HTMLAnchorElement.prototype.click = realClick;
    }
    return captured ? await captured.text() : null;
  });
  const csvRows = (csv || '').trim().split('\n');
  check('the gradebook export is one row per sitting', csvRows.length === 3, csvRows);
  // Oldest first, like the word-level export: Week 2 was tested first above.
  check('with the list title as the assignment title', csvRows[1].includes('"Week 2"') && csvRows[2].includes('"Week 1"'), csvRows);
  check('and no practice sitting in it', !csv.includes('practice'), csv);

  await t.page.evaluate(() => { parentUnlocked = true; renderParent('results'); });
  const parentView = await t.page.textContent('#app');
  check('the parent Test scores card lists both titles',
    parentView.includes('Test scores') && parentView.includes('Week 1') && parentView.includes('Week 2'));
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------------ list order ---
{
  const t = await open('List order');

  check('order starts as the parent built it', await t.page.evaluate(() => data.lists.map((l) => l.id).join(',')) === 'w1,w2,u5');
  check('"the next list" reads that order', await t.page.evaluate(() => nextListFor(activeList()).id) === 'w2');

  await t.page.evaluate(() => { parentUnlocked = true; moveList('u5', -1); });
  let order = await t.page.evaluate(() => data.lists.map((l) => l.id).join(','));
  check('the parent area can move a list up', order === 'w1,u5,w2', order);
  check('and that changes what comes next', await t.page.evaluate(() => nextListFor(activeList()).id) === 'u5');
  check('moving past the end is a no-op', await t.page.evaluate(() => { moveList('w2', 1); return data.lists.map((l) => l.id).join(','); }) === 'w1,u5,w2');

  // The phone sends a whole order composed against a stale snapshot: it never
  // saw 'later', and 'ghost' no longer exists.
  await t.page.evaluate(() => {
    data.lists.push({ id: 'later', name: 'Typed on the tablet', desc: '', pretest: 'skip', grade: '3', words: [], bonus: [] });
    syncQueueCommands([{ id: 'r-1', kind: 'reorder-lists', payload: { order: ['w2', 'ghost', 'u5', 'w1'] }, createdAt: Date.now() }]);
  });
  await t.page.waitForTimeout(200);
  order = await t.page.evaluate(() => data.lists.map((l) => l.id).join(','));
  check('a reorder command applies the order it was sent', order === 'w2,u5,w1,later', order);
  check('a list the phone never saw keeps its place at the end', order.endsWith('later'));
  check('and the command is acked', (await t.read()).sync.appliedCommandIds.includes('r-1'));

  const before = await t.page.evaluate(() => data.lists.map((l) => l.id).join(','));
  await t.page.evaluate(() => syncQueueCommands([{ id: 'r-2', kind: 'reorder-lists', payload: { order: [] }, createdAt: Date.now() }]));
  await t.page.waitForTimeout(200);
  check('an empty order changes nothing', await t.page.evaluate(() => data.lists.map((l) => l.id).join(',')) === before);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// -------------------------------------- the set survives what the parent does ---
{
  const p = profile();
  p.practiceListIds = ['w2'];
  const t = await open('Invariants around the set', p);

  await t.page.evaluate(() => { parentUnlocked = true; assignList('w2'); });
  let d = await t.read();
  check('assigning an extra makes it the primary, not both', d.activeListId === 'w2' && d.practiceListIds.length === 0, d.practiceListIds);

  await t.page.evaluate(() => { setPracticeList('w1', true); });
  check('the parent can put a list into the set too', JSON.stringify((await t.read()).practiceListIds) === '["w1"]');

  await t.page.evaluate(() => { data.lists = data.lists.filter((l) => l.id !== 'w1'); prunePracticeSet(); persist(); });
  d = await t.read();
  check('deleting a list takes it out of the set', d.practiceListIds.length === 0, d.practiceListIds);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

await browser.close();
await server.close();
process.exit(report('practice-sets'));
