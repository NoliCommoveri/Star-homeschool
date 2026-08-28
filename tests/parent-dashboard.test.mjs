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
  // assignment-spec.md §9.3. Unset to begin with, which is the state every
  // existing family is in the moment Phase 5 ships — the Devices card has to
  // read correctly there, not only once a zone exists. None of the fixture
  // sessions below carries a localDate either, for the same reason: they are
  // exactly the rows the phone has to backfill (§9.6).
  family: { timezone: null, weekStart: 0 },
  // Two pending, so the banner and the card both have something to show. A
  // real deployment is in exactly this state the moment new code lands.
  migrations: {
    migrations: [
      { name: 'schema-phase3.sql', applied: true },
      { name: 'schema-phase4.sql', applied: true },
      { name: 'schema-phase5.sql', applied: false },
    ],
    pending: 1,
  },
  sessions: {
    'child-ada:spelling': [
      { id: '1001', date: iso(7200000), deviceId: 'tablet-1', mode: 'pretest', score: 10, total: 10, listName: 'Week 11', results: [{ word: 'because', correct: true, attempts: 1 }] },
      { id: '1002', date: iso(7200000), deviceId: 'tablet-1', mode: 'test', score: 10, total: 10, listName: 'Week 11', promotedFrom: '1001', results: [] },
      { id: '1003', date: iso(3600000), deviceId: 'tablet-1', mode: 'practice', score: 7, total: 10, listName: 'Week 11', results: [{ word: 'friend', correct: false, attempts: 2 }] },
    ],
    'child-ada:math': [
      // elapsedMs rides along in the session payload blob from Math Star; the
      // detail modal is where a parent reads how long the sitting took.
      { id: '2001', date: iso(3600000), deviceId: 'tablet-1', mode: 'drill', score: 8, total: 10, elapsedMs: 115000, focusName: 'Addition Warm-up', categories: ['addition-facts'], results: [] },
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
        readingSupportLevel: 'standard',
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
  // assignment-spec.md §12.1. Keyed by childId, and the revision is allocated
  // here rather than accepted from the page, because that is the property the
  // real handler has and the one the page must not be written to depend on.
  plans: {},
  // §11's delivery status, as the server derives it from plan_state (§12), with
  // one tablet in each of the three states the card can show: one that has
  // never reported a revision, one holding an older one, and one holding a
  // revision no edit on this screen will reach — a plan another phone saved
  // after this one loaded, where ahead has to read as up to date rather than
  // as behind.
  delivery: [
    { id: 'tablet-2', label: 'The old iPad', revision: null, seenAt: null, lastSeen: now - 3600000 },
    { id: 'tablet-3', label: "Bo's tablet", revision: 1, seenAt: now - 7200000, lastSeen: now - 7200000 },
    { id: 'tablet-1', label: "Ada's tablet", revision: 99, seenAt: now - 600000, lastSeen: now - 600000 },
  ],
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
    if (path === '/family/settings') return send(server.family);
    if (path === '/plan') {
      const held = server.plans[url.searchParams.get('childId')];
      return send({
        revision: held ? held.revision : 0,
        items: held ? held.items : [],
        timezone: server.family.timezone,
        weekStart: server.family.weekStart,
        delivery: server.delivery,
      });
    }
    if (path === '/migrations') return send(server.migrations);
    if (path === '/summary') {
      lastSummaryQuery = url.search;
      return send({ lists: server.summary[url.searchParams.get('app')] || [] });
    }
  }
  if (req.method() === 'PUT') {
    const b = JSON.parse(req.postData() || '{}');
    posted.push({ path, body: b });
    if (path === '/family/settings') {
      // The server is the authority on what a valid zone is (§9.3); mirror
      // just enough of that here for the rejection path to be exercised.
      if (b.timezone && !b.timezone.includes('/')) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"timezone must be an IANA zone name"}' });
      }
      server.family = { timezone: b.timezone ?? server.family.timezone, weekStart: b.weekStart ?? server.family.weekStart };
      return send(server.family);
    }
    if (path === '/plan') {
      const revision = Math.max(0, ...(b.childIds || []).map((id) => (server.plans[id] || {}).revision || 0)) + 1;
      // One document per id the merged child synced under (§6.2), all at the
      // same revision — a tablet must see the same plan whichever id it pushes
      // with.
      for (const id of b.childIds || []) server.plans[id] = { revision, items: b.items };
      return send({ revision, effectiveFrom: '2026-01-01', items: b.items });
    }
  }
  if (req.method() === 'POST') {
    const b = JSON.parse(req.postData() || '{}');
    posted.push({ path, body: b });
    if (path === '/migrations') {
      server.migrations = {
        migrations: server.migrations.migrations.map((m) => ({ ...m, applied: true })),
        pending: 0,
      };
      return send({ ran: [{ name: 'schema-phase5.sql', changed: 7, skipped: 0 }], ...server.migrations });
    }
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
check('Plan tab present', await page.isVisible('#navPlan'));

// assignment-spec.md §9, checked here because this is the only point in the run
// where the fixture family still has no timezone — which is the state every
// existing family is in the moment this ships.
//
// With no zone, /api/sync hands down no plan document at all (§9.6), no session
// is ever stamped with a local date, and every bar on this screen would read
// 0 of 3 forever with nothing visibly wrong anywhere. A hard stop is the only
// place that failure is visible to the person who can fix it.
console.log('\n[§9] the Plan tab asks for the family clock before anything else');
await page.click('#navPlan');
await page.waitForTimeout(400);
{
  const text = await page.textContent('#app');
  check('no editor until a timezone is set', text.includes("Set the family's timezone first"), text.slice(0, 160));
  check('and no Add a target button', !(await page.isVisible('button:has-text("Add a target")')));
}
await page.click('#navDashboard');
await page.waitForTimeout(700);

console.log('\n[How long a math sitting took]');
{
  await page.evaluate(() => openSessionDetail('child-ada', 'math', '2001'));
  await page.waitForTimeout(150);
  const line = await page.textContent('.overlay p.muted');
  check('the detail shows how long it took', line.includes('1 min 55 sec'), line);
  check('alongside the score, not instead of it', line.includes('8/10'), line);
  await page.evaluate(() => document.querySelector('.overlay')?.remove());

  // The other two shapes are the formatter's, and testing them here rather
  // than through fixture sessions keeps this suite's session counts — which
  // several target checks assert on — out of it.
  const cases = await page.evaluate(() => [fmtElapsed(42000), fmtElapsed(60000), fmtElapsed(undefined), fmtElapsed(0)]);
  check('under a minute reads as seconds only', cases[0] === '42 sec', cases[0]);
  check('exactly a minute keeps the seconds place', cases[1] === '1 min 0 sec', cases[1]);
  check('a session recorded before timing existed shows nothing', cases[2] === null, cases[2]);
  check('and neither does a zero', cases[3] === null, cases[3]);
}

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

// Order is what "the next list" means to the tablet, and the phone sends the
// whole order rather than a move (spec §15.3).
await page.click('#navAssign');
await page.waitForTimeout(400);
await page.click('tr:has-text("Week 11") button:has-text("▲")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('reorder-lists posted', cmd.body.kind === 'reorder-lists', cmd.body.kind);
check('it carries the whole order, moved by one', JSON.stringify(cmd.body.payload.order) === '["l99","starter"]', cmd.body.payload);
check('the top list cannot be moved up', await page.isDisabled('tr:has-text("Starter Words") button:has-text("▲")'));

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

console.log('\n[Assign — Reading: support level (§7)]');
check('current level reported from the tablet snapshot', text.includes('Standard'));
await page.selectOption('#readingSupportSel', 'extra-support');
await page.click('button:has-text("Set")');
await page.waitForTimeout(500);
cmd = posted.filter((p) => p.path === '/commands').pop();
check('set-reading-support-level posted', cmd.body.kind === 'set-reading-support-level' && cmd.body.app === 'reading', cmd.body);
check('the chosen level carried', cmd.body.payload.level === 'extra-support', cmd.body.payload);
check('confirmation names the level', (await page.textContent('#app')).includes('Extra support'));

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

// A pending migration is invisible until a tablet fails to sync, and §3 rule 1
// makes that failure silent for the child. So the app has to be the thing that
// notices — a parent should never have to think to go and look.
console.log('\n[migrations] the parent app raises a banner and applies');
await page.click('#navDashboard');
await page.waitForTimeout(600);
let dashText = await page.textContent('#app');
check('a pending migration raises a banner on the dashboard', dashText.includes('pending'), dashText.slice(0, 300));

await page.click('#navDevices');
await page.waitForTimeout(500);
let devText = await page.textContent('#app');
check('the Database card lists every migration', devText.includes('schema-phase5.sql'));
check('and says how many are pending', devText.includes('1 pending of 3'), devText.slice(0, 400));
check('it points at the no-JS fallback for when this page will not load',
  devText.includes('/admin/migrations'));

await page.click('button:has-text("Apply pending migrations")');
await page.waitForTimeout(600);
const applyPost = posted.filter((p) => p.path === '/migrations').pop();
check('Apply posts to /api/migrations', !!applyPost, posted.map((p) => p.path));
devText = await page.textContent('#app');
check('the result says what actually ran', devText.includes('schema-phase5.sql (7 run'), devText.slice(0, 400));
check('and nothing is pending afterwards', devText.includes('0 pending of 3'), devText.slice(0, 400));

await page.click('#navDashboard');
await page.waitForTimeout(600);
dashText = await page.textContent('#app');
check('the banner is gone once nothing is pending', !dashText.includes('migrations are pending'), dashText.slice(0, 300));

// ---- assignment-spec.md §9.3, §9.4 -----------------------------------------
console.log('\n[Devices — the family clock]');
await page.click('#navDevices');
await page.waitForTimeout(500);
let devicesText = await page.textContent('#app');
check('the School week card is on the Devices screen', devicesText.includes('School week'));
check('a family with no zone is told what it costs', devicesText.includes('No timezone set yet'), devicesText.slice(0, 200));
check('the field is prefilled with this phone\'s zone rather than left blank',
  !!(await page.inputValue('#tzIn')), await page.inputValue('#tzIn'));

// A zone that does not resolve must not be stored: every tablet would then
// stamp nothing, silently, and no target would ever count (§9.3).
await page.fill('#tzIn', 'Chicago');
await page.click('button:has-text("Save")');
await page.waitForTimeout(300);
check('a rejected zone surfaces the server\'s reason', (await page.textContent('#familySettingsNote')).includes('IANA'),
  await page.textContent('#familySettingsNote'));

await page.fill('#tzIn', 'America/Chicago');
await page.selectOption('#weekStartIn', '1');
await page.click('button:has-text("Save")');
await page.waitForTimeout(300);
const tzPut = posted.filter((p) => p.path === '/family/settings').pop();
check('saving PUTs the zone and the week start together',
  tzPut.body.timezone === 'America/Chicago' && tzPut.body.weekStart === 1, tzPut.body);
check('and says so', (await page.textContent('#familySettingsNote')).includes('Saved'));

// §9.6: rows the tablets stamped before they knew the zone are filled in here,
// because applying an IANA zone to an instant is something the phone can do
// and D1 cannot (§9.2). A silent failure here would leave every pre-Phase-5
// session unbucketed and every weekly target undercounting.
console.log('\n[§9.6] the dashboard backfills a missing local date');
await page.click('#navDashboard');
await page.waitForTimeout(700);
const backfilled = await page.evaluate(() => {
  const key = Object.keys(state.sessionsByKey).find((k) => state.sessionsByKey[k].length);
  const rows = state.sessionsByKey[key] || [];
  return { zone: state.family.timezone, sample: rows.map((r) => ({ date: r.date, localDate: r.localDate })).slice(0, 3) };
});
check('the family zone reached the dashboard', backfilled.zone === 'America/Chicago', backfilled);
check('every loaded session now has a local date',
  backfilled.sample.length > 0 && backfilled.sample.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.localDate)), backfilled);
check('and it is the day in the family zone, not the UTC one',
  backfilled.sample.every((r) => {
    const inZone = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(r.date));
    return r.localDate === inZone;
  }), backfilled);

// ============ The Plan tab (assignment-spec.md §4, §10, §11) ================
//
// The family now has a timezone, so the editor opens. Everything below counts
// against the same 90 days the Dashboard downloaded — no new endpoint and no
// new request, which is §11's "Progress" bullet and the reason §10.1 makes
// progress a query rather than a stored counter.

// History for the counting tests arrives now rather than in the fixture at the
// top, so the Dashboard's assertions above run against exactly what they always
// did — and so these counts do not quietly depend on how many sessions the
// delete test further up removed.
//
// Every one of these is a few hours old on purpose. A fixture dated in days
// would fall into last week's bucket whenever the suite happened to run on a
// Monday, and the failure would look like an evaluator bug.
//
// What is on file afterwards, for one child, this week:
//   spelling  practice, practice, spot-it     → 2 count, spot-it is play (§5)
//   math      drill                           → 1 counts
//   reading   start, log-session, finish      → 1 counts, 2 are lifecycle (§5)
// Seven rows; four of them are work.
server.sessions['child-ada:spelling'].push(
  { id: '1101', date: iso(5400000), deviceId: 'tablet-1', mode: 'practice', score: 9, total: 10, listId: 'l99', listName: 'Week 11', results: [] },
  { id: '1102', date: iso(4800000), deviceId: 'tablet-1', mode: 'spotit', score: 6, total: 6, listId: 'l99', listName: 'Week 11', results: [] },
);
server.sessions['child-ada:reading'] = [
  { id: '3001', date: iso(5400000), deviceId: 'tablet-1', mode: 'start', bookId: 'b1', bookTitle: 'A Parent Book' },
  { id: '3002', date: iso(3600000), deviceId: 'tablet-1', mode: 'log-session', bookId: 'b1', bookTitle: 'A Parent Book', minutes: 20 },
  { id: '3003', date: iso(1800000), deviceId: 'tablet-1', mode: 'finish', bookId: 'b1', bookTitle: 'A Parent Book' },
];

console.log('\n[§11] a target is composed against what the tablet reported');
await page.click('#navPlan');
await page.waitForTimeout(700);
check('the editor is reachable once a zone exists', await page.isVisible('button:has-text("Add a target")'));
check('and says which clock it counts in', (await page.textContent('#app')).includes('America/Chicago'));

await page.click('button:has-text("Add a target")');
await page.waitForTimeout(200);
check('the app picker offers a cross-app target',
  (await page.textContent('#planAppSel')).includes('Any app'));
// §15.4: the scope picker is the tablet's own report, so the phone never holds
// a second copy of Spelling Star's data model.
check('and the list picker is the tablet\'s own list',
  (await page.textContent('#planScopeSel')).includes('Week 11'));
// §5: a game is targetable, but only by being asked for by name.
check('a play mode is offered, marked as not counted by default',
  (await page.textContent('#app')).includes('not counted unless named'));

console.log('\n[§10.2] progress is recounted, never reported');
// Three spelling rows this week, of which the spot-it is play and does not
// count, against a target of five.
await page.fill('#planLabelIn', 'Spelling, any sitting');
await page.fill('#planCountIn', '5');
await page.click('button:has-text("Save")');
await page.waitForTimeout(600);
{
  const text = await page.textContent('#app');
  check('the target lands and counts the week', text.includes('2 of 5'), text.slice(0, 400));
  // §8.3 / §10.4: a count and a bar, never a percentage, and no verdict while
  // the period is still open. A red badge on Monday morning for every weekly
  // target is a badge everyone has learned to ignore by Wednesday.
  check('mid-period it shows time left, not a verdict', /day(s)? left|last day/.test(text), text.slice(0, 400));
  check('and renders no percentage', !/\d+%/.test(text), text.slice(0, 400));
  check('a bar is drawn', await page.isVisible('.bar'));
}

console.log('\n[§5] play and lifecycle tones do not count as work');
// The whole of §5's two rules, in one number. Seven rows are on file for this
// week; a cross-app target must count four.
//
// Reading Star writes a session row when a book is started, and again when it
// is finished — counting those would make "5 reading sessions a week"
// satisfiable by opening five books and reading none of them. Spelling Star
// ships a new game every few releases, each arriving as a mode with tone
// 'play', and each has to land in the plan already knowing it is not homework
// without anyone remembering to come back and say so.
await page.click('button:has-text("Add a target")');
await page.waitForTimeout(200);
await page.selectOption('#planAppSel', '');
await page.waitForTimeout(200);
await page.fill('#planLabelIn', 'Everything');
await page.fill('#planCountIn', '9');
await page.click('button:has-text("Save")');
await page.waitForTimeout(600);
{
  const text = await page.textContent('#app');
  check('a cross-app target counts the four sittings that are work', text.includes('4 of 9'), text.slice(0, 600));
  check('and not the seven rows on file', !text.includes('7 of 9'), text.slice(0, 600));
  check('and files itself across every app', text.includes('Across every app'), text.slice(0, 600));
}

console.log('\n[§10.4] a met target says so as soon as it is true');
await page.click('button:has-text("Add a target")');
await page.waitForTimeout(200);
await page.selectOption('#planAppSel', 'math');
await page.waitForTimeout(200);
await page.fill('#planLabelIn', 'One math sitting');
await page.fill('#planCountIn', '1');
await page.click('button:has-text("Save")');
await page.waitForTimeout(600);
check('met is good news and is shown immediately', (await page.textContent('#app')).includes('Met'));

console.log('\n[§4.2] editing an item keeps its id');
{
  const before = await page.evaluate(() => state.plan.items.map((i) => i.id));
  await page.click('.plan-item:has-text("One math sitting") button:has-text("Edit")');
  await page.waitForTimeout(200);
  await page.fill('#planCountIn', '4');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => state.plan.items.map((i) => ({ id: i.id, count: i.count })));
  check('the count changed', after.find((i) => i.count === 4), after);
  // Derived identity is what reading-star-spec-review.md catches going wrong
  // three separate times: renaming or re-counting a target must not silently
  // start a second history for it.
  check('and every id survived the edit',
    after.map((i) => i.id).sort().join() === before.sort().join(), { before, after });
  check('the revision advanced', await page.evaluate(() => state.plan.revision) > 1);
}

console.log('\n[§4.3] an assignment is a target with a deadline');
{
  // §4's whole argument, exercised as a control: an assignment and a target are
  // the same object at different settings, so this is the period picker's third
  // option and not a second editor.
  await page.click('button:has-text("Add a target")');
  await page.waitForTimeout(200);
  await page.selectOption('#planAppSel', 'spelling');
  await page.waitForTimeout(200);
  await page.fill('#planLabelIn', 'Test on Week 11');
  await page.fill('#planCountIn', '1');
  await page.selectOption('#planPeriodSel', 'dates');
  await page.waitForTimeout(200);
  check('choosing a deadline reveals the dates', await page.isVisible('#planToIn'));

  const composed = await page.evaluate(() => state.planEditor.period);
  // Today to the end of the family's own week (§9.4) — the deadline most
  // assignments actually carry, and one the parent can then change.
  const today = await page.evaluate(() => localDate(new Date(), state.family.timezone));
  check('it opens on a window, not on two empty boxes',
    composed && composed.from === today && composed.to >= composed.from, composed);

  // A window that ends before it starts is refused in front of the two fields
  // it is about. The server refuses it too, and is the authority — but "period
  // must be day, week, or { from, to }" is the wrong sentence for a parent.
  await page.fill('#planToIn', '2020-01-01');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(400);
  check('a due date before the start date is refused', (await page.textContent('#app')).includes('before the start date'));
  check('and nothing was written', !posted.some((p) => p.path === '/plan' && (p.body.items || []).some((i) => i.label === 'Test on Week 11')));

  await page.fill('#planFromIn', '2026-05-04');
  await page.fill('#planToIn', '2026-05-08');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(600);
  const saved = await page.evaluate(() => state.plan.items.find((i) => i.label === 'Test on Week 11'));
  check('a dated period is what reaches the server',
    saved && saved.period.from === '2026-05-04' && saved.period.to === '2026-05-08', saved);
  check('and the row reads as a deadline rather than a bucket',
    (await page.textContent('#app')).includes('by '), saved);
  // §4.3: the window has closed and no sitting fell inside it. This is the row
  // the parent keeps — "not done, and the window closed" is the whole point of
  // a dated item staying here after it leaves the child's screen.
  check('a closed window gets a verdict, unlike an open one',
    (await page.textContent('.plan-item:has-text("Test on Week 11")')).includes('Not met'));

  // Before this the editor could carry a dated period through an edit but not
  // author or change one, which made a wrong deadline a delete-and-retype.
  await page.click('.plan-item:has-text("Test on Week 11") button:has-text("Edit")');
  await page.waitForTimeout(200);
  check('re-editing lands back on the dates', await page.inputValue('#planFromIn') === '2026-05-04');
  await page.fill('#planToIn', '2026-05-11');
  await page.click('button:has-text("Save")');
  await page.waitForTimeout(600);
  const moved = await page.evaluate(() => state.plan.items.find((i) => i.label === 'Test on Week 11'));
  check('and the deadline can be moved', moved.period.to === '2026-05-11', moved);
  check('without starting a second history for it', moved.id === saved.id, { saved: saved.id, moved: moved.id });

  // A dated item that is finished with is removed like any other, so the
  // screen does not silt up with last term's assignments.
  await page.click('.plan-item:has-text("Test on Week 11") button:has-text("Remove")');
  await page.waitForTimeout(600);
  // The row, not the page: the note confirming the removal names the item too.
  check('and it can be taken off again',
    await page.locator('.plan-item:has-text("Test on Week 11")').count() === 0);
}

console.log('\n[§11] delivery status: which tablet holds which revision');
{
  const text = await page.textContent('#app');
  check('the card names the tablets', text.includes('On the tablets') && text.includes("Ada's tablet"), text.slice(-600));
  // A tablet ahead of this screen — another phone saved after this one loaded —
  // is up to date, not behind.
  check('one holding a newer revision reads as up to date', text.includes('Up to date'));
  check('one holding an older revision reads as behind', text.includes('Behind'));
  // The failure the card exists for: an app old enough not to report a
  // revision syncs its sittings perfectly and is invisible any other way.
  check('and one that has never reported says so', text.includes('No plan reported'));
  // §6.1: a plan needs no ack, so nothing here is a send button and nothing
  // retries. The card says what is true, and the tablet catches up on its own.
  check('nothing on it sends anything', text.includes('picks the plan up the next time it syncs'));
  check('the Plan tab still queued no commands', !posted.some((p) => p.path === '/commands' && p.body.app === undefined));
}

console.log('\n[§10.2] one sitting under two childIds is counted once');
{
  // A merged child holds the same session under more than one id (§6.2): an
  // app re-pushes its history when it adopts the shared childId. Without the
  // dedup on (deviceId, sessionId) a re-push inflates every count and a child
  // appears to have met a target they did not.
  const done = await page.evaluate(() => {
    const child = state.children.find((c) => c.id === state.detailChildId);
    const sessions = planSessions(child);
    const item = { id: 'x', label: 'x', match: { app: 'math', modes: null, scopeId: null }, count: 5, period: 'week' };
    const ctx = { timezone: state.family.timezone, weekStart: state.family.weekStart, now: Date.now() };
    const once = evaluateItem(item, sessions, ctx).done;
    const twice = evaluateItem(item, [...sessions, ...sessions], ctx).done;
    const twoDevices = evaluateItem(item, [...sessions, ...sessions.map((s) => ({ ...s, deviceId: 'tablet-9' }))], ctx).done;
    return { once, twice, twoDevices };
  });
  check('a duplicate push does not inflate the count', done.twice === done.once, done);
  // A genuine second device is a genuine second sitting, so the key is the
  // pair and not the id alone.
  check('but a real second device still counts', done.twoDevices === done.once * 2, done);
}

console.log('\n[§11] copy from a sibling');
{
  // A second child, and a reload so the picker sees them. Most families want
  // one plan with small per-child differences, and re-composing it by hand is
  // the kind of chore that stops a feature being used.
  server.children.push({ id: 'child-bo', name: 'Bo', created_at: now - 86400000 });
  // One of Ada's targets is scoped to a list her tablet no longer reports. A
  // list belongs to one child's tablet, so this must not be carried across as
  // a target that can never fill in.
  server.plans['child-ada'].items.push({
    id: 'scoped-1', label: 'That one list', count: 2, period: 'week',
    match: { app: 'spelling', modes: ['practice'], scopeId: 'gone-list' },
  }, {
    // And one scoped to a list that IS reported, which must survive untouched:
    // the rule is "drop what this tablet cannot match", not "drop every scope".
    id: 'scoped-2', label: 'Week 11 practice', count: 2, period: 'week',
    match: { app: 'spelling', modes: ['practice'], scopeId: 'l99' },
  });
  await page.reload();
  await page.waitForTimeout(700);
  await page.click('#navPlan');
  await page.waitForTimeout(700);
  await page.selectOption('#planChildSel', 'child-bo');
  await page.waitForTimeout(700);
  check('the sibling starts with nothing', (await page.textContent('#app')).includes('No targets'));

  await page.selectOption('#planCopyFrom', 'child-ada');
  await page.click('button:has-text("Copy")');
  await page.waitForTimeout(700);
  const copied = await page.evaluate(() => state.plan.items);
  check('every target came across', copied.length === 5, copied.length);
  check('with the labels intact', copied.some((i) => i.label === 'Everything'), copied.map((i) => i.label));
  // Widened rather than carried: a target scoped to a list this child does not
  // have would read 0 of 2 forever, and would look like the evaluator was
  // broken rather than like the copy was.
  const scoped = copied.find((i) => i.label === 'That one list');
  check('a scope the tablet does not have is widened to any', scoped && scoped.match.scopeId === null, scoped);
  check('and the parent is told it happened', (await page.textContent('#app')).includes('counted any list'));
  const kept = copied.find((i) => i.label === 'Week 11 practice');
  check('a scope the tablet does have survives untouched', kept && kept.match.scopeId === 'l99', kept);
  // Two children's targets are two separate histories. Sharing an id would
  // make "has she missed her Friday test three weeks running" a question about
  // both of them at once (§4.2).
  const adaIds = server.plans['child-ada'].items.map((i) => i.id);
  check('but on fresh ids, not the sibling\'s', copied.every((i) => !adaIds.includes(i.id)), { copied: copied.map((i) => i.id), adaIds });
}

console.log('\n[§8.2] the plan displays; it never blocks');
// Worth pinning as a property of the page rather than trusting the copy: this
// screen must not be able to grow a gate. data.schedule remains the only thing
// that gates, and it is a tablet-side setting.
{
  const posts = posted.filter((p) => p.path === '/plan');
  check('every write is a plan revision and nothing else', posts.length > 0 && posts.every((p) => Array.isArray(p.body.items)), posts.length);
  check('the Plan tab queued no commands', !posted.some((p) => p.path === '/commands' && p.body.kind === 'set-plan'));
}

console.log('\n[General]');
check('no page errors anywhere', errors.length === 0, errors);

await browser.close();
await staticServer.close();
process.exit(report('parent-dashboard') ? 1 : 0);
