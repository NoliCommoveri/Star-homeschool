# Tests

```
npm install
npx playwright install chromium     # only for the browser suites
npm test
```

`npm test` runs all four suites and exits non-zero if any fail. If Chromium
isn't available the three browser suites are **skipped, not failed**, so the
API suite still runs anywhere Node does.

Individual suites are plain scripts — `node tests/api.test.mjs`.

## What each one covers

| Suite | Needs | Covers |
|---|---|---|
| `api.test.mjs` | Node only | Every `functions/api/*` handler against a real SQLite database |
| `child-apps.test.mjs` | Chromium | Spelling Star and Math Star in a browser |
| `parent-dashboard.test.mjs` | Chromium | `parent.html` against a mocked API |
| `setup-wizard.test.mjs` | Chromium | First launch, and opening a profile saved by an older version |

**`api.test.mjs` has no dependencies at all.** It loads `schema.sql` into an
in-memory `node:sqlite` database, wraps it in a D1-shaped shim, and imports
the real handler modules — so it exercises the actual SQL and the actual
authorization checks, not a re-implementation of them. That is the suite to
keep working; it is also the one that catches a broken migration.

The browser suites intercept `/api/*` and answer from a fixture, so no server
or database is involved. Each starts its own static file server on a random
port (`harness.mjs`), because the apps register a service worker and that
needs an http origin rather than `file://`.

## Why these tests exist

Not for coverage. Each one pins down something that breaks *silently* — where
the app keeps working and quietly does the wrong thing:

- **A sync failure must be invisible to the child** (spec §3 rules 1 and 2).
  There are checks that with sync off the apps make no network calls at all,
  and that with the server unreachable nothing about the child's screen or
  saved profile changes. A regression here looks like nothing.
- **Commands must not land mid-session** (§15.5). An assignment arriving
  during a Test would change the list under the child's fingers.
- **The authorization boundary** (§6.5) — every handler resolving `family_id`
  from the token. Tested from four angles, because a leak here is invisible
  until it isn't.
- **Cross-grade name collisions** (§16.5). Two lists can share a name in
  different years. If matching falls back to the name, last year's "Unit 1"
  satisfies this year's pretest gate — and an assigned list can overwrite the
  previous year's words outright. That last one is data loss.
- **Old profiles keep opening.** Every app's `load()` migrates tolerantly;
  there are checks that a pre-grade profile opens, is not silently graded, and
  is not rewritten just by being read.

## Adding to them

Follow what's there: `createChecker()` gives you `check(label, condition,
detail)` and a `report()`. `detail` is printed only on failure, so pass the
value you'd want to see.

Write the label as the claim being made — `"last year's Unit 1 does not
satisfy this year's pretest gate"` — so a failure reads as a sentence about
the product rather than about the test.
