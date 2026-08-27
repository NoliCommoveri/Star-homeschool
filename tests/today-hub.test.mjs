// today.html — the kid's hub. docs/assignment-spec.md §8.
//
// Two properties are worth more than the rest here and the suite is arranged
// around them:
//
// The hub is a PURE READER (§8.1). It has no PIN because it cannot do damage —
// no network, no token, no write to any app's data, one key of its own. That is
// the entire safety argument for the page, and it is the kind of invariant that
// is true on the day it ships and quietly false two features later, so it is
// asserted directly rather than inferred from the code.
//
// It counts the same sittings the phone counts (§3). Nobody reports progress
// upward; both sides evaluate the same plan against the same history and have
// to land on the same number. shared-code.test.mjs pins the evaluator's source
// as byte-identical — this suite pins the five adapters that feed it, which are
// the half that is NOT shared and where a miscount would actually come from.
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const staticServer = await serveRepo();
const BASE = staticServer.url;
const { check, section, report } = createChecker();
const browser = await launchBrowser();

// Everything is counted in one fixed zone so the assertions do not depend on
// where the test is run. UTC also makes "today" here the same day the seeded
// ISO timestamps fall on.
const TZ = 'UTC';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const at = (hour) => new Date(today + 'T' + String(hour).padStart(2, '0') + ':00:00Z').toISOString();
const atMs = (hour) => Date.parse(at(hour));
const shift = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);

function plan(items, extra) {
  return Object.assign({ revision: 3, timezone: TZ, weekStart: 0, items }, extra || {});
}

// A profile as each app actually writes one, trimmed to the fields the hub
// reads — plus `pin`, which is there because §8.5 exists: the hub must pull
// named fields and never spread a profile into a template.
const PROFILES = {
  'spellingstar-rosa': {
    childName: 'Rosa', pin: '4321',
    sessions: [
      { id: 101, date: at(9),  mode: 'practice', listName: 'List 5.12', listId: 'l-512', score: 8, total: 10 },
      { id: 102, date: at(10), mode: 'practice', listName: 'List 5.12', listId: 'l-512', score: 9, total: 10 },
      { id: 103, date: at(11), mode: 'test',     listName: 'List 5.12', listId: 'l-512', score: 10, total: 10 },
      // tone 'play' — a game, not homework (§5). Never swept up by a broad match.
      { id: 104, date: at(12), mode: 'spotit',   listName: 'List 5.12', listId: 'l-512', score: 6, total: 6 },
      { id: 105, date: at(13), mode: 'missing',  listName: 'List 5.12', listId: 'l-512', score: 5, total: 5 },
    ],
  },
  'mathstar-rosa': {
    childName: 'Rosa', pin: '4321',
    sessions: [
      { id: 201, date: at(14), mode: 'drill',    focusName: 'x7', focusId: 'f-7', score: 18, total: 20 },
      { id: 202, date: at(15), mode: 'practice', focusName: 'x7', focusId: 'f-7', score: 19, total: 20 },
    ],
  },
  'readingstar-rosa': {
    childName: 'Rosa', pin: '4321',
    events: [
      // tone 'lifecycle' — opening a book is not a sitting at one (§5).
      { id: 'e1', date: at(16), mode: 'start',       bookId: 'b-1', bookTitle: 'Frindle' },
      { id: 'e2', date: at(17), mode: 'log-session', bookId: 'b-1', bookTitle: 'Frindle', minutes: 20 },
    ],
    // §8.6: the nested copies share their event's id. Reading both arrays would
    // double-count every sitting, and the hub must not read this one at all.
    books: [{
      id: 'b-1', title: 'Frindle', status: 'reading',
      sessions: [{ id: 'e2', date: at(17), mode: 'log-session', minutes: 20 }],
    }],
  },
  'geostar-rosa': {
    childName: 'Rosa', pin: '4321',
    sessionLog: [
      { date: atMs(8), mode: 'capitals', region: 'Midwest', correct: 9, total: 10 },
      { date: atMs(9), mode: 'find',     region: 'Midwest', correct: 7, total: 10 },
      { date: atMs(10), mode: 'nature',  region: 'Midwest', correct: 8, total: 10 },
    ],
  },
  'logicstar-rosa': {
    childName: 'Rosa', pin: '4321',
    sessionLog: [{ date: atMs(11), mode: 'grid', level: 'easy', solved: true, score: 1, total: 1 }],
  },
};

// ---------------------------------------------------------------------------

async function open(seed) {
  const ctx = await browser.newContext({ timezoneId: 'Australia/Sydney' });
  const page = await ctx.newPage();
  const errors = [];
  const apiCalls = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith(BASE) || /\/api\//.test(r.url())) apiCalls.push(r.url()); });
  await page.addInitScript((entries) => {
    for (const [key, value] of entries) localStorage.setItem(key, JSON.stringify(value));
  }, Object.entries(seed));
  await page.goto(`${BASE}/today.html`);
  await page.waitForTimeout(400);
  return { ctx, page, errors, apiCalls, text: () => page.textContent('#app') };
}

// The browser context above is deliberately in Sydney while every plan says
// UTC: a hub that quietly used the device's zone would bucket half these
// sittings into tomorrow and the counts below would be wrong (§9.5).

section('No profiles at all');
{
  const { ctx, page, errors } = await open({});
  const body = await page.textContent('#app');
  check('says so plainly rather than erroring', /Nothing here yet/.test(body), body.slice(0, 120));
  check('and points at the launcher', (await page.getAttribute('.card a', 'href')) === './index.html');
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('One child, no plan — useful the day it ships');
{
  const { ctx, page, errors, text } = await open(PROFILES);
  const body = await text();
  check('no picker for a single child', !(await page.$('#childSel')));
  check('names the child', /Rosa's day/.test(body), body.slice(0, 80));
  check('says nothing is owed', /No targets set yet/.test(body));
  // 3 spelling (2 practice + 1 test; the two games do not count), 2 math,
  // 1 reading (start is lifecycle), 3 geography rounds, 1 logic puzzle.
  check('spelling tally excludes the games', /3 Spelling sittings/.test(body), body.match(/This week so far[\s\S]{0,160}/));
  check('math tally', /2 Math sittings/.test(body));
  check('reading tally excludes the lifecycle row', /1 Reading session\b/.test(body));
  check('geography appears uncounted (§8.7)', /3 Geography rounds/.test(body));
  check('logic appears uncounted, singular', /1 Logic puzzle\b/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('Targets, counted the way the phone counts them');
{
  const seed = Object.assign({}, PROFILES, {
    'starplan-rosa': plan([
      { id: 'sp-practice', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'], scopeId: null }, count: 3, period: 'week' },
      { id: 'sp-test', label: 'Spelling test', match: { app: 'spelling', modes: ['test'], scopeId: null }, count: 1, period: 'week' },
      { id: 'ma-any', label: 'Math', match: { app: 'math', modes: [], scopeId: null }, count: 4, period: 'day' },
      { id: 'all-work', label: 'Anything that counts', match: { app: null, modes: [], scopeId: null }, count: 20, period: 'week' },
    ]),
  });
  const { ctx, page, errors, apiCalls, text } = await open(seed);
  const body = await text();

  check('a met target reads as done', /Spelling test[\s\S]{0,80}1 of 1/.test(body), body.match(/Spelling test[\s\S]{0,90}/));
  check('an unmet one shows the count, not a verdict', /Spelling practice[\s\S]{0,80}2 of 3/.test(body), body.match(/Spelling practice[\s\S]{0,90}/));
  check('no percentage anywhere (§8.3)', !/\d%/.test(body), body.match(/\d+%/));
  check('a daily target reads "every day"', /every day/.test(body));

  // The broad cross-app match is the one that exercises every adapter at once:
  // 3 spelling + 2 math + 1 reading = 6. Geography and Logic are in the same
  // history and DO count here — §14 keeps them out of the parent's editor, not
  // out of the registry — so 6 + 3 + 1 = 10.
  check('a cross-app target sweeps every app that counts', /Anything that counts[\s\S]{0,80}10 of 20/.test(body),
    body.match(/Anything that counts[\s\S]{0,90}/));

  const heads = await page.$$eval('.card-head h2', (els) => els.map((e) => e.textContent));
  check('grouped per app, cross-app last', JSON.stringify(heads) === JSON.stringify(['Spelling Star', 'Math Star', 'Across every app']), heads);
  check('each app card is a door into the app', (await page.getAttribute('.card-head a', 'href')) === './spelling-star-v6_3.html');
  check('done targets show a filled bar', (await page.$$('.bar.met')).length === 1);
  check('no network beyond the page itself (§8.1)', apiCalls.length === 0, apiCalls);
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('It writes nothing but its own key (§8.1)');
{
  const seed = Object.assign({}, PROFILES, {
    'starplan-rosa': plan([{ id: 'x', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'] }, count: 3, period: 'week' }]),
  });
  const { ctx, page, errors } = await open(seed);
  const after = await page.evaluate(() => {
    const out = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out[k] = localStorage.getItem(k); }
    return out;
  });
  const seedKeys = Object.keys(seed).sort();
  check('every profile is byte-for-byte what it was',
    seedKeys.every((k) => after[k] === JSON.stringify(seed[k])),
    seedKeys.filter((k) => after[k] !== JSON.stringify(seed[k])));
  check('the plan key is not rewritten (§7.1 rule 2)', after['starplan-rosa'] === JSON.stringify(seed['starplan-rosa']));
  check('and no key of its own until a child is chosen', after['starhub-lastchild'] === undefined, after['starhub-lastchild']);
  check('the PIN never reaches the page (§8.5)', !(await page.content()).includes('4321'));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('A dated assignment leaves the child\'s view when its window closes (§4.3)');
{
  const seed = Object.assign({}, PROFILES, {
    'starplan-rosa': plan([
      { id: 'due-soon', label: 'Test on list 5.12', match: { app: 'spelling', modes: ['test'], scopeId: 'l-512' }, count: 1, period: { from: shift(today, -2), to: shift(today, 2) } },
      { id: 'due-past', label: 'Last week\'s test', match: { app: 'spelling', modes: ['test'], scopeId: 'l-512' }, count: 1, period: { from: shift(today, -9), to: shift(today, -3) } },
      { id: 'bad-period', label: 'Malformed', match: { app: 'math', modes: [] }, count: 1, period: 'fortnight' },
    ]),
  });
  const { ctx, page, errors, text } = await open(seed);
  const body = await text();
  // A met assignment still names its deadline: "Done ✓" alone does not say
  // which piece of work is done.
  check('an open window shows, with its deadline', /Test on list 5\.12[\s\S]{0,90}by [A-Z][a-z]{2} \d/.test(body), body.match(/Test on list 5\.12[\s\S]{0,110}/));
  check('a closed one is gone', !/Last week's test/.test(body));
  check('a period this version cannot place is dropped, not guessed at', !/Malformed/.test(body));
  check('a scoped match still counts the right sitting', /Test on list 5\.12[\s\S]{0,80}1 of 1/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('Two children on one tablet (§8.4)');
{
  const seed = Object.assign({}, PROFILES, {
    'spellingstar-abe': { childName: 'Abe', pin: '1111', sessions: [{ id: 301, date: at(9), mode: 'practice', listId: 'l-1' }] },
    // Same child, a second app: one entry, not two. The slug is the identity.
    'geostar-abe': { childName: 'Abe', pin: '1111', sessionLog: [{ date: atMs(9), mode: 'find', correct: 5, total: 10 }] },
  });
  const { ctx, page, errors } = await open(seed);
  const options = await page.$$eval('#childSel option', (els) => els.map((e) => e.value));
  check('one entry per child, deduplicated by slug', JSON.stringify(options) === JSON.stringify(['abe', 'rosa']), options);
  check('first alphabetically by default', /Abe's day/.test(await page.textContent('#app')));

  await page.selectOption('#childSel', 'rosa');
  await page.waitForTimeout(200);
  check('choosing repaints for that child', /Rosa's day/.test(await page.textContent('#app')));
  check('and remembers the choice', (await page.evaluate(() => localStorage.getItem('starhub-lastchild'))) === 'rosa');

  await page.reload();
  await page.waitForTimeout(300);
  check('which survives a reload', /Rosa's day/.test(await page.textContent('#app')));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

section('Duplicates and unreadable data');
{
  const seed = {
    'spellingstar-rosa': {
      childName: 'Rosa', pin: '4321',
      sessions: [
        { id: 101, date: at(9), mode: 'practice', listId: 'l-1' },
        // The same sitting twice — what a re-push under an adopted childId
        // leaves behind (§10.2). Counted once, or a child meets a target they
        // did not.
        { id: 101, date: at(9), mode: 'practice', listId: 'l-1' },
        { id: 102, date: at(10), mode: 'practice', listId: 'l-1' },
        { id: 103, date: 'not a date', mode: 'practice', listId: 'l-1' },
      ],
    },
    'starplan-rosa': plan([{ id: 'p', label: 'Spelling practice', match: { app: 'spelling', modes: ['practice'] }, count: 3, period: 'week' }]),
  };
  const { ctx, page, errors, text } = await open(seed);
  const body = await text();
  check('a repeated id counts once, and an unparseable date not at all', /2 of 3/.test(body), body.match(/Spelling practice[\s\S]{0,90}/));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}
{
  const { ctx, page, errors } = await open({});
  await page.evaluate(() => {
    localStorage.setItem('spellingstar-rosa', '{ this is not json');
    localStorage.setItem('mathstar-rosa', JSON.stringify({ childName: 'Rosa', pin: '1', sessions: [{ id: 1, date: new Date().toISOString(), mode: 'drill' }] }));
    localStorage.setItem('starplan-rosa', 'also not json');
  });
  await page.reload();
  await page.waitForTimeout(300);
  const body = await page.textContent('#app');
  check('a corrupt profile does not take the page down with it', /Rosa's day/.test(body), body.slice(0, 120));
  check('an unreadable plan falls back to no targets', /No targets set yet/.test(body));
  check('and the readable app still counts', /1 Math sitting\b/.test(body));
  check('no page errors', errors.length === 0, errors);
  await ctx.close();
}

await browser.close();
await staticServer.close();
process.exit(report('today-hub') ? 1 : 0);
