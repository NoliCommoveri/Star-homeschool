// parent.html against a mocked API: assigning lists and focus areas, deleting
// a session from both sides at once (§15), and the multi-year Years view (§16).
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const staticServer = await serveRepo();
const BASE = staticServer.url;
const { check, report } = createChecker();

const now = Date.now();
const iso = (msAgo) => new Date(now - msAgo).toISOString();

const server = {
  children: [{ id: 'child-ada', name: 'Ada', created_at: now - 86400000 }],
  sessions: {
    'child-ada:spelling': [
      { id: '1001', date: iso(7200000), deviceId: 'tablet-1', mode: 'pretest', score: 10, total: 10, listName: 'Week 11', results: [{ word: 'because', correct: true, attempts: 1 }] },
      { id: '1002', date: iso(7200000), deviceId: 'tablet-1', mode: 'test', score: 10, total: 10, listName: 'Week 11', promotedFrom: '1001', results: [] },
      { id: '1003', date: iso(3600000), deviceId: 'tablet-1', mode: 'practice', score: 7, total: 10, listName: 'Week 11', results: [{ word: 'friend', correct: false, attempts: 2 }] },
    ],
    'child-ada:math': [
      { id: '2001', date: iso(3600000), deviceId: 'tablet-1', mode: 'drill', score: 8, total: 10, focusName: 'Addition Warm-up', categories: ['addition-facts'], results: [] },
    ],
  },
  snapshots: {
    spelling: [{ childId: 'child-ada', deviceId: 'tablet-1', deviceLabel: "Ada's tablet", updatedAt: now - 600000,
      state: { activeListId: 'starter', lists: [
        { id: 'starter', name: 'Starter Words', desc: 'The beginning', grade: '3', wordCount: 3, bonusCount: 0, pretest: 'global' },
        { id: 'l99', name: 'Week 11', desc: '', grade: '3', wordCount: 8, bonusCount: 2, pretest: 'global' },
      ], gradeLevel: '3', grades: ['K','1','2','3','4','5','6','7'] } }],
    math: [{ childId: 'child-ada', deviceId: 'tablet-1', deviceLabel: "Ada's tablet", updatedAt: now - 600000,
      state: { activeFocusId: 'starter', focusAreas: [
        { id: 'starter', name: 'Addition Warm-up', categories: ['addition-facts'], gradeBand: 'K-1' },
      ], catalog: [
        { id: 'addition-facts', label: 'Addition facts', band: 'K-1', strand: 'Whole numbers' },
        { id: 'fraction-simplify', label: 'Simplify fractions', band: '3-5', strand: 'Fractions' },
        { id: 'fraction-mixed', label: 'Mixed numbers', band: '3-5', strand: 'Fractions' },
      ] } }],
    // reading-star-spec.md §4.3 (Phase 1b): the bundled catalog itself isn't
    // duplicated here — parent.html fetches the real reading-catalog.json
    // directly from the static server, same as the tablet does. Only the
    // overlay (a parent's own content) rides the snapshot.
    reading: [{ childId: 'child-ada', deviceId: 'tablet-1', deviceLabel: "Ada's tablet", updatedAt: now - 600000,
      state: {
        childGrade: '4', grades: ['K','1','2','3','4','5','6','7'], currentlyReading: 1,
        catalogIndex: [],
        catalogOverlay: {
          'p-existing1': {
            title: 'A Parent Book', author: 'Mom', series: null, seriesKey: null, seriesNumber: null,
            gradeLevel: '2-3', genre: ['fantasy'],
            questions: [{ id: 'p-q9', q: "What is the dragon's name?", correct: 'Ember', wrong: ['Blaze', 'Cinder', 'Spark'] }],
          },
        },
      } }],
  },
  commands: {
    spelling: [{ id: 'c-old', childId: 'child-ada', kind: 'set-active-list', payload: { listId: 'l99' }, createdAt: now - 90000, canceled: false, ackCount: 0, firstAppliedAt: null }],
    math: [],
    reading: [],
  },
};

const posted = [];
let lastSummaryQuery = '';
server.summary = {
  spelling: [
    { grade: '3', scopeId: 'g3u1', scopeName: 'Unit 1', best: 0.9,  attempts: 2, firstAt: now - 700 * 86400000, lastAt: now - 690 * 86400000 },
    { grade: '3', scopeId: 'g3u2', scopeName: 'Unit 2', best: 0.75, attempts: 1, firstAt: now - 680 * 86400000, lastAt: now - 680 * 86400000 },
    { grade: '5', scopeId: 'g5u1', scopeName: 'Unit 1', best: 0.6,  attempts: 1, firstAt: now - 20 * 86400000,  lastAt: now - 20 * 86400000 },
    { grade: null, scopeId: null,  scopeName: 'Old list', best: 0.5, attempts: 1, firstAt: now - 900 * 86400000, lastAt: now - 900 * 86400000 },
  ],
  math: [
    { grade: '4', scopeId: 'f1', scopeName: 'Times tables', best: 0.8, attempts: 1, firstAt: now - 30 * 86400000, lastAt: now - 30 * 86400000 },
  ],
};

const browser = await launchBrowser();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

await page.route('**/api/**', async (route) => {
  const req = route.request();
  const url = new URL(req.url());
  const path = url.pathname.replace('/api', '');
  const send = (obj) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

  if (req.method() === 'GET') {
    if (path === '/children') return send({ children: server.children });
    if (path === '/sessions') {
      const key = url.searchParams.get('childId') + ':' + url.searchParams.get('app');
      return send({ sessions: server.sessions[key] || [] });
    }
    if (path === '/child-state') return send({ snapshots: server.snapshots[url.searchParams.get('app')] || [] });
    if (path === '/commands') return send({ commands: server.commands[url.searchParams.get('app')] || [] });
    if (path === '/devices') return send({ devices: [] });
    if (path === '/summary') {
      lastSummaryQuery = url.search;
      return send({ lists: server.summary[url.searchParams.get('app')] || [] });
    }
  }
  if (req.method() === 'POST') {
    const b = JSON.parse(req.postData() || '{}');
    posted.push({ path, body: b });
    if (path === '/commands') {
      const id = 'new-' + posted.length;
      server.commands[b.app].unshift({ id, childId: 'child-ada', kind: b.kind, payload: b.payload, createdAt: Date.now(), canceled: false, ackCount: 0, firstAppliedAt: null });
      return send({ commands: [{ id, childId: 'child-ada' }], createdAt: Date.now() });
    }
    if (path === '/commands/cancel') {
      for (const c of server.commands.spelling) if (b.commandIds.includes(c.id)) c.canceled = true;
      return send({ canceled: b.commandIds.length });
    }
    if (path === '/sessions/delete') {
      const key = 'child-ada:' + b.app;
      server.sessions[key] = server.sessions[key].filter((s) => !b.sessionIds.includes(String(s.id)));
      return send({ deleted: b.sessionIds, rows: b.sessionIds.length, commands: [] });
    }
  }
  return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"no route"}' });
});

await page.addInitScript(() => {
  localStorage.setItem('star-parent-sync', JSON.stringify({ token: 'ptok', familyId: 'fam', deviceId: 'parent-device', role: 'parent' }));
});
await page.goto(`${BASE}/parent.html`);
await page.waitForTimeout(700);

console.log('\n[Dashboard]');
check('dashboard loaded', (await page.textContent('#app')).includes('Last 7 days'));
check('Assign tab present', await page.isVisible('#navAssign'));

console.log('\n[Delete a session from the dashboard]');
await page.click('summary:has-text("Recent sessions")');
await page.waitForTimeout(200);
await page.click('tr.clickable:has-text("Pretest")');
await page.waitForTimeout(200);
check('session detail opened', await page.isVisible('.overlay'));
check('detail offers a delete', await page.isVisible('.overlay button.danger'));
await page.click('.overlay button.danger');
await page.waitForTimeout(500);

const del = posted.find((p) => p.path === '/sessions/delete');
check('delete posted', !!del, posted.map((p) => p.path));
check('it names every id of the merged child', JSON.stringify(del.body.childIds) === '["child-ada"]', del.body.childIds);
check('the auto-promoted twin is deleted with it', del.body.sessionIds.length === 2 && del.body.sessionIds.includes('1002'), del.body.sessionIds);
check('overlay closed', !(await page.isVisible('.overlay')));
await page.click('summary:has-text("Recent sessions")');
await page.waitForTimeout(200);
const rows = await page.textContent('#app');
check('both rows gone from the dashboard', !rows.includes('Pretest'), rows.includes('Pretest'));

console.log('\n[Assign — Spelling Star]');
await page.click('#navAssign');
await page.waitForTimeout(600);
let text = await page.textContent('#app');
check('lists on the tablet shown', text.includes('Starter Words') && text.includes('Week 11'));
check('word counts shown', text.includes('8 words + 2 bonus'), text.match(/\d+ words[^<]*/g));
check('the assigned one is marked', text.includes('Assigned'));
check('reports where the snapshot came from', text.includes("Ada's tablet"));
check('a waiting command is listed', text.includes('Waiting for the tablet'));

await page.click('tr:has-text("Week 11") button:has-text("Assign")');
await page.waitForTimeout(500);
let cmd = posted.filter((p) => p.path === '/commands').pop();
check('set-active-list posted', cmd.body.kind === 'set-active-list' && cmd.body.payload.listId === 'l99', cmd.body);
check('confirmation shown', (await page.textContent('#app')).includes('Assigned'));

console.log('\n[Assign — send a new list]');
await page.fill('#newListName', 'Week 12');
await page.fill('#newListWords', 'because\nfriend, tricky one, My friend is here.\n\nthrough');
await page.fill('#newListBonus', 'rhythm');
await page.click('button:has-text("Send to the tablet")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('assign-list posted', cmd.body.kind === 'assign-list', cmd.body.kind);
check('name carried', cmd.body.payload.list.name === 'Week 12');
check('blank lines dropped', cmd.body.payload.list.words.length === 3, cmd.body.payload.list.words);
check('word/hint/sentence parsed', cmd.body.payload.list.words[1].hint === 'tricky one' && cmd.body.payload.list.words[1].sentence === 'My friend is here.', cmd.body.payload.list.words[1]);
check('bonus words carried', cmd.body.payload.list.bonus[0].word === 'rhythm');
check('makeActive defaults on', cmd.body.payload.makeActive === true);

console.log('\n[Assign — validation]');
await page.fill('#newListName', '');
await page.fill('#newListWords', 'anything');
const before = posted.length;
await page.click('button:has-text("Send to the tablet")');
await page.waitForTimeout(300);
check('an unnamed list is refused client-side', posted.length === before, posted.length - before);
check('and says why', (await page.textContent('#app')).includes('Give the list a name'));

console.log('\n[Assign — cancel a waiting command]');
await page.click('button:has-text("Cancel")');
await page.waitForTimeout(500);
check('cancel posted', posted.some((p) => p.path === '/commands/cancel'), posted.map((p) => p.path));
check('shows as canceled', (await page.textContent('#app')).includes('Canceled'));

console.log('\n[Assign — Math Star]');
await page.click('.app-toggle button:has-text("Math Star")');
await page.waitForTimeout(600);
text = await page.textContent('#app');
check('focus areas shown', text.includes('Addition Warm-up'));
check('category picker built from the tablet catalog', text.includes('Simplify fractions') && text.includes('Mixed numbers'));
check('grouped by strand', text.includes('Fractions') && text.includes('Whole numbers'));

await page.fill('#newFocusName', 'Fractions week');
await page.check('.newFocusCat[value="fraction-simplify"]');
await page.check('.newFocusCat[value="fraction-mixed"]');
await page.click('button:has-text("Send to the tablet")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('assign-focus posted', cmd.body.kind === 'assign-focus' && cmd.body.app === 'math', cmd.body.kind);
check('both categories carried', JSON.stringify(cmd.body.payload.focus.categories) === '["fraction-simplify","fraction-mixed"]', cmd.body.payload.focus.categories);


console.log('\n[Previous years]');
await page.click('#navYears');
await page.waitForTimeout(600);
// The app toggle deliberately survives a view switch, and the section above
// left it on Math Star — so select Spelling explicitly rather than assuming.
check('app choice carried over from the previous view', /app=math/.test(lastSummaryQuery), lastSummaryQuery);
await page.click('.app-toggle button:has-text("Spelling Star")');
await page.waitForTimeout(600);
check('asks for the graded mode, not all sessions', /mode=test/.test(lastSummaryQuery), lastSummaryQuery);
check('asks under every id of the merged child', /childId=child-ada/.test(lastSummaryQuery), lastSummaryQuery);
text = await page.textContent('#app');
check('grades get their own sections', text.includes('Grade 3') && text.includes('Grade 5'));
check('newest grade first', text.indexOf('Grade 5') < text.indexOf('Grade 3'), [text.indexOf('Grade 5'), text.indexOf('Grade 3')]);
check('pre-grade history sorts last and is labelled', text.includes('Before grades') && text.indexOf('Before grades') > text.indexOf('Grade 3'));
check('best score shown as a percentage', text.includes('90%') && text.includes('75%'));
check('grade-level mean is the mean of bests', text.includes('83%'), text.match(/average \*?\*?\d+%/g) || text.match(/average <?\w*>?\d+%/));
check('same list name in two grades appears in both', (text.match(/Unit 1/g) || []).length === 2, (text.match(/Unit 1/g) || []).length);
check('sitting counts use the app\'s own word', text.includes('2 tests') && text.includes('1 test'), text.includes('2 tests'));

await page.click('.app-toggle button:has-text("Math Star")');
await page.waitForTimeout(600);
check('math asks for drill', /mode=drill/.test(lastSummaryQuery), lastSummaryQuery);
text = await page.textContent('#app');
check('math section renders', text.includes('Times tables') && text.includes('80%'));
check('math names its graded mode', text.includes('1 drill'), text);
check('column header follows the app', text.includes('Focus area'));

console.log('\n[Assign — grade on the composer]');
await page.click('#navAssign');
await page.waitForTimeout(600);
await page.click('.app-toggle button:has-text("Spelling Star")');
await page.waitForTimeout(600);
text = await page.textContent('#app');
check('list grades shown in the table', text.includes('Grade 3'), text.slice(0, 400));
check('composer offers a grade picker', await page.isVisible('#newListGrade'));
check('it defaults to the tablet default grade', await page.inputValue('#newListGrade') === '3');
await page.fill('#newListName', 'Unit 1');
await page.selectOption('#newListGrade', '5');
await page.fill('#newListWords', 'cadence');
await page.click('button:has-text("Send to the tablet")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('grade travels with the assigned list', cmd.body.payload.list.grade === '5', cmd.body.payload.list);
check('confirmation names the grade', (await page.textContent('#app')).includes('Grade 5'));

console.log('\n[Assign — Reading Star: catalog editor (Phase 1b)]');
await page.click('.app-toggle button:has-text("Reading Star")');
await page.waitForTimeout(700);
text = await page.textContent('#app');
check('the real bundled catalog is fetched and listed', text.includes('A Horse Called Wonder'));
check('overlay book listed too, marked Edited', text.includes('A Parent Book') && text.includes('Edited'));

console.log('\n[Assign — Reading: edit an existing overlay book]');
await page.click('tr:has-text("A Parent Book") button:has-text("Edit")');
await page.waitForTimeout(300);
check('editor prefilled from the overlay', await page.inputValue('#rbTitle') === 'A Parent Book');
await page.fill('#rbTitle', 'A Parent Book (fixed)');
await page.click('button:has-text("Send to the tablet")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('assign-book posted, replacing by the existing key (§4.1/§4.3)', cmd.body.kind === 'assign-book' && cmd.body.payload.book.key === 'p-existing1', cmd.body);
check('title edit carried', cmd.body.payload.book.title === 'A Parent Book (fixed)');
check("an untouched question keeps its id — a fix, not a replace", cmd.body.payload.book.questions[0].id === 'p-q9', cmd.body.payload.book.questions);

console.log('\n[Assign — Reading: add a brand new book]');
await page.click('button:has-text("+ Add a book")');
await page.waitForTimeout(300);
await page.fill('#rbTitle', 'Brand New Book');
await page.fill('#rbAuthor', 'New Author');
await page.check('.rbGenre[value="fantasy"]');
await page.click('button:has-text("+ Add a question")');
await page.waitForTimeout(200);
await page.fill('#rbQ0text', 'What happens first?');
await page.fill('#rbQ0correct', 'This');
await page.fill('#rbQ0wrong0', 'That');
await page.fill('#rbQ0wrong1', 'Other');
await page.fill('#rbQ0wrong2', 'Another');
await page.click('button:has-text("Send to the tablet")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('assign-book posted for the new book', cmd.body.kind === 'assign-book' && cmd.body.payload.book.title === 'Brand New Book', cmd.body);
check('a fresh parent-minted key, p- prefixed (§4.3)', /^p-/.test(cmd.body.payload.book.key), cmd.body.payload.book.key);
check('genre carried', JSON.stringify(cmd.body.payload.book.genre) === '["fantasy"]', cmd.body.payload.book.genre);
check('the new question also got a p- id, never colliding with the converter\'s <key>-qN', /^p-/.test(cmd.body.payload.book.questions[0].id), cmd.body.payload.book.questions);

console.log('\n[Assign — Reading: validation]');
await page.click('button:has-text("+ Add a book")');
await page.waitForTimeout(300);
await page.fill('#rbTitle', 'Half Done');
await page.click('button:has-text("+ Add a question")');
await page.waitForTimeout(200);
await page.fill('#rbQ0text', 'Only the question, nothing else');
const beforeReadingSends = posted.filter((p) => p.path === '/commands').length;
await page.click('button:has-text("Send to the tablet")');
await page.waitForTimeout(300);
check('an incomplete question blocks sending', posted.filter((p) => p.path === '/commands').length === beforeReadingSends);
check('and says why', (await page.textContent('#app')).includes('Each question needs'));
await page.click('button:has-text("Cancel")');
await page.waitForTimeout(300);

console.log('\n[Assign — Reading: delete an overlay book]');
await page.click('tr:has-text("A Parent Book") button:has-text("Delete")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('delete-book posted with the overlay key', cmd.body.kind === 'delete-book' && cmd.body.payload.key === 'p-existing1', cmd.body);

console.log('\n[General]');
check('no page errors anywhere', errors.length === 0, errors);

await browser.close();
await staticServer.close();
process.exit(report('parent-dashboard') ? 1 : 0);
