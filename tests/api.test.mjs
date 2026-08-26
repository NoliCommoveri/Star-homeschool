// The API end to end, against a real SQLite database driving the actual
// functions/api/* handlers through a D1-shaped shim.
//
// No browser and no dependencies — node:sqlite is built in — so this is the
// suite that always runs. It covers the Phase 3 command loop (spec §15), the
// grade columns and multi-year summary (§16), and the §6.5 authorization
// boundary that everything else rests on.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createChecker, REPO } from './harness.mjs';

const { check, report } = createChecker();
const db = new DatabaseSync(':memory:');

// schema.sql is multi-statement with comments; node:sqlite exec handles it.
db.exec(readFileSync(REPO + 'schema.sql', 'utf8'));

function normalize(args) {
  return args.map((a) => (typeof a === 'boolean' ? (a ? 1 : 0) : a === undefined ? null : a));
}
const DB = {
  prepare(sql) {
    const stmt = db.prepare(sql);
    let args = [];
    const api = {
      bind(...a) { args = normalize(a); return api; },
      async first() { return stmt.get(...args) ?? null; },
      async all() { return { results: stmt.all(...args) }; },
      async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
    };
    return api;
  },
  async batch(stmts) { for (const s of stmts) await s.run(); },
  // D1 has exec() for one-off DDL and the migration runner uses it. Like D1's,
  // this takes a single statement.
  async exec(sql) { db.exec(sql); return { count: 1 }; },
};
const env = { DB, SIGNUP_SECRET: 'test-secret' };

const post = (url, body, token) => ({
  request: new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  }),
  env,
});
const get = (url, token) => ({
  request: new Request(url, { headers: token ? { Authorization: 'Bearer ' + token } : {} }),
  env,
});
const put = (url, body, token) => ({
  request: new Request(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  }),
  env,
});

const mod = (p) => import(REPO + 'functions/api/' + p);
const body = async (res) => [res.status, await res.json()];


// ---------------------------------------------------------------- setup ----
console.log('\n[setup] family + devices');
const family = await mod('family.js');
let [st, fam] = await body(await family.onRequestPost(post('http://x/api/family', {
  signupSecret: 'test-secret', deviceId: 'parent-device', label: "Mum's phone",
})));
check('family created', st === 200 && !!fam.token, fam);
const parentToken = fam.token;

const pairingCode = await mod('pairing-code.js');
const pair = await mod('pair.js');
async function pairChild(deviceId, label) {
  const [, c] = await body(await pairingCode.onRequestPost(post('http://x/api/pairing-code', { role: 'child' }, parentToken)));
  const [, p] = await body(await pair.onRequestPost(post('http://x/api/pair', { code: c.code, deviceId, role: 'child', label })));
  return p.token;
}
const tabletToken = await pairChild('tablet-1', "Ada's tablet");
const tablet2Token = await pairChild('tablet-2', 'The old iPad');
check('two child devices paired', !!tabletToken && !!tablet2Token);

// ----------------------------------------------------------- child sync ----
console.log('\n[child] first sync uploads sessions + state, gets no commands');
const sync = await mod('sync.js');
const CHILD = 'child-ada';
const spellingState = {
  lists: [
    { id: 'starter', name: 'Starter Words', wordCount: 3, bonusCount: 0, pretest: 'global' },
    { id: 'l99', name: 'Week 11', wordCount: 8, bonusCount: 2, pretest: 'global' },
  ],
  activeListId: 'starter',
};
let [, r] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada',
  sessions: [
    { id: 1001, date: new Date().toISOString(), mode: 'pretest', score: 10, total: 10, listName: 'Week 11', results: [] },
    { id: 1002, date: new Date().toISOString(), mode: 'test', score: 10, total: 10, listName: 'Week 11', promotedFrom: 1001, results: [] },
    { id: 1003, date: new Date().toISOString(), mode: 'practice', score: 7, total: 10, listName: 'Week 11', results: [] },
  ],
  state: spellingState,
}, tabletToken)));
check('3 sessions accepted', r.accepted.length === 3, r.accepted);
check('no commands pending', r.commands.length === 0, r.commands);

// -------------------------------------------------------- parent reads -----
console.log('\n[parent] sees the tablet snapshot');
const childState = await mod('child-state.js');
let [, snap] = await body(await childState.onRequestGet(get(`http://x/api/child-state?childId=${CHILD}&app=spelling`, parentToken)));
check('snapshot returned', snap.snapshots.length === 1, snap);
check('snapshot names the device', snap.snapshots[0].deviceLabel === "Ada's tablet", snap.snapshots[0]);
check('snapshot carries the lists', snap.snapshots[0].state.lists.length === 2);

// ------------------------------------------------------ parent assigns -----
console.log('\n[parent] assigns an existing list, then sends a new one');
const commands = await mod('commands.js');
let [cst, c1] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'spelling', childIds: [CHILD], kind: 'set-active-list', payload: { listId: 'l99' },
}, parentToken)));
check('set-active-list queued', cst === 200 && c1.commands.length === 1, c1);

let [, c2] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'spelling', childIds: [CHILD], kind: 'assign-list',
  payload: { list: { name: 'Week 12', words: [{ word: 'because' }, { word: 'friend', hint: 'tricky' }] }, makeActive: true },
}, parentToken)));
check('assign-list queued', c2.commands.length === 1, c2);

let [bst] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'spelling', childIds: [CHILD], kind: 'nonsense', payload: {},
}, parentToken)));
check('unknown kind rejected 400', bst === 400, bst);

// -------------------------------------------------- commands reach child ----
console.log('\n[child] pulls the commands, applies, acks');
[, r] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada', sessions: [], state: spellingState,
}, tabletToken)));
check('2 commands delivered', r.commands.length === 2, r.commands.map((c) => c.kind));
check('payload arrives parsed', r.commands[1].payload.list.name === 'Week 12', r.commands[1].payload);
check('commands are in send order', r.commands[0].kind === 'set-active-list');

const appliedIds = r.commands.map((c) => c.id);
[, r] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, sessions: [], applied: appliedIds,
}, tabletToken)));
check('nothing resent after ack', r.commands.length === 0, r.commands);

console.log('\n[child] a second tablet on the same child still gets them');
[, r] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, sessions: [], applied: [],
}, tablet2Token)));
check('second device sees both commands', r.commands.length === 2, r.commands.length);

console.log('\n[parent] delivery status');
let [, list] = await body(await commands.onRequestGet(get(`http://x/api/commands?childId=${CHILD}&app=spelling`, parentToken)));
check('both show 1 ack', list.commands.filter((c) => c.ackCount === 1).length === 2, list.commands.map((c) => c.ackCount));

// ------------------------------------------------------------- cancel ------
console.log('\n[parent] cancel before vs after delivery');
const cancel = await mod('commands/cancel.js');
let [, c3] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'spelling', childIds: [CHILD], kind: 'set-active-list', payload: { listId: 'starter' },
}, parentToken)));
let [, cx] = await body(await cancel.onRequestPost(post('http://x/api/commands/cancel', { commandIds: [c3.commands[0].id] }, parentToken)));
check('undelivered command cancels', cx.canceled === 1, cx);
let [, cy] = await body(await cancel.onRequestPost(post('http://x/api/commands/cancel', { commandIds: [appliedIds[0]] }, parentToken)));
check('delivered command will not cancel', cy.canceled === 0, cy);
[, r] = await body(await sync.onRequestPost(post('http://x/api/sync', { app: 'spelling', childId: CHILD, sessions: [], applied: [] }, tabletToken)));
check('canceled command never delivered', r.commands.length === 0, r.commands);

// ------------------------------------------------------ session delete -----
console.log('\n[parent] deletes a session — both halves');
const sessionsMod = await mod('sessions.js');
const sessionDelete = await mod('sessions/delete.js');
let [, before] = await body(await sessionsMod.onRequestGet(get(`http://x/api/sessions?childId=${CHILD}&app=spelling`, parentToken)));
check('3 sessions visible', before.sessions.length === 3, before.sessions.length);

let [dst, del] = await body(await sessionDelete.onRequestPost(post('http://x/api/sessions/delete', {
  app: 'spelling', childIds: [CHILD], sessionIds: ['1001', '1002'],
}, parentToken)));
check('delete accepted', dst === 200 && del.rows === 2, del);

let [, after] = await body(await sessionsMod.onRequestGet(get(`http://x/api/sessions?childId=${CHILD}&app=spelling`, parentToken)));
check('dashboard now shows 1', after.sessions.length === 1, after.sessions.map((s) => s.id));

[, r] = await body(await sync.onRequestPost(post('http://x/api/sync', { app: 'spelling', childId: CHILD, sessions: [], applied: [] }, tabletToken)));
check('tablet gets the delete command', r.commands.length === 1 && r.commands[0].kind === 'delete-session', r.commands);
check('delete names both ids', JSON.stringify(r.commands[0].payload.sessionIds) === '["1001","1002"]', r.commands[0].payload);

console.log('\n[child] a stale re-push cannot resurrect a deleted session');
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD,
  sessions: [{ id: 1001, date: new Date().toISOString(), mode: 'pretest', score: 10, total: 10, results: [] }],
}, tabletToken));
let [, after2] = await body(await sessionsMod.onRequestGet(get(`http://x/api/sessions?childId=${CHILD}&app=spelling`, parentToken)));
check('still 1 session', after2.sessions.length === 1, after2.sessions.map((s) => s.id));

// ----------------------------------------------------------- boundary ------
console.log('\n[security] the §6.5 authorization boundary still holds');
let [, fam2] = await body(await family.onRequestPost(post('http://x/api/family', {
  signupSecret: 'test-secret', deviceId: 'other-parent', label: 'Another family',
})));
const otherParent = fam2.token;

let [os] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'spelling', childIds: [CHILD], kind: 'set-active-list', payload: { listId: 'l99' },
}, otherParent)));
check('cross-family command queue 404s', os === 404, os);

let [os2] = await body(await childState.onRequestGet(get(`http://x/api/child-state?childId=${CHILD}&app=spelling`, otherParent)));
check('cross-family snapshot 404s', os2 === 404, os2);

let [os3] = await body(await sessionDelete.onRequestPost(post('http://x/api/sessions/delete', {
  app: 'spelling', childIds: [CHILD], sessionIds: ['1003'],
}, otherParent)));
check('cross-family delete 404s', os3 === 404, os3);

let [os4] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'spelling', childIds: [CHILD], kind: 'set-active-list', payload: {},
}, tabletToken)));
check('child token cannot queue commands (403)', os4 === 403, os4);

const otherTabletToken = await (async () => {
  const [, c] = await body(await pairingCode.onRequestPost(post('http://x/api/pairing-code', { role: 'child' }, otherParent)));
  const [, p] = await body(await pair.onRequestPost(post('http://x/api/pair', { code: c.code, deviceId: 'other-tablet', role: 'child' })));
  return p.token;
})();
let [, oc] = await body(await sync.onRequestPost(post('http://x/api/sync', { app: 'spelling', childId: 'other-kid', childName: 'Ben', sessions: [], applied: [] }, otherTabletToken)));
check("other family's tablet sees no commands", oc.commands.length === 0, oc.commands);

let [ost] = await body(await sync.onRequestPost(post('http://x/api/sync', { app: 'spelling', childId: CHILD, sessions: [] }, otherTabletToken)));
check("other family's tablet cannot sync onto our child (404)", ost === 404, ost);

// ------------------------------------------------- childId adoption path ---
console.log('\n[§6.2] a command queued under a legacy childId still lands');
const LEGACY = 'child-ada-old';
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'math', childId: LEGACY, childName: 'Ada',
  sessions: [{ id: 2001, date: new Date().toISOString(), mode: 'drill', score: 5, total: 10, results: [] }],
}, tabletToken));
await commands.onRequestPost(post('http://x/api/commands', {
  app: 'math', childIds: [LEGACY], kind: 'set-active-focus', payload: { focusId: 'f1' },
}, parentToken));
// The tablet has since adopted the shared id and now syncs math under CHILD.
[, r] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'math', childId: CHILD, childName: 'Ada', sessions: [], applied: [],
}, tabletToken)));
check('legacy-id command reaches the adopted child', r.commands.length === 1 && r.commands[0].kind === 'set-active-focus', r.commands);

console.log('\n[§6.2] but only for the device that owns that legacy id');
[, r] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'math', childId: 'unrelated-child', childName: 'Ben', sessions: [], applied: [],
}, tablet2Token)));
check('unrelated device gets nothing', r.commands.length === 0, r.commands);

// ------------------------------------------------------------- size cap ----
console.log('\n[limits] oversized payloads are refused');
let [lst] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'spelling', childIds: [CHILD], kind: 'assign-list', payload: { blob: 'x'.repeat(70000) },
}, parentToken)));
check('payload over 64 KB → 413', lst === 413, lst);
let [sst] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, sessions: [], state: { blob: 'x'.repeat(140000) },
}, tabletToken)));
check('state over 128 KB → 413', sst === 413, sst);


// ------------------------------------------------------- §16 summary -------
console.log('\n[§16] grade columns and the multi-year summary');
const summary = await mod('summary.js');
const KID = 'child-grade';
const day = (n) => new Date(Date.now() - n * 86400000).toISOString();

// Two years of Spelling: "Unit 1" exists in both Grade 3 and Grade 5.
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: KID, childName: 'Mo',
  sessions: [
    { id: 5001, date: day(700), mode: 'test',     score: 7,  total: 10, listName: 'Unit 1', listId: 'g3u1', listGrade: '3', results: [] },
    { id: 5002, date: day(690), mode: 'test',     score: 9,  total: 10, listName: 'Unit 1', listId: 'g3u1', listGrade: '3', results: [] },
    { id: 5003, date: day(680), mode: 'practice', score: 10, total: 10, listName: 'Unit 1', listId: 'g3u1', listGrade: '3', results: [] },
    { id: 5004, date: day(20),  mode: 'test',     score: 6,  total: 10, listName: 'Unit 1', listId: 'g5u1', listGrade: '5', results: [] },
    { id: 5005, date: day(10),  mode: 'test',     score: 8,  total: 12, listName: 'Unit 2', listId: 'g5u2', listGrade: '5', results: [] },
    { id: 5006, date: day(900), mode: 'test',     score: 5,  total: 10, listName: 'Old list', results: [] }, // pre-grade client
  ],
}, tabletToken));

let [sst2, sum] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=spelling&mode=test`, parentToken)));
check('summary 200s', sst2 === 200, sst2);
const byScope = Object.fromEntries(sum.lists.map((l) => [l.scopeId || 'none', l]));
check('same list name in two grades stays two rows',
  sum.lists.filter((l) => l.scopeName === 'Unit 1').length === 2, sum.lists.map((l) => [l.grade, l.scopeName]));
check('best test wins, not the latest', byScope.g3u1.best === 0.9, byScope.g3u1.best);
check('practice sittings are not counted', byScope.g3u1.attempts === 2, byScope.g3u1.attempts);
check('grade rides on the row', byScope.g3u1.grade === '3' && byScope.g5u1.grade === '5');
check('scope_name frozen at write time', byScope.g5u2.scopeName === 'Unit 2', byScope.g5u2.scopeName);
check('unequal totals still compare as ratios', Math.abs(byScope.g5u2.best - 8/12) < 1e-9, byScope.g5u2.best);
check('pre-grade sessions bucket under null', byScope.none && byScope.none.grade === null, byScope.none);
check('first/last dates span the attempts', byScope.g3u1.firstAt < byScope.g3u1.lastAt);

console.log('\n[§16] a promoted pretest counts');
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: KID,
  sessions: [{ id: 5007, date: day(5), mode: 'test', score: 10, total: 10, listName: 'Unit 3', listId: 'g5u3', listGrade: '5', promotedFrom: 5008, results: [] }],
}, tabletToken));
[, sum] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=spelling&mode=test`, parentToken)));
const u3 = sum.lists.find((l) => l.scopeId === 'g5u3');
check('auto-promoted test is in the record', u3 && u3.best === 1, u3);

console.log('\n[§16] math uses its own graded mode');
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'math', childId: KID, childName: 'Mo',
  sessions: [
    { id: 6001, date: day(30), mode: 'drill',    score: 8,  total: 10, focusName: 'Times tables', focusId: 'f1', focusGrade: '4', results: [] },
    { id: 6002, date: day(20), mode: 'practice', score: 10, total: 10, focusName: 'Times tables', focusId: 'f1', focusGrade: '4', results: [] },
  ],
}, tabletToken));
let [, msum] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=math&mode=drill`, parentToken)));
check('math drill summarized', msum.lists.length === 1 && msum.lists[0].best === 0.8, msum.lists);
check('math practice excluded', msum.lists[0].attempts === 1, msum.lists[0].attempts);

// reading-star-spec.md §3.3 finding 1: sessionScope() had no `reading` branch
// at all until this Worker edit, so every reading event landed with grade/
// scope_id/scope_name silently NULL — the INSERT still succeeded, so nothing
// but a query like this would have caught it.
console.log("\n[§16] reading stamps grade from the CHILD, scope from the book");
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'reading', childId: KID, childName: 'Mo',
  sessions: [
    { id: 7001, date: day(15), mode: 'start', bookId: 'book-1', bookTitle: 'A Horse Called Wonder', childGrade: '4', catalogId: 'thoroughbred-1', author: 'Joanna Campbell' },
    { id: 7002, date: day(10), mode: 'quiz', score: 9, total: 11, bookId: 'book-1', bookTitle: 'A Horse Called Wonder', childGrade: '4', catalogId: 'thoroughbred-1', author: 'Joanna Campbell', missed: ['thoroughbred-1-q3', 'thoroughbred-1-q7'] },
    { id: 7003, date: day(9),  mode: 'log-session', bookId: 'book-1', bookTitle: 'A Horse Called Wonder', childGrade: '4', minutes: 20 },
  ],
}, tabletToken));
const readingRow = await DB.prepare("SELECT grade, scope_id, scope_name FROM sessions WHERE session_id = '7002'").bind().first();
check('grade is the CHILD\'s school grade, not the book\'s difficulty band', readingRow.grade === '4', readingRow);
check('scope_id is the book id', readingRow.scope_id === 'book-1', readingRow);
check('scope_name is the book title, frozen at write time', readingRow.scope_name === 'A Horse Called Wonder', readingRow);

let [, rsum] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=reading&mode=quiz`, parentToken)));
check('reading summarizes like any other app: best quiz score per book', rsum.lists.length === 1 && Math.abs(rsum.lists[0].best - 9/11) < 1e-9, rsum.lists);
check('start/log-session (no score) drop out on their own, no new server code', rsum.lists[0].attempts === 1, rsum.lists[0].attempts);

let [, rsess] = await body(await sessionsMod.onRequestGet(get(`http://x/api/sessions?childId=${KID}&app=reading`, parentToken)));
const quizRow = rsess.sessions.find((s) => s.id === '7002');
check('title/author/missed ride in payload, readable off /api/sessions', quizRow.bookTitle === 'A Horse Called Wonder' && quizRow.author === 'Joanna Campbell' && JSON.stringify(quizRow.missed) === '["thoroughbred-1-q3","thoroughbred-1-q7"]', quizRow);

// reading-star-spec.md §4.3 (Phase 1b): assign-book/delete-book ride the same
// COMMAND_KINDS whitelist as assign-list — this only checks the server's
// whitelist accepts them and queues a command; what the tablet does with the
// payload is exercised in tests/child-apps.test.mjs.
console.log('\n[§4.3] assign-book / delete-book are known command kinds');
let [abst, abr] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'reading', childIds: [KID], kind: 'assign-book',
  payload: { book: { key: 'p-abc123', title: 'Custom Book', author: 'A Parent', questions: [] } },
}, parentToken)));
check('assign-book queued', abst === 200 && abr.commands.length === 1, abr);
let [dbst, dbr] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'reading', childIds: [KID], kind: 'delete-book', payload: { key: 'p-abc123' },
}, parentToken)));
check('delete-book queued', dbst === 200 && dbr.commands.length === 1, dbr);

let [srst, srr] = await body(await commands.onRequestPost(post('http://x/api/commands', {
  app: 'reading', childIds: [KID], kind: 'set-reading-support-level', payload: { level: 'extra-support' },
}, parentToken)));
check('set-reading-support-level queued', srst === 200 && srr.commands.length === 1, srr);

console.log('\n[§16] a deleted session leaves the record');
await sessionDelete.onRequestPost(post('http://x/api/sessions/delete', {
  app: 'spelling', childIds: [KID], sessionIds: ['5002'],
}, parentToken));
[, sum] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=spelling&mode=test`, parentToken)));
const g3after = sum.lists.find((l) => l.scopeId === 'g3u1');
check('best falls back to the surviving attempt', g3after.best === 0.7, g3after.best);
check('attempt count drops too', g3after.attempts === 1, g3after.attempts);

console.log('\n[§16] boundary + old clients');
let [obst] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=spelling&mode=test`, otherParent)));
check('cross-family summary 404s', obst === 404, obst);
let [nbst] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=spelling`, parentToken)));
check('missing mode is a 400', nbst === 400, nbst);
let [cst2] = await body(await summary.onRequestGet(get(`http://x/api/summary?childId=${KID}&app=spelling&mode=test`, tabletToken)));
check('child token cannot read the summary', cst2 === 403, cst2);

const legacyRow = await DB.prepare("SELECT grade, scope_id, scope_name FROM sessions WHERE session_id = '5006'").bind().first();
check('a pre-grade client writes NULLs, not blanks',
  legacyRow.grade === null && legacyRow.scope_id === null && legacyRow.scope_name === 'Old list', legacyRow);

// ------------------------------------------------ parent-assigned childId ---
console.log('\n[§6.2] a pairing code minted with childName creates the child up front');
const children = await mod('children.js');
let [, newChildCode] = await body(await pairingCode.onRequestPost(post('http://x/api/pairing-code', {
  role: 'child', childName: 'Zoe',
}, parentToken)));
let [, listAfterMint] = await body(await children.onRequestGet(get('http://x/api/children', parentToken)));
const zoe = listAfterMint.children.find((c) => c.name === 'Zoe');
check('the child row exists before any device ever synced', !!zoe, listAfterMint.children);

let [, newDevicePair] = await body(await pair.onRequestPost(post('http://x/api/pair', {
  code: newChildCode.code, deviceId: 'zoe-tablet', role: 'child', label: "Zoe's tablet",
})));
check('pair response carries the assigned childId', newDevicePair.childId === zoe.id, newDevicePair);

console.log('\n[§6.2] a second device paired against the same childId lands on one child');
let [, resumeCode] = await body(await pairingCode.onRequestPost(post('http://x/api/pairing-code', {
  role: 'child', childId: zoe.id,
}, parentToken)));
let [, replacementPair] = await body(await pair.onRequestPost(post('http://x/api/pair', {
  code: resumeCode.code, deviceId: 'zoe-replacement-tablet', role: 'child', label: "Zoe's new tablet",
})));
check('the replacement device gets the same childId back, not a new one',
  replacementPair.childId === zoe.id, replacementPair);

console.log('\n[§6.2] childId is scoped to the minting parent\'s own family');
let [crossFamilyStatus] = await body(await pairingCode.onRequestPost(post('http://x/api/pairing-code', {
  role: 'child', childId: zoe.id,
}, otherParent)));
check('another family cannot mint a code bound to our child', crossFamilyStatus === 404, crossFamilyStatus);

console.log('\n[§6.2] omitting childId/childName still works, unbound, as before');
let [, unboundCode] = await body(await pairingCode.onRequestPost(post('http://x/api/pairing-code', { role: 'child' }, parentToken)));
let [, unboundPair] = await body(await pair.onRequestPost(post('http://x/api/pair', {
  code: unboundCode.code, deviceId: 'unbound-tablet', role: 'child', label: 'Unbound tablet',
})));
check('an unbound code pairs fine and carries no childId', !unboundPair.childId, unboundPair);


// ================= Phase 5: timezone and local_date (assignment-spec §9) ====

// The failure this catches is a fresh deployment that silently lacks something
// the live one has. schema.sql is the only file a new database is built from,
// and each schema-phaseN.sql is applied to the database that already exists —
// so anything added to a migration and not folded back into schema.sql works
// in production and is missing for everyone who deploys later. Nothing raises
// an error; the two databases just diverge.
console.log('\n[§12] every migration is folded into schema.sql');
{
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const indexes = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name));
  const columnsOf = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name));

  for (const phase of ['schema-phase3.sql', 'schema-phase4.sql', 'schema-phase5.sql']) {
    const sql = readFileSync(REPO + phase, 'utf8').replace(/--[^\n]*/g, '');
    for (const [, table] of sql.matchAll(/CREATE\s+TABLE\s+(\w+)/gi)) {
      check(`${phase}: schema.sql also creates ${table}`, tables.has(table));
    }
    for (const [, table, column] of sql.matchAll(/ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/gi)) {
      check(`${phase}: schema.sql also has ${table}.${column}`, columnsOf(table).has(column));
    }
    for (const [, index] of sql.matchAll(/CREATE\s+INDEX\s+(\w+)/gi)) {
      check(`${phase}: schema.sql also creates ${index}`, indexes.has(index));
    }
  }
}

console.log('\n[§9.3] the family timezone');
const settings = await mod('family/settings.js');

// A family created before Phase 5, or by a phone that could not resolve its
// own zone. This is a supported state (§9.6), not an error.
let [, tz0] = await body(await settings.onRequestGet(get('http://x/api/family/settings', parentToken)));
check('a family with no zone reads back null, not a guess', tz0.timezone === null, tz0);
check('week start defaults to Sunday', tz0.weekStart === 0, tz0);

let [tzBad] = await body(await settings.onRequestPut(put('http://x/api/family/settings', { timezone: 'Not/AZone' }, parentToken)));
check('an unresolvable zone is rejected', tzBad === 400, tzBad);

// §9.3 rules out a fixed offset explicitly: it is wrong for half the year in
// any zone that observes DST, and stamping the wrong day is the exact failure
// local_date exists to prevent.
let [tzOffset] = await body(await settings.onRequestPut(put('http://x/api/family/settings', { timezone: '+05:00' }, parentToken)));
check('a fixed offset is not a timezone', tzOffset === 400, tzOffset);
let [tzUtcOffset] = await body(await settings.onRequestPut(put('http://x/api/family/settings', { timezone: 'UTC+5' }, parentToken)));
check('nor is UTC+5', tzUtcOffset === 400, tzUtcOffset);

let [wsBad] = await body(await settings.onRequestPut(put('http://x/api/family/settings', { weekStart: 2 }, parentToken)));
check('week start is Sunday or Monday and nothing else', wsBad === 400, wsBad);

let [tzst, tzSaved] = await body(await settings.onRequestPut(put('http://x/api/family/settings', {
  timezone: 'America/Chicago', weekStart: 1,
}, parentToken)));
check('a real zone saves', tzst === 200 && tzSaved.timezone === 'America/Chicago', tzSaved);
check('and the week start with it', tzSaved.weekStart === 1, tzSaved);

// Each field is optional, so the Devices screen can change one without
// resending the other — and an older client cannot blank what it never showed.
await settings.onRequestPut(put('http://x/api/family/settings', { weekStart: 0 }, parentToken));
let [, tzKept] = await body(await settings.onRequestGet(get('http://x/api/family/settings', parentToken)));
check('changing only the week start leaves the zone alone', tzKept.timezone === 'America/Chicago', tzKept);
check('and the week start did change', tzKept.weekStart === 0, tzKept);

console.log('\n[§9.3] only a parent token touches the family clock');
let [tzChildGet] = await body(await settings.onRequestGet(get('http://x/api/family/settings', tabletToken)));
check('a child token cannot read the settings (403)', tzChildGet === 403, tzChildGet);
let [tzChildPut] = await body(await settings.onRequestPut(put('http://x/api/family/settings', { timezone: 'UTC' }, tabletToken)));
check('a child token cannot change them (403)', tzChildPut === 403, tzChildPut);

// §6.5: the family comes from the token, so there is no id here to guess at.
// The other family's parent changing their own zone must not touch ours.
await settings.onRequestPut(put('http://x/api/family/settings', { timezone: 'Europe/Berlin' }, otherParent));
let [, tzUnchanged] = await body(await settings.onRequestGet(get('http://x/api/family/settings', parentToken)));
check("another family's setting does not reach ours", tzUnchanged.timezone === 'America/Chicago', tzUnchanged);

console.log('\n[§6.2] the plan document rides down in the sync response');
let [, planned] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada', sessions: [], applied: [],
}, tabletToken)));
check('the tablet is handed the family timezone', planned.plan && planned.plan.timezone === 'America/Chicago', planned.plan);
check('and the week start', planned.plan.weekStart === 0, planned.plan);
// Revision 0 is below every revision /api/plan will ever allocate, so this
// placeholder can never overwrite a real plan under §7.1's highest-wins rule.
check('revision 0 until the Plan tab ships', planned.plan.revision === 0, planned.plan);
check('with no items yet', Array.isArray(planned.plan.items) && planned.plan.items.length === 0, planned.plan);

console.log('\n[§9.6] a family with no zone is handed no plan at all');
let [, unplanned] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: 'other-kid', childName: 'Ben', sessions: [], applied: [],
}, otherTabletToken)));
// Berlin was set on the other family two checks up, so clear it back out to
// test the genuinely-unset case rather than a leftover.
DB.prepare('UPDATE families SET timezone = NULL WHERE id = (SELECT family_id FROM devices WHERE id = ?)').bind('other-tablet').run();
let [, unplanned2] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: 'other-kid', childName: 'Ben', sessions: [], applied: [],
}, otherTabletToken)));
check('a zoned family gets a plan', !!unplanned.plan, unplanned.plan);
check('an unzoned one gets no plan field to write', unplanned2.plan === undefined, unplanned2);

console.log('\n[§9.3] local_date is stored as the client stamped it');
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada',
  sessions: [
    // 02:30 UTC on the 12th is still the 11th in Chicago. The whole point of
    // stamping on the client: this row must bucket to the day the child
    // actually worked, and nothing server-side can work that out (§9.2).
    { id: 7001, date: '2026-03-12T02:30:00.000Z', localDate: '2026-03-11', mode: 'practice', score: 8, total: 10, listName: 'Week 20', results: [] },
    { id: 7002, date: '2026-03-12T18:00:00.000Z', mode: 'practice', score: 9, total: 10, listName: 'Week 20', results: [] },
    { id: 7003, date: '2026-03-13T18:00:00.000Z', localDate: 'the 13th', mode: 'practice', score: 9, total: 10, listName: 'Week 20', results: [] },
  ],
  applied: [],
}, tabletToken));

const stamped = DB.prepare("SELECT session_id, local_date FROM sessions WHERE session_id IN ('7001','7002','7003') ORDER BY session_id");
const stampedRows = Object.fromEntries((await stamped.bind().all()).results.map((r) => [r.session_id, r.local_date]));
check('a stamped session keeps the day the child worked, not the UTC one', stampedRows['7001'] === '2026-03-11', stampedRows);
check('a client that stamps nothing leaves null, not today', stampedRows['7002'] === null, stampedRows);
check('a malformed stamp is stored as null rather than as itself', stampedRows['7003'] === null, stampedRows);

// The column, never a payload key of the same name — the phone reads this to
// decide which rows still need backfilling (§9.6).
let [, withDates] = await body(await sessionsMod.onRequestGet(get(`http://x/api/sessions?childId=${CHILD}&app=spelling`, parentToken)));
const s7001 = withDates.sessions.find((x) => x.id === '7001');
const s7002 = withDates.sessions.find((x) => x.id === '7002');
check('/api/sessions hands the stamp to the dashboard', s7001.localDate === '2026-03-11', s7001);
check('and hands back null for a row that needs backfilling', s7002.localDate === null, s7002);

console.log('\n[§12] plan_state records what a device holds, without acking it');
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada', sessions: [], applied: [], planRevision: 4,
}, tabletToken));
let planStateRow = await DB.prepare('SELECT revision FROM plan_state WHERE child_id = ? AND device_id = ?').bind(CHILD, 'tablet-1').first();
check('the reported revision is recorded', planStateRow && planStateRow.revision === 4, planStateRow);

await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada', sessions: [], applied: [], planRevision: 6,
}, tabletToken));
planStateRow = await DB.prepare('SELECT revision FROM plan_state WHERE child_id = ? AND device_id = ?').bind(CHILD, 'tablet-1').first();
check('and replaced on the next sync rather than appended', planStateRow.revision === 6, planStateRow);

// A Phase 1 client sends no planRevision at all, and must not be recorded as
// holding revision 0 — "never reported" and "holds the empty plan" are
// different rows in the delivery status the Plan tab shows.
await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada', sessions: [], applied: [],
}, tablet2Token));
const silent = await DB.prepare('SELECT revision FROM plan_state WHERE child_id = ? AND device_id = ?').bind(CHILD, 'tablet-2').first();
check('a client that reports nothing writes no row', silent === null, silent);

// ============ Phase 5 step 2: the plan document (assignment-spec §4, §12) ====
//
// The three things worth pinning here are the three that fail silently: a
// revision the client got to choose (concurrent edits lose an edit rather than
// conflict), a match that names a payload field (evaluable on one surface out
// of three, so the phone and the tablet disagree forever), and a score floor
// (a bar reading 0 of 3 for a child who did the work).
const plan = await mod('plan.js');

console.log('\n[§12.1] a child with no plan reads as revision 0');
let [pst, p0] = await body(await plan.onRequestGet(get(`http://x/api/plan?childId=${CHILD}`, parentToken)));
check('200 with an empty plan', pst === 200 && p0.revision === 0 && p0.items.length === 0, p0);
check('and carries the family clock', p0.timezone === 'America/Chicago' && p0.weekStart === 0, p0);

console.log('\n[§12.1] the server allocates the revision, never the client');
const WEEKLY = {
  id: 'wk-spell-practice',
  label: 'Spelling practice',
  match: { app: 'spelling', modes: ['practice'], scopeId: null },
  count: 3,
  period: 'week',
};
let [put1st, put1] = await body(await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD, items: [WEEKLY], revision: 99,
}, parentToken)));
check('the first revision is 1, not the 99 the client asked for', put1st === 200 && put1.revision === 1, put1);
// Above the revision-0 placeholder /api/sync hands a tablet with no plan, so a
// real plan can never lose to it under §7.1's highest-revision-wins rule.
check('which is above the empty-plan placeholder', put1.revision > 0, put1);

let [, put2] = await body(await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD, items: [{ ...WEEKLY, count: 4 }],
}, parentToken)));
check('the next write allocates the next revision', put2.revision === 2, put2);

let [, pRead] = await body(await plan.onRequestGet(get(`http://x/api/plan?childId=${CHILD}`, parentToken)));
check('GET reads back the newest revision', pRead.revision === 2 && pRead.items[0].count === 4, pRead);
check('and the item kept its id across the edit', pRead.items[0].id === 'wk-spell-practice', pRead.items);

console.log('\n[§6.3] revisions are append-only, with an effective date');
const revs = await DB.prepare(
  'SELECT revision, effective_from FROM plan_revisions WHERE child_id = ? ORDER BY revision'
).bind(CHILD).all();
check('both revisions are kept, not overwritten', revs.results.length === 2, revs.results);
check('each carries a local date', revs.results.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.effective_from)), revs.results);

// Supplied when the parent has an intent ("from Monday"), computed in the
// family's zone otherwise — the Worker has the IANA database even though D1
// does not (§9.2).
let [, dated] = await body(await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD, items: [WEEKLY], effectiveFrom: '2026-03-02',
}, parentToken)));
check('a supplied effectiveFrom is kept', dated.effectiveFrom === '2026-03-02', dated);
let [badFrom] = await body(await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD, items: [WEEKLY], effectiveFrom: 'Monday',
}, parentToken)));
// Silently substituting today would put a date the revision did not take
// effect on into the one column §6.3 exists to make trustworthy.
check('an unusable one is refused rather than replaced (400)', badFrom === 400, badFrom);

console.log('\n[§4.1] a match may only name envelope columns');
const reject = async (items, what) => {
  const [st, b2] = await body(await plan.onRequestPut(put('http://x/api/plan', { childId: CHILD, items }, parentToken)));
  check(what, st === 400, [st, b2]);
  return b2;
};
await reject([{ ...WEEKLY, match: { app: 'spelling', minutes: 20 } }], 'a payload field in a match is refused');
await reject([{ ...WEEKLY, match: { app: 'spelling', modes: ['practice'], word: 'rhythm' } }], 'so is one that also names a real column');
await reject([{ ...WEEKLY, match: { app: 'nope' } }], 'an unknown app is refused');
await reject([{ ...WEEKLY, match: { app: 'spelling', modes: [] } }], 'an empty modes array is refused, not read as "any"');

// §4.4 is a decision, not an omission, so it gets its own message rather than
// falling out of the unknown-key check above.
const floor = await reject(
  [{ ...WEEKLY, match: { app: 'spelling', modes: ['practice'], minScorePct: 80 } }],
  'a score floor is refused'
);
check('and says why, in the parent\'s terms', /effort/.test(floor.error || ''), floor);

// A mode is shape-checked and never checked against a registry: Spelling Star
// ships a new mode with every game, and a list here would mean a backend
// deploy before a parent could target one.
let [newModeSt] = await body(await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD,
  items: [{ ...WEEKLY, id: 'game', label: 'A game', match: { app: 'spelling', modes: ['not-shipped-yet'] } }],
}, parentToken)));
check('a mode the server has never heard of is accepted', newModeSt === 200, newModeSt);

console.log('\n[§4.3] periods');
await reject([{ ...WEEKLY, period: 'schoolweek' }], 'there is no Mon–Fri period');
await reject([{ ...WEEKLY, period: { from: '2026-05-10', to: '2026-05-03' } }], 'a period that ends before it starts is refused');
await reject([{ ...WEEKLY, period: { from: '2026-02-31', to: '2026-03-05' } }], 'a date that is not a day is refused');
await reject([{ ...WEEKLY, period: { from: '2026-5-1', to: '2026-05-05' } }], 'so is one that is not YYYY-MM-DD');
let [datedOk, datedBody] = await body(await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD,
  items: [{ ...WEEKLY, id: 'assign-1', label: 'Test on 5.12', period: { from: '2026-05-04', to: '2026-05-08' } }],
}, parentToken)));
check('a dated assignment is accepted before the editor composes one', datedOk === 200, datedBody);

console.log('\n[§4.2] identity is the id');
await reject([WEEKLY, { ...WEEKLY, label: 'A second one' }], 'two items sharing an id is an error, not a silent de-dup');
await reject([{ ...WEEKLY, id: '' }], 'an item with no id is refused');
await reject([{ ...WEEKLY, label: '   ' }], 'an item with no label is refused');
await reject([{ ...WEEKLY, count: 0 }], 'a count of zero is refused');
await reject([{ ...WEEKLY, count: 2.5 }], 'a fractional count is refused');
await reject('not-an-array', 'items must be an array');

console.log('\n[§4] unknown top-level keys are dropped, not stored');
await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD, items: [{ ...WEEKLY, colour: 'red', progress: 2 }],
}, parentToken));
let [, cleaned] = await body(await plan.onRequestGet(get(`http://x/api/plan?childId=${CHILD}`, parentToken)));
// Storing them would put a field in a document that rides down to every tablet
// and that nothing has agreed the meaning of. `progress` especially: §3 makes
// progress a thing that is recomputed, never carried.
check('the stored item holds only the fields §4 defines',
  Object.keys(cleaned.items[0]).sort().join(',') === 'count,id,label,match,period', cleaned.items[0]);

console.log('\n[§9] a plan needs the family clock to mean anything');
{
  // A second family, deliberately left with no timezone: /api/sync hands it no
  // plan document at all (§9.6), no session is ever stamped with a local date,
  // and every bar on the Plan tab would read 0 of 3 forever with nothing
  // visibly wrong. Refusing here is the only place that failure is visible.
  const [, zoneless] = await body(await family.onRequestPost(post('http://x/api/family', {
    signupSecret: 'test-secret', deviceId: 'zoneless-phone', label: 'No zone',
  })));
  const zonelessToken = zoneless.token;
  const zonelessTablet = await (async () => {
    const [, c] = await body(await pairingCode.onRequestPost(post('http://x/api/pairing-code', { role: 'child' }, zonelessToken)));
    const [, d] = await body(await pair.onRequestPost(post('http://x/api/pair', { code: c.code, deviceId: 'zoneless-tablet', role: 'child', label: 'Tablet' })));
    return d.token;
  })();
  check('the zoneless family has a tablet to plan for', !!zonelessTablet);
  await sync.onRequestPost(post('http://x/api/sync', {
    app: 'spelling', childId: 'zoneless-kid', childName: 'Bo', sessions: [], applied: [],
  }, zonelessTablet));

  let [noTz, noTzBody] = await body(await plan.onRequestPut(put('http://x/api/plan', {
    childId: 'zoneless-kid', items: [WEEKLY],
  }, zonelessToken)));
  check('a target is refused until the family has a timezone', noTz === 400, noTzBody);
  check('and the message names the setting', /timezone/i.test(noTzBody.error || ''), noTzBody);

  // A parent must always be able to take a target back off a child, whatever
  // the family's settings are.
  let [clearSt] = await body(await plan.onRequestPut(put('http://x/api/plan', {
    childId: 'zoneless-kid', items: [],
  }, zonelessToken)));
  check('but emptying a plan is always allowed', clearSt === 200, clearSt);
}

console.log('\n[§6.5] authorization is unchanged');
let [foreignGet] = await body(await plan.onRequestGet(get(`http://x/api/plan?childId=${CHILD}`, otherParent)));
check("another family's child matches nothing (404, not 403)", foreignGet === 404, foreignGet);
let [foreignPut] = await body(await plan.onRequestPut(put('http://x/api/plan', {
  childId: CHILD, items: [],
}, otherParent)));
check('and cannot be written either', foreignPut === 404, foreignPut);
let [childGet] = await body(await plan.onRequestGet(get(`http://x/api/plan?childId=${CHILD}`, tabletToken)));
// A tablet receives the plan inside /api/sync's response, which is a
// round-trip it already makes. It has no business here.
check('a child token is forbidden (403)', childGet === 403, childGet);
let [childPut] = await body(await plan.onRequestPut(put('http://x/api/plan', { childId: CHILD, items: [] }, tabletToken)));
check('and cannot write a plan for itself', childPut === 403, childPut);
let [anonGet] = await body(await plan.onRequestGet(get(`http://x/api/plan?childId=${CHILD}`)));
check('an unauthenticated caller gets 401', anonGet === 401, anonGet);

console.log('\n[§6.2] the plan reaches the tablet through the sync response');
await plan.onRequestPut(put('http://x/api/plan', { childId: CHILD, items: [WEEKLY] }, parentToken));
let [, delivered] = await body(await sync.onRequestPost(post('http://x/api/sync', {
  app: 'spelling', childId: CHILD, childName: 'Ada', sessions: [], applied: [],
}, tabletToken)));
check('the document carries the items', delivered.plan.items.length === 1, delivered.plan);
check('and a revision above the placeholder', delivered.plan.revision > 0, delivered.plan);
// §7.1 filters at read time, never at write time: the tablet stores the whole
// document verbatim, which is what lets a plan reach an app that is not itself
// synced.
check('a Spelling sync still receives the whole document, unfiltered',
  delivered.plan.items[0].match.app === 'spelling' && 'weekStart' in delivered.plan, delivered.plan);

console.log('\n[§6.2] a merged child is planned under every id it synced with');
{
  // The same child pushing under a second id (§6.2). The plan has to reach the
  // tablet whichever id it is currently using, and both ids must never hold
  // two different documents claiming the same revision — §7.1 resolves a tie
  // by NOT writing, so the loser would keep a stale plan forever.
  await sync.onRequestPost(post('http://x/api/sync', {
    app: 'math', childId: 'child-ada-2', childName: 'Ada', sessions: [], applied: [],
  }, tablet2Token));
  const [, merged] = await body(await plan.onRequestPut(put('http://x/api/plan', {
    childIds: [CHILD, 'child-ada-2'], items: [WEEKLY],
  }, parentToken)));
  const rows = await DB.prepare(
    'SELECT child_id, revision FROM plans WHERE child_id IN (?, ?)'
  ).bind(CHILD, 'child-ada-2').all();
  check('both ids hold a plan', rows.results.length === 2, rows.results);
  check('at the same revision', rows.results.every((r) => r.revision === merged.revision), rows.results);
  // Allocated over plan_revisions across every id, so a child merged after one
  // id was already planned cannot be handed a revision that id has used.
  check('which is above every revision either id had used', merged.revision > 2, merged.revision);
}


// =============== The migration runner (functions/api/_lib/migrations.js) ====
//
// This is the surface that replaces "run wrangler from a terminal", so the
// property that matters is convergence: whatever a database's history is, one
// press of Apply has to leave it on the current schema. There are exactly two
// histories in the wild — a live database built from an older schema.sql and
// migrated by hand, and a fresh one built from today's schema.sql, which
// already contains every migration's objects. Both start with an empty
// d1_migrations table while the objects already exist, which is precisely the
// case a naive runner gets wrong: it would try to CREATE TABLE over a live
// table and stop.
console.log('\n[migrations] a live database and a fresh one converge');
{
  const { applyPendingMigrations, migrationStatus } = await mod('_lib/migrations.js');

  const current = readFileSync(REPO + 'schema.sql', 'utf8');

  // The pre-Phase-5 database, built by undoing Phase 5 rather than by keeping
  // a copy of the old schema.sql around. It is the exact inverse of the
  // migration, in four statements, so it cannot rot as schema.sql moves on —
  // and if someone adds to Phase 5 without adding the undo here, the
  // convergence check below stops matching and says so.
  const UNDO_PHASE_5 = [
    'DROP TABLE plans',
    'DROP TABLE plan_revisions',
    'DROP TABLE plan_state',
    'DROP INDEX idx_sessions_local_date',
    'ALTER TABLE sessions DROP COLUMN local_date',
    'ALTER TABLE families DROP COLUMN timezone',
    'ALTER TABLE families DROP COLUMN week_start',
  ];

  // Comments are stripped from the fixture schema before it is created.
  // SQLite re-parses a table's stored DDL after DROP COLUMN, and the prose
  // inside these CREATE TABLE statements makes that reparse fail — a quirk of
  // the undo above, not of anything the migrations themselves do. Reusing the
  // runner's own splitter keeps the two in step.
  const { splitStatements } = await mod('_lib/migrations.js');

  function freshEnv(schemaSql, undo = []) {
    const mem = new DatabaseSync(':memory:');
    for (const statement of splitStatements(schemaSql)) mem.exec(statement);
    for (const statement of undo) mem.exec(statement);
    const shim = {
      prepare(sql) {
        const stmt = mem.prepare(sql);
        let args = [];
        const api = {
          bind(...a) { args = normalize(a); return api; },
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { results: stmt.all(...args) }; },
          async run() { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
        };
        return api;
      },
      async batch(stmts) { for (const st of stmts) await st.run(); },
      async exec(sql) { mem.exec(sql); return { count: 1 }; },
    };
    return { env: { DB: shim }, mem };
  }

  const shapeOf = (mem) => JSON.stringify({
    tables: mem.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name != 'd1_migrations' ORDER BY name").all().map((r) => r.name),
    families: mem.prepare('PRAGMA table_info(families)').all().map((r) => r.name).sort(),
    sessions: mem.prepare('PRAGMA table_info(sessions)').all().map((r) => r.name).sort(),
    indexes: mem.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
  });

  // 1. The live case: an older database that never had a migrations table.
  const live = freshEnv(current, UNDO_PHASE_5);
  check('the older fixture really is missing local_date',
    !live.mem.prepare('PRAGMA table_info(sessions)').all().some((r) => r.name === 'local_date'));

  let before = await migrationStatus(live.env);
  check('all three read as pending on a database with no tracking table', before.pending === 3, before);

  let result = await applyPendingMigrations(live.env);
  check('the run completes without stopping', !result.failed, result.failed);
  check('phase 5 did real work', result.ran.find((r) => r.name === 'schema-phase5.sql').changed > 0, result.ran);
  // Phases 3 and 4 are already in this database, applied by hand long ago.
  // They must be recognised as present rather than attempted and failed.
  check('phase 3 is recognised as already present',
    result.ran.find((r) => r.name === 'schema-phase3.sql').skipped > 0, result.ran);
  check('phase 4 too', result.ran.find((r) => r.name === 'schema-phase4.sql').skipped > 0, result.ran);

  // 2. The fresh case: today's schema.sql already contains everything.
  const brandNew = freshEnv(current);
  const freshResult = await applyPendingMigrations(brandNew.env);
  check('a fresh database also runs clean', !freshResult.failed, freshResult.failed);
  check('and finds every statement already present',
    freshResult.ran.every((r) => r.changed === 0), freshResult.ran);

  check('the two databases end on the same schema',
    shapeOf(live.mem) === shapeOf(brandNew.mem), { live: shapeOf(live.mem), fresh: shapeOf(brandNew.mem) });

  // 3. Pressing Apply twice is the thing a worried person will actually do.
  const again = await applyPendingMigrations(live.env);
  check('a second run does nothing at all', again.ran.length === 0, again.ran);
  const after = await migrationStatus(live.env);
  check('and everything reads as applied', after.pending === 0, after);
  check('the schema is unchanged by the second run', shapeOf(live.mem) === shapeOf(brandNew.mem));

  // 4. A genuinely broken migration must stop and say where — the whole point
  //    of matching "already exists" narrowly rather than swallowing errors.
  const broken = freshEnv(current);
  const { MIGRATIONS } = await mod('_lib/migrations.js');
  const saved = MIGRATIONS[MIGRATIONS.length - 1].sql;
  MIGRATIONS[MIGRATIONS.length - 1].sql = 'SELECT this_is_not_valid_sql FROM nowhere;';
  const failure = await applyPendingMigrations(broken.env);
  check('a broken statement stops the run', !!failure.failed, failure);
  check('and names the statement it stopped on',
    failure.failed.statement.includes('this_is_not_valid_sql'), failure.failed);
  const stuck = await migrationStatus(broken.env);
  check('a migration that failed is not recorded as applied',
    stuck.migrations.find((m) => m.name === failure.failed.name).applied === false, stuck);
  MIGRATIONS[MIGRATIONS.length - 1].sql = saved;
}

console.log('\n[migrations] only a parent may look or apply');
{
  const migrationsApi = await mod('migrations.js');
  let [mst, mbody] = await body(await migrationsApi.onRequestGet(get('http://x/api/migrations', parentToken)));
  check('a parent reads the status', mst === 200 && Array.isArray(mbody.migrations), mbody);
  let [mchild] = await body(await migrationsApi.onRequestGet(get('http://x/api/migrations', tabletToken)));
  check('a child token cannot read it (403)', mchild === 403, mchild);
  let [mchildPost] = await body(await migrationsApi.onRequestPost(post('http://x/api/migrations', {}, tabletToken)));
  check('nor apply (403)', mchildPost === 403, mchildPost);
  let [mAnon] = await body(await migrationsApi.onRequestGet(get('http://x/api/migrations')));
  check('and an unauthenticated caller gets 401', mAnon === 401, mAnon);
}

process.exit(report('api') ? 1 : 0);
