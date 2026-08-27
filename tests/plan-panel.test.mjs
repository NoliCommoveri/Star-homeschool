// The plan panel on each app's own home screen. docs/assignment-spec.md §17
// step 4 — delivery: the sync response carries the plan, the three apps write
// the shared key, and each shows its own items.
//
// Three properties are worth more than the rest and the suite is arranged
// around them:
//
// An app shows ITS OWN items and no others (§7.1). Every app stores the whole
// plan document, because that is how a target for an app with sync switched off
// reaches the device at all — so every app is holding items it must not render.
// Filtering happens at read time and nowhere else, and getting that backwards
// is how Reading Star's homework appears on Spelling Star's home screen.
//
// It counts the way the phone and the hub count (§3, §10.2). Nobody reports
// progress upward. shared-code.test.mjs pins the evaluator's source as
// byte-identical across all five copies; this suite pins the per-app adapters
// that feed it, which are the half that is NOT shared, and checks one seed
// against today.html's answer for the same history.
//
// It displays and never blocks (§8.2). data.schedule remains the only thing
// that gates an app. A panel that quietly disabled a button would turn "what is
// owed this week" into "what is allowed today", which is a different question
// the apps already answer somewhere else.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const staticServer = await serveRepo();
const BASE = staticServer.url;
const { check, section, report } = createChecker();
const browser = await launchBrowser();

// One fixed zone for every count, so no assertion depends on where the suite
// runs. The browser context is put in Sydney below while every plan says UTC:
// an app that reached for the device's zone instead of the plan's (§9.5) would
// bucket half of these sittings into tomorrow and every number would move.
const TZ = 'UTC';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const at = (hour) => new Date(today + 'T' + String(hour).padStart(2, '0') + ':00:00Z').toISOString();
const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

function plan(items, extra) {
  return Object.assign({ revision: 5, timezone: TZ, weekStart: 0, items }, extra || {});
}

const APPS = {
  spelling: { file: 'spelling-star-v6_3.html', key: 'spellingstar-ada' },
  math: { file: 'math-star-v6_1.html', key: 'mathstar-ada' },
  reading: { file: 'reading-star-v1.html', key: 'readingstar-ada' },
};

// Profiles as each app actually writes one. Sync is off unless a test turns it
// on: the panel reads what is already on the device and must work with the
// radio silent.
function spellingProfile(extra) {
  return Object.assign({
    childName: 'Ada', pin: '1234', scoring: 'percent', gradeLevel: '3', showHistory: true, pretestGlobal: false,
    gamesEnabled: true, advanceEnabled: false, advanceThreshold: 90, theme: 'classic', keyboard: 'abc',
    repeatStandard: 5, repeatHard: 8,
    lists: [{ id: 'l-512', name: 'List 5.12', desc: '', pretest: 'global', grade: '3', words: [{ word: 'cat', hint: 'h', sentence: 's' }], bonus: [] }],
    activeListId: 'l-512', reviewWords: [], graduated: [],
    sessions: [
      { id: 101, date: at(9), mode: 'practice', listId: 'l-512', listName: 'List 5.12', score: 8, total: 10, results: [] },
      { id: 102, date: at(10), mode: 'practice', listId: 'l-512', listName: 'List 5.12', score: 9, total: 10, results: [] },
      { id: 103, date: at(11), mode: 'test', listId: 'l-512', listName: 'List 5.12', score: 10, total: 10, results: [] },
      // tone 'play' (§5): a game is not homework, and a broad match never
      // sweeps one up.
      { id: 104, date: at(12), mode: 'spotit', listId: 'l-512', listName: 'List 5.12', score: 6, total: 6, results: [] },
      { id: 105, date: at(13), mode: 'missing', listId: 'l-512', listName: 'List 5.12', score: 5, total: 5, results: [] },
    ],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', studyEnabled: true, practiceEnabled: true, testEnabled: true, repeatEnabled: true, gamesEnabled: true })),
    sync: { enabled: false },
  }, extra || {});
}

function mathProfile(extra) {
  return Object.assign({
    childName: 'Ada', pin: '1234', gradeLevel: '4', showHistory: true, theme: 'classic',
    focusAreas: [{ id: 'f-7', categories: ['multiplication-facts'], gradeBand: '2-4', name: 'Times tables' }],
    activeFocusId: 'f-7',
    sessions: [
      { id: 201, date: at(14), mode: 'drill', focusId: 'f-7', focusName: 'Times tables', categories: ['multiplication-facts'], score: 18, total: 20, results: [] },
      { id: 202, date: at(15), mode: 'practice', focusId: 'f-7', focusName: 'Times tables', categories: ['multiplication-facts'], score: 19, total: 20, results: [] },
    ],
    schedule: Array.from({ length: 7 }, () => ({ activity: 'none', practiceEnabled: true, drillEnabled: true })),
    sync: { enabled: false },
  }, extra || {});
}

function readingProfile(extra) {
  return Object.assign({
    childName: 'Ada', pin: '1234', childGrade: '3', theme: 'classic', catalogOverlay: {}, readingSupportLevel: null,
    events: [
      // tone 'lifecycle' (§5): opening a book is not a sitting at one.
      { id: 'e1', date: at(8), mode: 'start', bookId: 'b-1', bookTitle: 'Frindle' },
      { id: 'e2', date: at(16), mode: 'log-session', bookId: 'b-1', bookTitle: 'Frindle', minutes: 20 },
      { id: 'e3', date: at(17), mode: 'log-session', bookId: 'b-1', bookTitle: 'Frindle', minutes: 25 },
    ],
    // The nested copies carry their event's own id (§8.6). An adapter reading
    // both arrays would count every sitting twice — or, worse, depend silently
    // on the evaluator's dedupe to hide it.
    books: [{
      id: 'b-1', title: 'Frindle', author: 'Andrew Clements', status: 'reading', startedAt: at(8),
      sessions: [
        { id: 'e2', at: at(16), minutes: 20 },
        { id: 'e3', at: at(17), minutes: 25 },
      ],
    }],
    sync: { enabled: false },
  }, extra || {});
}

const PROFILE = { spelling: spellingProfile, math: mathProfile, reading: readingProfile };

// ---------------------------------------------------------------------------

async function open(appId, seed, options) {
  const app = APPS[appId];
  const ctx = await browser.newContext({ timezoneId: 'Australia/Sydney' });
  const page = await ctx.newPage();
  const errors = [];
  const syncBodies = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });

  const responses = (options && options.responses) || null;
  if (responses) {
    let call = 0;
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fulfill({ status: 404, body: '{}' });
      syncBodies.push(JSON.parse(req.postData() || '{}'));
      const res = responses[Math.min(call++, responses.length - 1)];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
  }

  await page.addInitScript((entries) => {
    for (const [key, value] of entries) {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }, Object.entries(seed));

  await page.goto(`${BASE}/${app.file}`);
  await page.waitForTimeout(responses ? 900 : 400);
  return { ctx, page, errors, syncBodies, text: () => page.textContent('#app') };
}

// The seed every app test starts from: this app's own profile, plus a plan.
function seedFor(appId, items, planExtra) {
  return {
    [APPS[appId].key]: PROFILE[appId](),
    'starplan-ada': plan(items, planExtra),
  };
}

// ---------------------------------------------------------------------------

section('Spelling Star shows its own items, counted its own way');
{
  const { ctx, page, errors, text } = await open('spelling', seedFor('spelling', [
    { id: 'sp-practice', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 3, period: 'week' },
    { id: 'sp-test', label: 'Test on List 5.12', match: { app: 'spelling', modes: ['test'], scopeId: 'l-512' }, count: 1, period: 'week' },
    { id: 'sp-any', label: 'Any spelling work', match: { app: 'spelling', modes: [], scopeId: null }, count: 10, period: 'week' },
  ]));
  const body = await text();

  check('an unmet target shows the count', /Spelling practice[\s\S]{0,60}2 of 3/.test(body), body.match(/Spelling practice[\s\S]{0,80}/));
  check('a met one reads as done', /Test on List 5\.12[\s\S]{0,80}Done/.test(body), body.match(/Test on List 5\.12[\s\S]{0,120}/));
  // 2 practice + 1 test. Spot the Spelling and Missing Letters are tone 'play'
  // and a broad match leaves them alone — which is the rule that has to hold
  // without anyone editing the registry when the next game ships (§5).
  check('a broad match excludes the games', /Any spelling work[\s\S]{0,60}3 of 10/.test(body), body.match(/Any spelling work[\s\S]{0,80}/));
  check('no percentage and no grade (§8.3)', !/\d%/.test(body), body.match(/\d+%/));
  check('a weekly item says which week it is', /this week/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('Math Star');
{
  const { ctx, errors, text } = await open('math', seedFor('math', [
    { id: 'ma-drill', label: 'Drills', match: { app: 'math', modes: ['drill'], scopeId: null }, count: 4, period: 'week' },
    { id: 'ma-any', label: 'Math sittings', match: { app: 'math', modes: [], scopeId: null }, count: 2, period: 'day' },
  ]));
  const body = await text();
  check('the drill target counts drills only', /Drills[\s\S]{0,60}1 of 4/.test(body), body.match(/Drills[\s\S]{0,80}/));
  check('a daily target counts both and reads "every day"', /Math sittings[\s\S]{0,60}2 of 2/.test(body), body.match(/Math sittings[\s\S]{0,120}/));
  check('and says "every day" rather than a date', /every day/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('Reading Star');
{
  const { ctx, errors, text } = await open('reading', seedFor('reading', [
    { id: 're-week', label: 'Reading sessions', match: { app: 'reading', modes: [], scopeId: null }, count: 5, period: 'week' },
  ]));
  const body = await text();
  // Two log-sessions. `start` is tone 'lifecycle' and does not count, or "5
  // reading sessions a week" would be satisfiable by opening five books.
  check('starting a book is not a sitting at one', /Reading sessions[\s\S]{0,60}2 of 5/.test(body), body.match(/Reading sessions[\s\S]{0,80}/));
  check('the nested book copies are not counted twice (§8.6)', !/4 of 5|3 of 5/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('An app renders its own items and nothing else (§7.1)');
{
  const items = [
    { id: 'sp', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 3, period: 'week' },
    { id: 're', label: 'Read every day', match: { app: 'reading', modes: [], scopeId: null }, count: 1, period: 'day' },
    // A cross-app item cannot be counted from one app's history, so it is not
    // shown from one app's home screen (§4, §5): the only number this app could
    // print for it is too low, and an undercount sends a child back to work
    // they have already done.
    { id: 'all', label: 'Anything that counts', match: { app: null, modes: [], scopeId: null }, count: 20, period: 'week' },
  ];
  const { ctx, page, errors, text } = await open('spelling', seedFor('spelling', items));
  const body = await text();
  check('this app\'s item is shown', /Spelling practice/.test(body));
  check('another app\'s item is not', !/Read every day/.test(body), body.match(/Read every day[\s\S]{0,40}/));
  check('a cross-app item is not', !/Anything that counts/.test(body));
  check('but the child is told where the rest lives', /Other work is on the Today page/.test(body));
  const href = await page.getAttribute('a[href="./today.html"]', 'href');
  check('and the pointer is a link to the hub', href === './today.html', href);

  // The document itself is stored whole — the app filtered at render time, not
  // at write time, or Reading Star's target would be gone from the device.
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('starplan-ada')));
  check('the stored document still holds every app\'s items', stored.items.length === 3, stored.items.map((i) => i.id));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}
{
  // A plan that is entirely this app's says nothing about a Today page: the
  // pointer is for work that is actually somewhere else.
  const { ctx, errors, text } = await open('spelling', seedFor('spelling', [
    { id: 'sp', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 3, period: 'week' },
  ]));
  const body = await text();
  check('no pointer when there is nothing elsewhere', !/Other work is on/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('Dated assignments (§4.3)');
{
  const items = [
    { id: 'due', label: 'Test on List 5.12', match: { app: 'spelling', modes: ['test'], scopeId: 'l-512' }, count: 1, period: { from: shift(today, -2), to: shift(today, 2) } },
    { id: 'gone', label: 'Last week\'s test', match: { app: 'spelling', modes: ['test'], scopeId: 'l-512' }, count: 1, period: { from: shift(today, -9), to: shift(today, -2) } },
  ];
  const { ctx, errors, text } = await open('spelling', seedFor('spelling', items));
  const body = await text();
  check('an open assignment shows its deadline', /Test on List 5\.12[\s\S]{0,140}by \w{3} \d+/.test(body), body.match(/Test on List 5\.12[\s\S]{0,160}/));
  check('a closed one has left the child\'s view', !/Last week's test/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('The same history, the same number as the hub (§10.2)');
{
  // Both surfaces evaluate the same plan against the same sittings. Neither
  // reports to the other, so if the adapters disagree the two numbers do, and
  // that disagreement is exactly what nobody would notice in production.
  const items = [{ id: 'sp', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 4, period: 'week' }];
  const seed = seedFor('spelling', items);

  const app = await open('spelling', seed);
  const appBody = await app.text();

  const hubCtx = await browser.newContext({ timezoneId: 'Australia/Sydney' });
  const hubPage = await hubCtx.newPage();
  await hubPage.addInitScript((entries) => {
    for (const [key, value] of entries) localStorage.setItem(key, JSON.stringify(value));
  }, Object.entries(seed));
  await hubPage.goto(`${BASE}/today.html`);
  await hubPage.waitForTimeout(400);
  const hubBody = await hubPage.textContent('#app');

  const num = (body) => (body.match(/(\d+) of (\d+)/) || []).slice(1).join(' of ');
  check('the app says 2 of 4', num(appBody) === '2 of 4', num(appBody));
  check('and so does the hub', num(hubBody) === num(appBody), { app: num(appBody), hub: num(hubBody) });
  check('no page errors', app.errors.length === 0, app.errors);
  await hubCtx.close();
  await app.ctx.close();
}

section('Delivery: the plan rides down in the sync response (§6.2)');
{
  const synced = { enabled: true, endpoint: '/api', childId: 'child-ada', deviceId: 'tablet-1', deviceToken: 'tok', ackedIds: [101, 102, 103, 104, 105], appliedCommandIds: [], lastPushAt: null };
  const seed = { 'spellingstar-ada': spellingProfile({ sync: synced }), 'starhomeschool-childid-ada': 'child-ada' };
  const items = [{ id: 'sp', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 3, period: 'week' }];

  const { ctx, page, errors, syncBodies, text } = await open('spelling', seed, {
    responses: [{ accepted: [], commands: [], plan: plan(items, { revision: 7 }) }],
  });
  const body = await text();
  check('the panel appears without a reload', /Spelling practice[\s\S]{0,60}2 of 3/.test(body), body.match(/Spelling practice[\s\S]{0,80}/));

  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('starplan-ada')));
  check('the document is stored verbatim under the shared key (§7)', stored && stored.revision === 7 && stored.items.length === 1, stored);
  check('and the device reports what it holds on the next sync', syncBodies.length > 0, syncBodies.map((b) => b.planRevision));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}
{
  // §7.1 rule 1: highest revision wins. An older document arriving — a second
  // tablet's sync racing this one, or a server replaying — must not roll the
  // panel back to a target the parent has already changed.
  const synced = { enabled: true, endpoint: '/api', childId: 'child-ada', deviceId: 'tablet-1', deviceToken: 'tok', ackedIds: [101, 102, 103, 104, 105], appliedCommandIds: [], lastPushAt: null };
  const held = plan([{ id: 'sp', label: 'Four practices', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 4, period: 'week' }], { revision: 9 });
  const seed = { 'spellingstar-ada': spellingProfile({ sync: synced }), 'starplan-ada': held, 'starhomeschool-childid-ada': 'child-ada' };

  const { ctx, page, errors, text } = await open('spelling', seed, {
    responses: [{ accepted: [], commands: [], plan: plan([{ id: 'sp', label: 'One practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 1, period: 'week' }], { revision: 2 }) }],
  });
  const body = await text();
  check('an older revision does not overwrite a newer one', /Four practices/.test(body) && !/One practice/.test(body), body.slice(0, 200));
  const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('starplan-ada')));
  check('and the stored revision is untouched', stored.revision === 9, stored.revision);
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('It displays; it never blocks (§8.2)');
{
  // Every button on the home screen, with a plan and without one. data.schedule
  // is the only thing that may ever gate an app, and it is not what the panel
  // reads.
  const items = [{ id: 'sp', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 99, period: 'week' }];
  const withPlan = await open('spelling', seedFor('spelling', items));
  const withoutPlan = await open('spelling', { 'spellingstar-ada': spellingProfile() });

  const buttons = (page) => page.$$eval('.card.center button', (els) => els.map((e) => e.textContent.trim() + (e.disabled ? ' [disabled]' : '')));
  const a = await buttons(withPlan.page);
  const b = await buttons(withoutPlan.page);
  check('the buttons are the same buttons, in the same state', JSON.stringify(a) === JSON.stringify(b), { withPlan: a, withoutPlan: b });
  check('none of them is disabled by an unmet target', !a.some((label) => /disabled/.test(label)), a);
  check('no page errors', withPlan.errors.length === 0, withPlan.errors);
  await withPlan.ctx.close();
  await withoutPlan.ctx.close();
}

section('Nothing to show is not an error');
{
  const cases = [
    ['no plan at all', { 'spellingstar-ada': spellingProfile() }],
    ['an unreadable plan', { 'spellingstar-ada': spellingProfile(), 'starplan-ada': 'not json' }],
    ['a plan with no items', { 'spellingstar-ada': spellingProfile(), 'starplan-ada': plan([]) }],
    ['only other apps\' items', { 'spellingstar-ada': spellingProfile(), 'starplan-ada': plan([{ id: 'r', label: 'Read every day', match: { app: 'reading', modes: [], scopeId: null }, count: 1, period: 'day' }]) }],
    // §9.6: a family with no timezone gets no plan document at all, but a
    // hand-edited or half-written one must not produce a bar reading 0 of 3
    // forever with nothing visibly wrong. No zone, no panel.
    ['a plan with no timezone', { 'spellingstar-ada': spellingProfile(), 'starplan-ada': plan([{ id: 'sp', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 3, period: 'week' }], { timezone: null }) }],
  ];
  for (const [label, seed] of cases) {
    const { ctx, errors, text } = await open('spelling', seed);
    const body = await text();
    check(`${label}: no panel`, !/What I owe|All done here/.test(body), body.slice(0, 120));
    check(`${label}: the home screen is otherwise itself`, /What would you like to do today\?/.test(body));
    check(`${label}: no page errors`, errors.length === 0, errors);
    await ctx.close();
  }
}

section('Everything done');
{
  const { ctx, errors, text } = await open('spelling', seedFor('spelling', [
    { id: 'sp', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 2, period: 'week' },
  ]));
  const body = await text();
  check('the panel says so rather than showing a bare list', /All done here/.test(body), body.slice(0, 160));
  check('and still does not lock anything', /What would you like to do today\?/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

await browser.close();
await staticServer.close();
process.exit(report('plan-panel') ? 1 : 0);
