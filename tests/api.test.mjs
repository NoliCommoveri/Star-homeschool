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

process.exit(report('api') ? 1 : 0);
