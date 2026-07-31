// Spelling Star's first-launch wizard, and the migration path for a profile
// saved before word lists carried a grade (§16.5).
import { createChecker, launchBrowser, serveRepo, isRealPageError } from './harness.mjs';

const staticServer = await serveRepo();
const BASE = staticServer.url;
const { check, report } = createChecker();
const browser = await launchBrowser();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && isRealPageError(m.text())) errors.push('console: ' + m.text()); });

console.log('\n[Fresh install — Spelling Star setup wizard]');
await page.goto(`${BASE}/spelling-star-v6_3.html`);
await page.waitForTimeout(500);
check('starts at step 1 of 4', (await page.textContent('#app')).includes('Step 1 of 4'));
await page.fill('#pinIn', '1234'); await page.fill('#pinIn2', '1234');
await page.click('button:has-text("Continue")'); await page.waitForTimeout(200);
check('step 2 of 4', (await page.textContent('#app')).includes('Step 2 of 4'));
await page.fill('#nameIn', 'Rosa');
await page.click('button:has-text("Continue")'); await page.waitForTimeout(200);
check('step 3 asks about scoring', (await page.textContent('#app')).includes('Step 3 of 4') && (await page.textContent('#app')).includes('Percentage'));
await page.click('button:has-text("Points")'); await page.waitForTimeout(200);
check('step 4 asks for a grade', (await page.textContent('#app')).includes('Step 4 of 4') && (await page.textContent('#app')).includes('grade level'));
await page.click('button:has-text("4")'); await page.waitForTimeout(500);

const d = JSON.parse(await page.evaluate(() => localStorage.getItem('spellingstar-rosa')));
check('profile created', !!d, d);
check('scoring survived the extra step', d.scoring === 'points', d.scoring);
check('grade recorded on the profile', d.gradeLevel === '4', d.gradeLevel);
check('starter list inherits it', d.lists[0].grade === '4', d.lists[0]);
check('landed on the home screen', (await page.textContent('#app')).length > 0);
check('no page errors', errors.length === 0, errors);

console.log('\n[Old profile opens untouched]');
const ctx2 = await browser.newContext();
const page2 = await ctx2.newPage();
const errors2 = [];
page2.on('pageerror', (e) => errors2.push(String(e)));
// A v6.3 profile from before grades existed — no gradeLevel, no list.grade.
await page2.addInitScript(() => localStorage.setItem('spellingstar-ada', JSON.stringify({
  childName: 'Ada', pin: '1234', scoring: 'percent', showHistory: true,
  lists: [{ id: 'starter', name: 'Starter Words', desc: '', words: [{ word: 'cat', hint: 'h', sentence: 's' }], bonus: [] }],
  activeListId: 'starter', reviewWords: [], graduated: [],
  sessions: [{ id: 1, date: new Date().toISOString(), mode: 'test', listName: 'Starter Words', score: 8, total: 10, results: [] }],
})));
await page2.goto(`${BASE}/spelling-star-v6_3.html`);
await page2.waitForTimeout(700);
const d2 = JSON.parse(await page2.evaluate(() => localStorage.getItem('spellingstar-ada')));
check('opens without error', errors2.length === 0, errors2);
// load()'s migrations run in memory and are written out on the next persist(),
// exactly like every other migration in that function — so read the live
// object, not the yet-unwritten blob.
const liveGrade = await page2.evaluate(() => data.gradeLevel);
check('gets a default gradeLevel in memory', liveGrade === '2', liveGrade);
check('and localStorage is not rewritten just by opening', d2.gradeLevel === undefined, d2.gradeLevel);
check('but its list is NOT silently graded', d2.lists[0].grade === undefined, d2.lists[0].grade);
check('its old session keeps no grade', d2.sessions[0].listGrade === undefined, d2.sessions[0]);
const label = await page2.evaluate(() => gradeLabel(data.lists[0].grade));
check('and reads as Ungraded in the UI', label === 'Ungraded', label);

await browser.close();
await staticServer.close();
process.exit(report('setup-wizard') ? 1 : 0);
