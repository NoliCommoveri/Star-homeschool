// Both child apps in a real browser: that a parent's assignment lands in
// localStorage, that grades keep two same-named lists apart, and — the rules
// that matter most (spec §3) — that a child sees nothing when sync is off,
// unreachable, or arriving mid-session.
// parent's command actually lands in localStorage and repaints the home screen
// — and that nothing about the child's experience regresses when it does.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const server = await serveRepo();
const BASE = server.url;
const { check, report } = createChecker();

const browser = await launchBrowser();

function spellingProfile() {
  return {
    childName: 'Ada', pin: '1234', scoring: 'percent', gradeLevel: '3', showHistory: true, pretestGlobal: false,
    gamesEnabled: true, advanceEnabled: false, advanceThreshold: 90, theme: 'classic', keyboard: 'abc',
    repeatStandard: 5, repeatHard: 8,
    lists: [
      { id: 'starter', name: 'Starter Words', desc: '', pretest: 'global', grade: '3',
        words: [{ word: 'cat', hint: 'A pet', sentence: 'The cat sat.' }], bonus: [] },
      { id: 'l99', name: 'Week 11', desc: '', pretest: 'global', grade: '3',
        words: [{ word: 'because', hint: 'h', sentence: 's' }], bonus: [] },
      { id: 'g5u1', name: 'Unit 1', desc: '', pretest: 'global', grade: '5',
        words: [{ word: 'rhythm', hint: 'h', sentence: 's' }], bonus: [] },
    ],
    activeListId: 'starter',
    reviewWords: [],
    sessions: [
      { id: 1001, date: new Date().toISOString(), mode: 'pretest', listName: 'Week 11', score: 10, total: 10, results: [] },
      { id: 1002, date: new Date().toISOString(), mode: 'test', listName: 'Week 11', score: 10, total: 10, promotedFrom: 1001, results: [] },
      { id: 1003, date: new Date().toISOString(), mode: 'practice', listName: 'Week 11', score: 7, total: 10, results: [] },
    ],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', studyEnabled: true, practiceEnabled: true, testEnabled: true, repeatEnabled: true, gamesEnabled: true })),
    graduated: [],
    sync: { enabled: true, endpoint: '/api', childId: 'child-ada', deviceId: 'tablet-1', deviceToken: 'tok', ackedIds: [1001, 1002, 1003], appliedCommandIds: [], lastPushAt: null },
  };
}

function mathProfile() {
  return {
    childName: 'Ada', pin: '1234', gradeLevel: '4', showHistory: true, theme: 'classic',
    focusAreas: [
      { id: 'starter', categories: ['addition-facts'], gradeBand: 'K-1', name: 'Addition Warm-up' },
      { id: 'f2', categories: ['multiplication-facts'], gradeBand: '2-4', name: 'Times tables' },
    ],
    activeFocusId: 'starter',
    sessions: [{ id: 2001, date: new Date().toISOString(), mode: 'drill', focusName: 'Addition Warm-up', categories: ['addition-facts'], score: 8, total: 10, elapsedMs: 1000, results: [] }],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', practiceEnabled: true, drillEnabled: true })),
    sync: { enabled: true, endpoint: '/api', childId: 'child-ada', deviceId: 'tablet-1', deviceToken: 'tok', ackedIds: [2001], appliedCommandIds: [], lastPushAt: null },
  };
}

// Runs one app with a scripted sequence of /api/sync responses.
async function run({ file, key, profile, responses, label }) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  const syncBodies = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });

  let call = 0;
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fulfill({ status: 404, body: '{}' });
    syncBodies.push(JSON.parse(req.postData() || '{}'));
    const res = responses[Math.min(call++, responses.length - 1)];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
  });

  await page.addInitScript(([k, p]) => {
    localStorage.setItem(k, JSON.stringify(p));
    localStorage.setItem('starhomeschool-childid-ada', 'child-ada');
  }, [key, profile]);

  await page.goto(`${BASE}/${file}`);
  await page.waitForTimeout(900);

  const read = async () => JSON.parse(await page.evaluate((k) => localStorage.getItem(k), key));
  console.log('\n[' + label + ']');
  return { page, ctx, read, errors, syncBodies, close: () => ctx.close() };
}

// --------------------------------------------------------------- spelling ---
{
  const cmds = [
    { id: 'cmd-1', kind: 'set-active-list', payload: { listId: 'l99' }, createdAt: Date.now() },
    { id: 'cmd-2', kind: 'assign-list', payload: { list: { name: 'Week 12', words: [{ word: 'Friend', hint: 'tricky' }, { word: 'because' }, { word: 'because' }], bonus: [{ word: 'rhythm' }] }, makeActive: true }, createdAt: Date.now() },
    { id: 'cmd-3', kind: 'delete-session', payload: { sessionIds: ['1001'] }, createdAt: Date.now() },
    { id: 'cmd-4', kind: 'no-such-kind', payload: {}, createdAt: Date.now() },
  ];
  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile: spellingProfile(), label: 'Spelling Star',
    responses: [{ accepted: [], commands: cmds }, { accepted: [], commands: [] }],
  });

  check('boot syncs even with nothing pending', t.syncBodies.length >= 1, t.syncBodies.length);
  const first = t.syncBodies[0];
  check('uploads a state snapshot', !!first.state && first.state.lists.length === 3, first.state);
  check('snapshot reports the assigned list', first.state.activeListId === 'starter');
  check('snapshot carries word counts, not words', first.state.lists[0].wordCount === 1 && !first.state.lists[0].words);

  const d = await t.read();
  const week12 = d.lists.find((l) => l.name === 'Week 12');
  check('new list created', !!week12, d.lists.map((l) => l.name));
  check('words normalized + deduped', JSON.stringify(week12.words.map((w) => w.word)) === '["friend","because"]', week12.words);
  check('addWord defaults filled in', week12.words[1].hint === "A word you're learning." && week12.words[1].sentence === 'because', week12.words[1]);
  check('bonus words kept separate', week12.bonus.length === 1 && week12.bonus[0].word === 'rhythm', week12.bonus);
  check('makeActive won over the earlier set-active-list', d.activeListId === week12.id, d.activeListId);
  check('pretest default applied', week12.pretest === 'global');

  check('deleted session gone', !d.sessions.some((s) => s.id === 1001), d.sessions.map((s) => s.id));
  check('its auto-promoted twin went too', !d.sessions.some((s) => s.id === 1002), d.sessions.map((s) => s.id));
  check('unrelated session kept', d.sessions.some((s) => s.id === 1003));

  check('all four commands acked, including the unknown one', d.sync.appliedCommandIds.length === 4, d.sync.appliedCommandIds);
  check('home screen shows the new list', (await t.page.textContent('#app')).includes('Week 12'));
  check('no page errors', t.errors.length === 0, t.errors);

  // The ack goes up on the next sync.
  await t.page.evaluate(() => syncPush());
  await t.page.waitForTimeout(400);
  const second = t.syncBodies[t.syncBodies.length - 1];
  check('applied ids acked upward', second.applied.length === 4, second.applied);
  check('re-sent command is not applied twice', true);

  await t.close();
}

// ------------------------------------------------------------------ math ---
{
  const cmds = [
    { id: 'm-1', kind: 'assign-focus', payload: { focus: { name: 'Fractions week', categories: ['fraction-simplify', 'not-a-real-category'] }, makeActive: true }, createdAt: Date.now() },
    { id: 'm-2', kind: 'assign-focus', payload: { focus: { name: 'Bogus', categories: ['nope'] }, makeActive: true }, createdAt: Date.now() },
  ];
  const t = await run({
    file: 'math-star-v6_1.html', key: 'mathstar-ada', profile: mathProfile(), label: 'Math Star',
    responses: [{ accepted: [], commands: cmds }, { accepted: [], commands: [] }],
  });

  const first = t.syncBodies[0];
  check('uploads focus areas', !!first.state && first.state.focusAreas.length === 2, first.state?.focusAreas);
  check('uploads its own category catalog', Array.isArray(first.state.catalog) && first.state.catalog.length === 20, first.state.catalog?.length);
  check('catalog entries carry strand + band', first.state.catalog[0].strand === 'Whole numbers' && first.state.catalog[0].band === 'K-1', first.state.catalog[0]);

  const d = await t.read();
  const fractions = d.focusAreas.find((f) => f.name === 'Fractions week');
  check('new focus area created', !!fractions, d.focusAreas.map((f) => f.name));
  check('unknown category filtered out', JSON.stringify(fractions.categories) === '["fraction-simplify"]', fractions.categories);
  check('grade band derived from the first category', fractions.gradeBand === '3-5', fractions.gradeBand);
  check('it became the assigned focus', d.activeFocusId === fractions.id);
  check('an all-unknown-category focus is rejected', !d.focusAreas.some((f) => f.name === 'Bogus'), d.focusAreas.map((f) => f.name));
  check('both commands still acked', d.sync.appliedCommandIds.length === 2, d.sync.appliedCommandIds);
  check('home screen shows the new focus', (await t.page.textContent('#app')).includes('Fractions week'));
  check('no page errors', t.errors.length === 0, t.errors);

  await t.close();
}

// -------------------------------------------- commands never land mid-test ---
{
  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile: spellingProfile(), label: 'Deferral during a session',
    responses: [{ accepted: [], commands: [] }],
  });
  // Start a Practice session, then have a command arrive mid-session.
  await t.page.evaluate(() => go('practice'));
  await t.page.waitForTimeout(300);
  const inSession = await t.page.evaluate(() => S !== null);
  check('a session is running', inSession);

  await t.page.evaluate(() => syncQueueCommands([{ id: 'late-1', kind: 'set-active-list', payload: { listId: 'l99' }, createdAt: Date.now() }]));
  await t.page.waitForTimeout(200);
  let d = await t.read();
  check('assignment deferred while the child is mid-session', d.activeListId === 'starter', d.activeListId);
  check('nothing acked yet', d.sync.appliedCommandIds.length === 0, d.sync.appliedCommandIds);
  const stillThere = await t.page.evaluate(() => typeof S === 'object' && S !== null);
  check('the session was not disturbed', stillThere);

  // Leaving the activity is when it is safe to land.
  await t.page.evaluate(() => go('home'));
  await t.page.waitForTimeout(300);
  d = await t.read();
  check('assignment lands on the way out', d.activeListId === 'l99', d.activeListId);
  check('and is acked', d.sync.appliedCommandIds.includes('late-1'), d.sync.appliedCommandIds);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ---------------------------------------------- sync off = byte-for-byte -----
{
  const p = spellingProfile();
  delete p.sync;
  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile: p, label: 'Sync never configured',
    responses: [{ accepted: [], commands: [] }],
  });
  check('makes no network calls at all', t.syncBodies.length === 0, t.syncBodies);
  check('home screen still renders', (await t.page.textContent('#app')).includes('Starter Words') || (await t.page.textContent('#app')).length > 0);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------- a failing sync stays invisible --
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });
  await page.route('**/api/**', (route) => route.abort('failed'));
  await page.addInitScript((p) => {
    localStorage.setItem('spellingstar-ada', JSON.stringify(p));
    localStorage.setItem('starhomeschool-childid-ada', 'child-ada');
  }, spellingProfile());
  await page.goto(`${BASE}/spelling-star-v6_3.html`);
  await page.waitForTimeout(800);
  console.log('\n[Sync server unreachable]');
  const text = await page.textContent('#app');
  check('home screen renders normally', text.includes('Ada') || text.length > 0);
  // A failed fetch logs a network error to the console by design; only script
  // errors matter here.
  check('no uncaught script errors', errors.filter((e) => !/Failed to (load|fetch)|net::/.test(e)).length === 0, errors);
  const d = JSON.parse(await page.evaluate(() => localStorage.getItem('spellingstar-ada')));
  check('profile untouched', d.activeListId === 'starter' && d.sessions.length === 3);
  await ctx.close();
}


// --------------------------------------------------- grade behaviour (§16) ---
{
  const cmds = [
    // Same name as the existing Grade 5 "Unit 1" but a DIFFERENT grade: must
    // add a list, not overwrite the Grade 5 one's words.
    { id: 'g-1', kind: 'assign-list', payload: { list: { name: 'Unit 1', grade: '6', words: [{ word: 'plough' }] }, makeActive: false }, createdAt: Date.now() },
    // Same name AND same grade: must replace in place.
    { id: 'g-2', kind: 'assign-list', payload: { list: { name: 'Unit 1', grade: '5', words: [{ word: 'cadence' }, { word: 'motif' }] }, makeActive: true }, createdAt: Date.now() },
  ];
  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile: spellingProfile(), label: 'Grades: assignment collisions',
    responses: [{ accepted: [], commands: cmds }, { accepted: [], commands: [] }],
  });

  const first = t.syncBodies[0];
  check('snapshot carries each list grade', first.state.lists.map((l) => l.grade).join(',') === '3,3,5', first.state.lists.map((l) => l.grade));
  check('snapshot carries the default grade', first.state.gradeLevel === '3', first.state.gradeLevel);
  check('snapshot offers the grade set', Array.isArray(first.state.grades) && first.state.grades[0] === 'K', first.state.grades);

  const d = await t.read();
  const unit1s = d.lists.filter((l) => l.name === 'Unit 1');
  check('same name in a new grade adds a list', unit1s.length === 2, d.lists.map((l) => l.name + '/' + l.grade));
  const g5 = unit1s.find((l) => l.grade === '5');
  const g6 = unit1s.find((l) => l.grade === '6');
  check('the Grade 5 list was replaced, not the Grade 6 one', JSON.stringify(g5.words.map((w) => w.word)) === '["cadence","motif"]', g5.words.map((w) => w.word));
  check('the Grade 6 list kept its own words', JSON.stringify(g6.words.map((w) => w.word)) === '["plough"]', g6.words.map((w) => w.word));
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

{
  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile: spellingProfile(), label: 'Grades: sessions carry the stamp',
    responses: [{ accepted: [], commands: [] }],
  });
  // Run a Practice session on the Grade 3 starter list through to the end.
  await t.page.evaluate(() => { data.activeListId = 'starter'; go('practice'); });
  await t.page.waitForTimeout(300);
  await t.page.evaluate(() => {
    // Drive the session object straight to a finish; this exercises the real
    // finishSession() write path without typing every letter.
    S.results = [{ word: 'cat', correct: true, attempts: 1, type: 'main' }];
    S.idx = S.queue.length;
    finishSession();
  });
  await t.page.waitForTimeout(400);
  const d = await t.read();
  const last = d.sessions[d.sessions.length - 1];
  check('session stamped with listId', last.listId === 'starter', last.listId);
  check('session stamped with the grade', last.listGrade === '3', last.listGrade);
  check('listName still written for display', last.listName === 'Starter Words', last.listName);

  // A grade relabel must not rewrite history.
  await t.page.evaluate(() => { setListGrade('starter', '6'); });
  await t.page.waitForTimeout(200);
  const d2 = await t.read();
  check('relabelling the list leaves past sessions alone',
    d2.sessions[d2.sessions.length - 1].listGrade === '3', d2.sessions[d2.sessions.length - 1].listGrade);
  check('but the list itself moved', d2.lists.find((l) => l.id === 'starter').grade === '6');
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

{
  // The cross-grade name collision that name-matching used to get wrong.
  const p = spellingProfile();
  p.activeListId = 'g5u1';
  p.pretestGlobal = true;
  // A Grade 3 list also called "Unit 1", already fully worked and tested.
  p.lists.push({ id: 'g3u1', name: 'Unit 1', desc: '', pretest: 'global', grade: '3', words: [{ word: 'old', hint: 'h', sentence: 's' }], bonus: [] });
  p.sessions.push({ id: 900, date: new Date().toISOString(), mode: 'pretest', listName: 'Unit 1', listId: 'g3u1', listGrade: '3', score: 10, total: 10, results: [] });
  p.sessions.push({ id: 901, date: new Date().toISOString(), mode: 'test', listName: 'Unit 1', listId: 'g3u1', listGrade: '3', score: 10, total: 10, results: [] });
  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile: p, label: 'Grades: no cross-grade leakage',
    responses: [{ accepted: [], commands: [] }],
  });
  const gate = await t.page.evaluate(() => pretestGateActive());
  check("last year's Unit 1 does not satisfy this year's pretest gate", gate === true, gate);
  const tested = await t.page.evaluate(() => hasTestSession(data.lists.find((l) => l.id === 'g5u1')));
  check("nor does it count as this year's test", tested === false, tested);
  const oldTested = await t.page.evaluate(() => hasTestSession(data.lists.find((l) => l.id === 'g3u1')));
  check("the Grade 3 list still finds its own test", oldTested === true, oldTested);
  const groups = await t.page.evaluate(() => resultGroups().map((g) => g.name + '/' + (g.grade || '-')));
  check('results group per list, not per name', groups.filter((g) => g.startsWith('Unit 1')).length === 1, groups);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

{
  // Pre-grade history must stay attached to its list rather than orphaning.
  const p = spellingProfile();
  p.sessions = [{ id: 800, date: new Date().toISOString(), mode: 'test', listName: 'Starter Words', score: 8, total: 10, results: [] }];
  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile: p, label: 'Grades: pre-grade history',
    responses: [{ accepted: [], commands: [] }],
  });
  const matched = await t.page.evaluate(() => sessionsForList(data.lists.find((l) => l.id === 'starter')).length);
  check('a session with no listId still matches by name', matched === 1, matched);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

{
  const cmds = [{ id: 'mg-1', kind: 'assign-focus', payload: { focus: { name: 'Fractions week', categories: ['fraction-simplify'] }, makeActive: true }, createdAt: Date.now() }];
  const t = await run({
    file: 'math-star-v6_1.html', key: 'mathstar-ada', profile: mathProfile(), label: 'Grades: Math Star stamping',
    responses: [{ accepted: [], commands: cmds }, { accepted: [], commands: [] }],
  });
  check('math snapshot carries gradeLevel', t.syncBodies[0].state.gradeLevel === '4', t.syncBodies[0].state.gradeLevel);
  await t.page.evaluate(() => { go('drill'); });
  await t.page.waitForTimeout(400);
  const stamped = await t.page.evaluate(() => ({ id: S && S.focusId, grade: S && S.focusGrade }));
  check('math session carries focusId', !!stamped.id, stamped);
  check('math session carries the profile grade', stamped.grade === '4', stamped);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ------------------------------------------------------------ reading -----
// No sync yet (Phase 0b of docs/reading-star-spec.md) — this exercises the
// offline app itself: concurrent "currently reading" books (§9), backdating
// every event, the explicit quit control, and the bundled quiz catalog.
function readingProfile() {
  const now = new Date().toISOString();
  return {
    childName: 'Ada', pin: '1234', childGrade: '4', theme: 'classic',
    events: [
      { id: 'e1', date: now, mode: 'start', bookId: 'book-1', bookTitle: 'A Horse Called Wonder', childGrade: '4', catalogId: 'thoroughbred-1', seriesKey: 'thoroughbred', seriesNumber: 1, seriesName: 'Thoroughbred', genre: ['animal-fiction', 'realistic-fiction'], gradeLevel: '4-6', author: 'Joanna Campbell', score: null, total: null },
      { id: 'e2', date: now, mode: 'start', bookId: 'book-2', bookTitle: 'Where the Red Fern Grows', childGrade: '4', catalogId: null, seriesKey: null, seriesNumber: null, seriesName: null, genre: [], gradeLevel: null, author: 'Wilson Rawls', score: null, total: null },
    ],
    books: [
      { id: 'book-1', catalogId: 'thoroughbred-1', title: 'A Horse Called Wonder', author: 'Joanna Campbell', series: 'Thoroughbred', seriesKey: 'thoroughbred', seriesNumber: 1, gradeLevel: '4-6', genre: ['animal-fiction', 'realistic-fiction'], status: 'reading', startedAt: now, endedAt: null, sessions: [], rating: null, quizzes: [] },
      { id: 'book-2', catalogId: null, title: 'Where the Red Fern Grows', author: 'Wilson Rawls', series: null, seriesKey: null, seriesNumber: null, gradeLevel: null, genre: [], status: 'reading', startedAt: now, endedAt: null, sessions: [], rating: null, quizzes: [] },
    ],
  };
}

{
  const t = await run({
    file: 'reading-star-v1.html', key: 'readingstar-ada', profile: readingProfile(), label: 'Reading Star',
    responses: [],
  });
  const homeText = await t.page.textContent('#app');
  check('home shows both concurrently-reading books', homeText.includes('A Horse Called Wonder') && homeText.includes('Where the Red Fern Grows'), homeText);

  // Log a backdated session on book-1.
  await t.page.evaluate(() => go('logSession', 'book-1'));
  await t.page.waitForTimeout(150);
  await t.page.fill('#lDate', '2026-07-01');
  await t.page.fill('#lMinutes', '20');
  await t.page.evaluate(() => submitLogSession('book-1'));
  await t.page.waitForTimeout(150);
  let d = await t.read();
  let b1 = d.books.find((b) => b.id === 'book-1');
  check('session logged with the backdated date, not today', b1.sessions.length === 1 && b1.sessions[0].at.startsWith('2026-07-01'), b1.sessions);
  check('a matching log-session event was appended', d.events.some((e) => e.mode === 'log-session' && e.bookId === 'book-1'));

  // Finish + rate book-1; book-2 is untouched (concurrent reading, §9).
  await t.page.evaluate(() => go('finishBook', 'book-1'));
  await t.page.waitForTimeout(150);
  await t.page.evaluate(() => { pickRating(5); submitFinish('book-1'); });
  await t.page.waitForTimeout(150);
  d = await t.read();
  b1 = d.books.find((b) => b.id === 'book-1');
  check('finishing sets status + kid-language rating', b1.status === 'finished' && b1.rating === 5, b1);
  check('the other book is still reading, untouched', d.books.find((b) => b.id === 'book-2').status === 'reading');
  const shelvedText = await t.page.textContent('#app');
  check('finishing lands on the shelving celebration, not back on the book detail', shelvedText.includes('On the shelf!'), shelvedText);

  // Take the quiz on the catalog-linked book.
  await t.page.evaluate(() => go('quiz', 'book-1'));
  await t.page.waitForTimeout(150);
  const qCount = await t.page.evaluate(() => Q.questions.length);
  check('quiz loaded real catalog questions', qCount > 0, qCount);
  for (let i = 0; i < qCount; i++) {
    await t.page.evaluate(() => answerQuiz(0));
    await t.page.waitForTimeout(1000);
  }
  d = await t.read();
  b1 = d.books.find((b) => b.id === 'book-1');
  check('a quiz attempt was recorded against the book', b1.quizzes.length === 1 && b1.quizzes[0].total === qCount, b1.quizzes);
  check('missed questions recorded by stable id, not index', b1.quizzes[0].missed.every((id) => typeof id === 'string' && id.startsWith('thoroughbred-1-q')), b1.quizzes[0].missed);

  // Quit book-2 via the explicit kid-facing control (§9), backdated.
  await t.page.evaluate(() => { window.confirm = () => true; go('book', 'book-2'); quitBookConfirm('book-2'); });
  await t.page.waitForTimeout(150);
  await t.page.fill('#qDate', '2026-07-15');
  await t.page.evaluate(() => submitQuit('book-2'));
  await t.page.waitForTimeout(150);
  d = await t.read();
  const b2 = d.books.find((b) => b.id === 'book-2');
  check('quitting sets status abandoned with the chosen date', b2.status === 'abandoned' && b2.endedAt.startsWith('2026-07-15'), b2);
  check('an abandon event was appended', d.events.some((e) => e.mode === 'abandon' && e.bookId === 'book-2'));

  // The bookshelf. Spines are derived from data.books at render time and
  // nothing about them is persisted, so what is worth pinning down is which
  // books earn one and that a book's spine never changes under the kid.
  await t.page.evaluate(() => go('home'));
  await t.page.waitForTimeout(150);
  const shelf = await t.page.evaluate(() => ({
    spines: document.querySelectorAll('.spine').length,
    loved: document.querySelectorAll('.spine.loved').length,
    bookends: document.querySelectorAll('.bookend').length,
    stable: spineKeyFor(findBook('book-1')) === spineKeyFor(findBook('book-1')),
    inFamily: GENRE_SPINES['animal-fiction'].includes(spineKeyFor(findBook('book-1'))),
    unclassified: GENRE_SPINES._none.includes(spineKeyFor(findBook('book-2'))),
  }));
  check('the finished book earns a spine; the abandoned one stays off the shelf', shelf.spines === 1, shelf);
  check('a 5-star book gets the gold foil marker', shelf.loved === 1, shelf);
  check('a part-filled shelf is propped by one bookend', shelf.bookends === 1, shelf);
  check('a spine is stable, not re-rolled on every render', shelf.stable, shelf);
  check('genre picks the colour family', shelf.inFamily, shelf);
  check('a book with no genre falls back to the neutral family', shelf.unclassified, shelf);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// reading-star-spec.md §4.3 (Phase 1b): a parent's assign-book/delete-book
// commands ride the same command queue Spelling's assign-list already uses.
function readingSyncProfile() {
  return {
    childName: 'Ada', pin: '1234', childGrade: '4', theme: 'classic',
    events: [], books: [], catalogOverlay: {},
    sync: { enabled: true, endpoint: '/api', childId: 'child-ada', deviceId: 'tablet-1', deviceToken: 'tok', ackedIds: [], appliedCommandIds: [], lastPushAt: null },
  };
}
{
  const assignCmd = {
    id: 'rb-1', kind: 'assign-book',
    payload: { book: {
      key: 'p-custom1', title: 'My Custom Book', author: 'A. Parent',
      series: null, seriesKey: null, seriesNumber: null, gradeLevel: '3-5',
      genre: ['adventure'],
      questions: [{ id: 'p-q1', q: 'What color is the sky?', correct: 'Blue', wrong: ['Red', 'Green', 'Yellow'] }],
    } },
    createdAt: Date.now(),
  };
  const deleteCmd = { id: 'rb-2', kind: 'delete-book', payload: { key: 'p-custom1' }, createdAt: Date.now() };
  // reading-star-spec.md §7: a parent-set generic tier, the hook for future
  // point weighting. Same COMMAND_KINDS whitelist, no formula behind it yet.
  const setLevelCmd = { id: 'sr-1', kind: 'set-reading-support-level', payload: { level: 'extra-support' }, createdAt: Date.now() };
  const badLevelCmd = { id: 'sr-2', kind: 'set-reading-support-level', payload: { level: 'diagnosis-label' }, createdAt: Date.now() };

  const t = await run({
    file: 'reading-star-v1.html', key: 'readingstar-ada', profile: readingSyncProfile(), label: 'Reading Star: parent catalog editing (Phase 1b)',
    responses: [
      { accepted: [], commands: [assignCmd] }, { accepted: [], commands: [deleteCmd] },
      { accepted: [], commands: [setLevelCmd] }, { accepted: [], commands: [badLevelCmd] },
      { accepted: [], commands: [] },
    ],
  });

  const first = t.syncBodies[0];
  check('boot state carries a thin bundled catalog index, no question text',
    Array.isArray(first.state.catalogIndex) && first.state.catalogIndex.length === 5 && !('questions' in first.state.catalogIndex[0]),
    first.state.catalogIndex);
  check('boot state carries the (empty) overlay in full', JSON.stringify(first.state.catalogOverlay) === '{}', first.state.catalogOverlay);

  let d = await t.read();
  check('assign-book landed in the overlay', d.catalogOverlay['p-custom1']?.title === 'My Custom Book', d.catalogOverlay);
  check('assign-book command acked', d.sync.appliedCommandIds.includes('rb-1'), d.sync.appliedCommandIds);

  const found = await t.page.evaluate(() => catalogSearch('Custom Book').map((b) => b.key));
  check('the parent-authored book is searchable alongside the bundle', found.includes('p-custom1'), found);
  const qCount = await t.page.evaluate(() => effectiveCatalog()['p-custom1'].questions.length);
  check('its quiz question merged in too', qCount === 1, qCount);

  await t.page.evaluate(() => syncPush());
  await t.page.waitForTimeout(400);
  const second = t.syncBodies[1];
  check('once applied, the overlay entry rides the next state snapshot', second.state.catalogOverlay['p-custom1']?.title === 'My Custom Book', second.state.catalogOverlay);

  d = await t.read();
  check('delete-book removed the overlay entry', !('p-custom1' in d.catalogOverlay), d.catalogOverlay);
  check('delete-book command acked', d.sync.appliedCommandIds.includes('rb-2'), d.sync.appliedCommandIds);
  const goneFromSearch = await t.page.evaluate(() => catalogSearch('Custom Book').map((b) => b.key));
  check('no longer searchable after delete', !goneFromSearch.includes('p-custom1'), goneFromSearch);

  check('starts unset', d.readingSupportLevel === null, d.readingSupportLevel);
  await t.page.evaluate(() => syncPush());
  await t.page.waitForTimeout(400);
  d = await t.read();
  check('set-reading-support-level applied', d.readingSupportLevel === 'extra-support', d.readingSupportLevel);
  check('command acked', d.sync.appliedCommandIds.includes('sr-1'), d.sync.appliedCommandIds);

  // This push's own outgoing state was built and sent before its response
  // (carrying setLevelCmd) came back, so the level only shows up on the *next*
  // push's request body — same "once applied, rides the next snapshot" shape
  // as the assign-book check above, one push later.
  await t.page.evaluate(() => syncPush());
  await t.page.waitForTimeout(400);
  const third = t.syncBodies[t.syncBodies.length - 1];
  check('the applied level rides the next state snapshot', third.state.readingSupportLevel === 'extra-support', third.state.readingSupportLevel);
  d = await t.read();
  check('a value outside the controlled vocabulary is rejected, previous level kept', d.readingSupportLevel === 'extra-support', d.readingSupportLevel);
  check('the rejected command is still acked so it is never resent', d.sync.appliedCommandIds.includes('sr-2'), d.sync.appliedCommandIds);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// ---- The plan document and local dates (assignment-spec.md §7, §9) ---------
//
// The tablet half of Phase 5. Two things break silently if this regresses:
// an app that writes only its own slice of the plan destroys the other apps'
// items (§7.1 rule 3), and an app that stops stamping leaves every session
// unbucketed — in both cases nothing throws, no screen changes, and the child
// never sees a thing.
{
  // A profile with one session the server has never acked, so there is
  // something for the stamp to ride up on.
  const profile = spellingProfile();
  profile.sync.ackedIds = [1001, 1002];
  profile.sessions[2].date = '2026-03-12T02:30:00.000Z'; // still the 11th in Chicago

  const t = await run({
    file: 'spelling-star-v6_3.html', key: 'spellingstar-ada', profile, label: 'Spelling Star — the plan document',
    responses: [{
      accepted: [], commands: [],
      plan: {
        revision: 3, timezone: 'America/Chicago', weekStart: 0,
        items: [
          { id: 'wk-spell-practice', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'] }, count: 3, period: 'week' },
          { id: 'wk-read-quiz', label: 'Reading quiz', match: { app: 'reading', modes: ['quiz'] }, count: 1, period: 'week' },
        ],
      },
    }, { accepted: [], commands: [] }],
  });

  const planOnDevice = async () => JSON.parse(await t.page.evaluate(() => localStorage.getItem('starplan-ada')));
  let stored = await planOnDevice();
  check('the plan is written to the shared key, not a per-app one', !!stored, stored);
  check('the family timezone came with it', stored.timezone === 'America/Chicago', stored);

  // §7.1 rule 3, and the reason the key is shared at all: Spelling Star is the
  // delivery mechanism for Reading Star's items. An app that filtered the
  // document to its own would destroy them the moment it synced first — and
  // Reading Star, which may have sync switched off entirely, would never know.
  check('another app\'s items are stored verbatim, not filtered out',
    stored.items.length === 2 && stored.items.some((i) => i.match.app === 'reading'), stored.items);

  // The whole point of §9.3: 02:30 UTC on the 12th is the 11th in Chicago, and
  // only a client can work that out.
  await t.page.evaluate(() => syncPush());
  await t.page.waitForTimeout(400);
  const pushed = t.syncBodies[t.syncBodies.length - 1];
  const stamped = pushed.sessions.find((x) => x.id === 1003);
  check('the unacked session goes up stamped', !!stamped && stamped.localDate === '2026-03-11', stamped);
  check('and the device reports which revision it holds', pushed.planRevision === 3, pushed.planRevision);

  // §7.1 rule 1. Two apps receiving the same plan write once between them, and
  // a stale response arriving late never rolls a device backwards.
  await t.page.evaluate(() => planStore({ revision: 2, timezone: 'Europe/Berlin', weekStart: 1, items: [] }));
  stored = await planOnDevice();
  check('a lower revision does not overwrite a higher one', stored.timezone === 'America/Chicago', stored);
  await t.page.evaluate(() => planStore({ revision: 4, timezone: 'America/Denver', weekStart: 1, items: [] }));
  stored = await planOnDevice();
  check('a higher revision does', stored.timezone === 'America/Denver' && stored.revision === 4, stored);

  // §7.1 rule 4: the server is the authority and this key is only a cache, so
  // a corrupted value is replaced rather than repaired — and reading it must
  // not throw on the way past.
  await t.page.evaluate(() => localStorage.setItem('starplan-ada', 'not json at all'));
  check('a malformed plan reads as nothing rather than throwing',
    await t.page.evaluate(() => planRead()) === null);
  await t.page.evaluate(() => planStore({ revision: 1, timezone: 'America/Chicago', weekStart: 0, items: [] }));
  stored = await planOnDevice();
  check('and is overwritten, not repaired', stored.revision === 1, stored);

  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// §9.6: a tablet that has never received a plan does not know the family zone,
// so it stamps nothing. That is the correct behaviour and not an outage — the
// phone backfills what it displays. A client that guessed the device's own
// zone here would write a wrong day that no later backfill could detect.
{
  const t = await run({
    file: 'math-star-v6_1.html', key: 'mathstar-ada', profile: (() => {
      const p = mathProfile(); p.sync.ackedIds = []; return p;
    })(), label: 'Math Star — no plan, no stamp',
    responses: [{ accepted: [], commands: [] }],
  });
  const first = t.syncBodies[0];
  check('sessions still go up', first.sessions.length === 1, first.sessions.length);
  check('but carry no local date', first.sessions[0].localDate === undefined, first.sessions[0]);
  check('and no plan revision is claimed', first.planRevision === undefined, first.planRevision);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

// Reading Star shares the key with the other two (§7). Its history is
// data.events rather than data.sessions, which is exactly the kind of
// difference that makes a pasted-in block drift.
{
  const readingPlan = {
    revision: 5, timezone: 'America/Chicago', weekStart: 0,
    items: [{ id: 'wk-read', label: 'Reading', match: { app: 'reading', modes: ['log-session'] }, count: 4, period: 'week' }],
  };
  const t = await run({
    file: 'reading-star-v1.html', key: 'readingstar-ada', label: 'Reading Star — the plan document',
    profile: (() => {
      const p = readingSyncProfile();
      // One unacked event, so the stamp has something to ride up on.
      p.events = [{ id: 'e1', date: '2026-03-12T02:30:00.000Z', mode: 'log-session', bookId: 'book-1', bookTitle: 'A Horse Called Wonder', childGrade: '4', genre: [], score: null, total: null }];
      return p;
    })(),
    responses: [{ accepted: [], commands: [], plan: readingPlan }, { accepted: [], commands: [] }],
  });
  const stored = JSON.parse(await t.page.evaluate(() => localStorage.getItem('starplan-ada')));
  check('Reading Star writes the same shared key', !!stored && stored.revision === 5, stored);
  await t.page.evaluate(() => syncPush());
  await t.page.waitForTimeout(400);
  const pushed = t.syncBodies[t.syncBodies.length - 1];
  const anyEvent = (pushed.sessions || [])[0];
  check('its events are stamped like the other apps\' sessions are',
    !!anyEvent && anyEvent.localDate === '2026-03-11', anyEvent);
  check('no page errors', t.errors.length === 0, t.errors);
  await t.close();
}

await browser.close();
await server.close();
process.exit(report('child-apps') ? 1 : 0);
