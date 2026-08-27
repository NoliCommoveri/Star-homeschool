// Functions that exist in more than one copy, checked for drift.
//
// docs/parent-sync-spec.md §3 rule 5 allows a small number of functions to be
// hand-duplicated across the app files rather than factored into a module: the
// apps are standalone HTML with no build step, so a shared module would mean a
// build step, and that trade has been taken deliberately. What it costs is
// that a fix applied to one copy and not the others is invisible. Nothing
// throws, no screen breaks — the apps simply start disagreeing.
//
// assignment-spec.md §10.3 asks for exactly this test, for the evaluator that
// landed with the Plan tab and now has a second copy in today.html.
//
// Node only — no browser, no server, no database.
import { readdirSync, readFileSync } from 'node:fs';
import { createChecker, REPO } from './harness.mjs';

const { check, section, report } = createChecker();

const SYNCED_APPS = ['spelling-star-v6_3.html', 'math-star-v6_1.html', 'reading-star-v1.html'];

// Each entry is one run of source that must be identical everywhere it appears.
// `from` and `through` are matched literally; the region runs from `from` to
// the end of the function `through` opens.
const SHARED = [
  {
    what: 'the plan document block (assignment-spec §7, §9)',
    files: SYNCED_APPS,
    from: '// ---------- The plan document (docs/assignment-spec.md §7, §9) ----------',
    through: 'function withLocalDates(sessions) {',
  },
  // assignment-spec.md §10.3. Both sides count the same sessions with the same
  // rules and arrive at the same number on their own — that is the whole reason
  // no client ever reports "I have done 2 of 3" (§3). It only holds while the
  // rules are the same rules. The three synced apps join this list at §17 step 4.
  {
    what: 'the mode registry and evaluator (assignment-spec §5, §10)',
    files: ['parent.html', 'today.html'],
    from: '// ---------- The mode registry and evaluator (docs/assignment-spec.md §5, §10) ----------',
    through: 'function evaluateItem(item, sessions, { timezone, weekStart, now }) {',
  },
];

for (const region of SHARED) {
  section(region.what);
  const copies = region.files.map((file) => ({ file, text: extract(file, region) }));

  for (const copy of copies) {
    check(`${copy.file} has it at all`, copy.text !== null);
  }
  if (copies.some((c) => c.text === null)) continue;

  const [first, ...rest] = copies;
  for (const other of rest) {
    check(
      `${other.file} is byte-identical to ${first.file}`,
      other.text === first.text,
      other.text === first.text ? undefined : firstDifference(first, other)
    );
  }
}

// A stamp is only useful if every copy agrees on which day an instant falls
// on, so pin the one thing all three compute: the locale that yields
// YYYY-MM-DD. 'en-US' here would silently produce "3/11/2026", which is not a
// date SQL can compare as a string (§9.4) and not one any bucket would match.
section('localDate formats as YYYY-MM-DD');
for (const file of SYNCED_APPS) {
  const src = readFileSync(REPO + file, 'utf8');
  check(`${file} formats with en-CA`, /new Intl\.DateTimeFormat\("en-CA", \{ timeZone: tz \}\)/.test(src));
}
// parent.html and today.html carry their own copies, in their own quote style,
// and must agree. today.html's matters as much as any: it is the surface that
// falls back to the DEVICE's zone when no plan has arrived (§9.5), so it is the
// one most likely to be formatting a date nothing else in the system computed.
for (const file of ['parent.html', 'today.html']) {
  check(`${file} formats with en-CA too`,
    /new Intl\.DateTimeFormat\('en-CA', \{ timeZone: tz \}\)/.test(readFileSync(REPO + file, 'utf8')));
}

// The migration runner cannot import the .sql files — `wrangler pages
// functions build` does not resolve a Text import (see the note at the top of
// functions/api/_lib/migrations.js) — so each one is embedded in that module
// as a string. Which makes it a second copy of a file that is still the source
// of truth, and a second copy is a thing that drifts.
//
// The failure is quiet in the worst way: someone edits schema-phase5.sql,
// deploys, presses Apply, and the runner applies the *old* SQL while the file
// in the repo says otherwise. Nothing errors. The database is simply not what
// the repo claims it is.
section('the embedded migrations match their .sql files');
{
  const { MIGRATIONS } = await import(REPO + 'functions/api/_lib/migrations.js');
  for (const migration of MIGRATIONS) {
    let onDisk = null;
    try { onDisk = readFileSync(REPO + migration.name, 'utf8'); } catch { /* missing */ }
    check(`${migration.name} exists on disk`, onDisk !== null);
    if (onDisk === null) continue;
    check(`${migration.name} is embedded byte for byte`, migration.sql === onDisk,
      migration.sql === onDisk ? undefined : firstDifference(
        { file: migration.name + ' (file)', text: onDisk },
        { file: migration.name + ' (embedded)', text: migration.sql }
      ));
  }

  // Every migration file in the repo has to be registered, or it silently
  // never runs — the runner only knows what is in this list.
  const registered = new Set(MIGRATIONS.map((m) => m.name));
  const onDisk = readdirSync(REPO).filter((f) => /^schema-phase\d+\.sql$/.test(f));
  for (const file of onDisk) {
    check(`${file} is registered in MIGRATIONS`, registered.has(file));
  }
  check('migrations are registered in order',
    JSON.stringify([...registered]) === JSON.stringify([...registered].sort()), [...registered]);
}

// dist/worker/index.js is a COMMITTED BUILD ARTIFACT. Cloudflare runs no build
// step for this repo (parent-sync-spec.md §12 Step 7): wrangler.toml's `main`
// points straight at that file, so whatever is committed is what runs. It has
// to be regenerated with `npm run build:worker` after every change under
// functions/ and committed alongside it.
//
// Forgetting is silent and total. The handler exists in the repo, its tests
// pass, the deploy succeeds — and the endpoint 404s in production, because the
// bundle Cloudflare actually runs predates it. This is not hypothetical: the
// commit that added functions/api/family/settings.js shipped without a rebuild
// and would have done exactly that.
//
// A name check, not a content check: a real staleness test would rebuild and
// diff, which needs wrangler and a network. This catches the case that
// actually happens — a new route that never made it in.
section('the committed worker bundle covers every route');
{
  let bundle = null;
  try { bundle = readFileSync(REPO + 'dist/worker/index.js', 'utf8'); } catch { /* missing */ }
  check('dist/worker/index.js is committed', bundle !== null);

  if (bundle !== null) {
    for (const route of routeFiles(REPO + 'functions')) {
      // The bundler labels each chunk with its source path, so the route's own
      // path appearing in the bundle means that module was compiled in.
      check(`${route} is in the bundle`, bundle.includes(route),
        'run `npm run build:worker` and commit dist/worker/index.js');
    }
  }
}

process.exit(report('shared-code') ? 1 : 0);

// Every routable handler under functions/, as paths relative to it. Files and
// directories starting with an underscore are library code, never routed.
function routeFiles(root, prefix = '') {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...routeFiles(`${root}/${entry.name}`, rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// Pulls the region out of one file: from the marker to the closing brace of
// the function `through` opens. Brace-counting rather than a regex, because
// the block contains nested braces in object literals and arrow bodies.
function extract(file, { from, through }) {
  const src = readFileSync(REPO + file, 'utf8');
  const start = src.indexOf(from);
  if (start === -1) return null;
  const lastFn = src.indexOf(through, start);
  if (lastFn === -1) return null;

  // Counting starts at the brace the `through` marker itself ends with, not at
  // the next brace in the file. evaluateItem's parameter list destructures —
  // `{ timezone, weekStart, now }` — so searching forward for '{' would find
  // that one and stop the region at its closing brace, three lines in.
  let depth = 0;
  let i = lastFn + through.length - 1;
  if (src[i] !== '{') return null;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// Report the line that diverged rather than dumping both copies — the whole
// region is ~70 lines and a diff of it is unreadable in a test log.
function firstDifference(a, b) {
  const aLines = a.text.split('\n');
  const bLines = b.text.split('\n');
  for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
    if (aLines[i] !== bLines[i]) {
      return { line: i + 1, [a.file]: aLines[i] ?? '(ends)', [b.file]: bLines[i] ?? '(ends)' };
    }
  }
  return { note: 'identical line-by-line but not byte-identical (line endings?)' };
}
