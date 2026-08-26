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
// lands with the Plan tab. The plan document block is the first triple to
// arrive, so the suite starts here and the evaluator joins it.
//
// Node only — no browser, no server, no database.
import { readFileSync } from 'node:fs';
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
// parent.html carries its own copy, in its own quote style, and must agree.
check('parent.html formats with en-CA too',
  /new Intl\.DateTimeFormat\('en-CA', \{ timeZone: tz \}\)/.test(readFileSync(REPO + 'parent.html', 'utf8')));

process.exit(report('shared-code') ? 1 : 0);

// Pulls the region out of one file: from the marker to the closing brace of
// the function `through` opens. Brace-counting rather than a regex, because
// the block contains nested braces in object literals and arrow bodies.
function extract(file, { from, through }) {
  const src = readFileSync(REPO + file, 'utf8');
  const start = src.indexOf(from);
  if (start === -1) return null;
  const lastFn = src.indexOf(through, start);
  if (lastFn === -1) return null;

  let depth = 0;
  let i = src.indexOf('{', lastFn);
  if (i === -1) return null;
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
