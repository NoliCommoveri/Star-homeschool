// The migration registry and runner — adapted from the pattern in the
// Scheduling App (management-app/worker/migrations.js and its /admin/migrations
// page), so a schema change is a button in the parent app rather than a
// wrangler command in a terminal.
//
// Two things differ from that original, both forced by this repo rather than
// chosen:
//
// 1. **The SQL is embedded here as strings, not imported from the .sql files.**
//    The Scheduling App is a single Worker and sets `[[rules]] type = "Text"`
//    in wrangler.toml to import its migrations/*.sql directly. This repo builds
//    through `wrangler pages functions build`, which does not apply that rule:
//    it emits the import *unresolved*, as a sibling .sql file beside index.js,
//    and whether the deploy-time bundler goes on to resolve it is not something
//    a test here can answer. A broken deploy is a bad way to find out. So the
//    SQL lives here as a string, and tests/shared-code.test.mjs compares each
//    one back against its schema-phaseN.sql file byte for byte — the file stays
//    the source of truth, and the copy cannot drift unnoticed.
//
// 2. **Applying is idempotent at the statement level.** The Scheduling App had
//    a migrations table from its first commit, so a name missing from
//    d1_migrations there means the migration has genuinely never run. This
//    database predates the runner: phases 3 and 4 were applied by hand from the
//    D1 console, and a *fresh* deployment gets all of it from schema.sql. In
//    both cases d1_migrations is empty while the objects already exist. Rather
//    than invent a baseline mechanism, each statement runs on its own and "this
//    table/column/index is already there" counts as success — so both starting
//    points converge on the same schema. The run reports, per migration, how
//    many statements did work and how many were already present, so the two are
//    distinguishable rather than both just reading as "applied".

export const MIGRATIONS = [
  {
    name: 'schema-phase3.sql',
    sql: `-- Parent Sync — Phase 3 migration (docs/parent-sync-spec.md §15).
-- Adds the parent -> child command queue and the child-state snapshot to a
-- database already created from schema.sql. Purely additive: no existing
-- table or column changes, so a tablet still running the Phase 1 client keeps
-- working untouched.
--
-- Apply with:
--   npx wrangler d1 execute star-homeschool --remote --file=./schema-phase3.sql
--
-- The --remote flag matters (§12 Step 4): without it you migrate a local dev
-- copy and the real database stays on the old schema, with every step
-- appearing to succeed.
--
-- schema.sql carries these same statements, so a *fresh* deployment needs
-- only that file. This one exists for the deployment that is already live.

CREATE TABLE commands (
  id          TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL REFERENCES families(id),
  child_id    TEXT NOT NULL REFERENCES children(id),
  app         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL REFERENCES devices(id),
  canceled    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_commands_child ON commands(child_id, app, created_at);

CREATE TABLE command_acks (
  command_id  TEXT NOT NULL REFERENCES commands(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  applied_at  INTEGER NOT NULL,
  PRIMARY KEY (command_id, device_id)
);

CREATE TABLE child_state (
  child_id    TEXT NOT NULL REFERENCES children(id),
  app         TEXT NOT NULL,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  updated_at  INTEGER NOT NULL,
  state       TEXT NOT NULL,
  PRIMARY KEY (child_id, app, device_id)
);

-- Grade columns for the multi-year "previous years" view, landing in this
-- migration deliberately rather than a later one.
--
-- They are columns and not payload fields because the view GROUPs BY them,
-- and a Worker cannot parse every session's payload to do that inside its CPU
-- budget. They are nullable and nothing writes them yet: the apps only start
-- stamping them once word lists carry a grade, which is separate work. NULL
-- therefore reads as "before grades", which is also the permanent value for
-- every session recorded up to now.
--
-- Why not a second migration when that work lands: both ship the same day, so
-- there is no window worth separating, and a missed second migration is not a
-- benign failure. Once the grade code deploys, sync.js's INSERT names these
-- columns; if they are absent every write throws and /api/sync 500s on every
-- tablet — invisibly, because §3 rule 1 keeps sync failures away from the
-- child. One migration is one thing to get right.
-- scope_name is denormalized on purpose. The name is already inside \`payload\`,
-- but the aggregate cannot read payload, and a label frozen at write time is
-- the more correct one anyway: renaming a list should not retroactively
-- relabel the year it was worked under.
ALTER TABLE sessions ADD COLUMN grade TEXT;
ALTER TABLE sessions ADD COLUMN scope_id TEXT;
ALTER TABLE sessions ADD COLUMN scope_name TEXT;
`,
  },
  {
    name: 'schema-phase4.sql',
    sql: `-- Parent Sync — Phase 4 migration (docs/parent-sync-spec.md §6.2, §7).
-- Adds parent-assigned child identity to pairing, to a database already
-- created from schema.sql (+ schema-phase3.sql if applied separately).
-- Purely additive: the new column is nullable, so an old pairing code row
-- (already redeemed, or a parent-role code, which never carries one) is
-- untouched.
--
-- Apply with:
--   npx wrangler d1 execute star-homeschool --remote --file=./schema-phase4.sql
--
-- The --remote flag matters (§12 Step 4): without it you migrate a local dev
-- copy and the real database stays on the old schema, with every step
-- appearing to succeed.
--
-- schema.sql carries this same column, so a *fresh* deployment needs only
-- that file. This one exists for the deployment that is already live.

ALTER TABLE pairing_codes ADD COLUMN child_id TEXT REFERENCES children(id);
`,
  },
  {
    name: 'schema-phase5.sql',
    sql: `-- Assignment and Targets — Phase 5 migration (docs/assignment-spec.md §12).
-- Adds the plan document, its revision history, per-device delivery state, the
-- family's timezone/week start, and the stamped local date on sessions, to a
-- database already created from schema.sql (+ the phase 3/4 migrations if they
-- were applied separately). Purely additive: every new column is nullable or
-- defaulted, so a tablet still running an older client keeps working.
--
-- Apply with:
--   npx wrangler d1 execute star-homeschool --remote --file=./schema-phase5.sql
--
-- The --remote flag matters (parent-sync-spec.md §12 Step 4): without it you
-- migrate a local dev copy and the real database stays on the old schema, with
-- every step appearing to succeed.
--
-- schema.sql carries these same statements, so a *fresh* deployment needs only
-- that file. This one exists for the deployment that is already live.
--
-- Why the three plan tables land here, in the timezone step, when nothing
-- writes them until the Plan tab ships (assignment-spec.md §17 step 2): the
-- same reason the grade columns landed in schema-phase3.sql ahead of the code
-- that stamps them. Both ship within days of each other, so there is no window
-- worth separating, and a missed second migration is not a benign failure —
-- once plan.js deploys, its INSERT names these tables, and if they are absent
-- every parent write 500s. One migration is one thing to get right.

-- The current plan for one child, as a document. Parent-owned state (§3): an
-- instruction, not a record, which is why it may live server-side without
-- inverting the one-way rule.
CREATE TABLE plans (
  child_id    TEXT PRIMARY KEY REFERENCES children(id),
  family_id   TEXT NOT NULL REFERENCES families(id),
  revision    INTEGER NOT NULL,
  items       TEXT NOT NULL,        -- JSON, §4
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL REFERENCES devices(id)
);

-- Every version, so a past period evaluates against the plan that was in force
-- (§6.3). Append-only, like sessions and commands: without this, editing the
-- plan on Thursday silently rewrites what Monday's targets were.
CREATE TABLE plan_revisions (
  child_id       TEXT NOT NULL REFERENCES children(id),
  revision       INTEGER NOT NULL,
  items          TEXT NOT NULL,
  effective_from TEXT NOT NULL,     -- local date, YYYY-MM-DD (§9)
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL REFERENCES devices(id),
  PRIMARY KEY (child_id, revision)
);

-- Which revision each device holds, for the delivery status in §11. Written by
-- /api/sync from the client's reported planRevision; not an ack, because a
-- plan needs none (§6.1) — it is idempotent desired-state, so a device that
-- misses a delivery self-heals on its next sync.
CREATE TABLE plan_state (
  child_id    TEXT NOT NULL REFERENCES children(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  revision    INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (child_id, device_id)
);

-- §9.3, §9.4. The family timezone is the *policy* — one family, one school
-- day — and is nullable because a family created before this ships has none
-- until a parent phone sets one. week_start is 0 for Sunday, matching
-- data.schedule's existing 0 = Sunday indexing.
ALTER TABLE families ADD COLUMN timezone   TEXT;
ALTER TABLE families ADD COLUMN week_start INTEGER NOT NULL DEFAULT 0;

-- §9.3. The *record*: YYYY-MM-DD, computed by the client at write time in the
-- family timezone. It is a column and not a derivation because SQLite has no
-- IANA timezone database (§9.2) — date(x,'localtime') resolves against the
-- host process's zone, which on Workers is UTC, so GROUP BY local day is not
-- merely awkward server-side, it is impossible.
--
-- Nullable and additive, exactly like the §16 grade columns: an old client
-- that never stamps it keeps working, and NULL reads as "before plans", which
-- is the permanent and correct value for every session recorded up to now.
ALTER TABLE sessions ADD COLUMN local_date TEXT;
CREATE INDEX idx_sessions_local_date ON sessions(child_id, app, local_date);
`,
  },
];

// Statements, one per entry, comments stripped. Deliberately simple: these are
// our own migration files, not arbitrary input, and none contains a semicolon
// inside a string literal or a trigger body. If one ever does, this is the
// thing to fix first.
export function splitStatements(sql) {
  return sql
    .split('\n')
    .map((line) => { const i = line.indexOf('--'); return i === -1 ? line : line.slice(0, i); })
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

// SQLite's own words for "you already have this", matched narrowly and only
// for the statement kinds that can legitimately be re-run: a table that exists,
// an index that exists, a column already added.
//
// The narrowness is the point. Swallowing every error mentioning "exists" would
// make a genuinely broken migration look like a successful one, which is the
// exact failure this surface exists to prevent.
const ALREADY_PRESENT = [
  /table\s+\S+\s+already exists/i,
  /index\s+\S+\s+already exists/i,
  /duplicate column name/i,
];

function isAlreadyPresent(error) {
  const message = String((error && error.message) || error || '');
  return ALREADY_PRESENT.some((re) => re.test(message));
}

// One physical line: env.DB.exec() splits on newlines rather than on statements.
export async function ensureMigrationsTable(env) {
  await env.DB.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at INTEGER NOT NULL)');
}

async function appliedNames(env) {
  const { results } = await env.DB.prepare('SELECT name FROM d1_migrations').all();
  return new Set((results || []).map((r) => r.name));
}

export async function migrationStatus(env) {
  await ensureMigrationsTable(env);
  const applied = await appliedNames(env);
  const migrations = MIGRATIONS.map((m) => ({ name: m.name, applied: applied.has(m.name) }));
  return { migrations, pending: migrations.filter((m) => !m.applied).length };
}

// Runs every migration not yet recorded, statement by statement.
//
// Not one batch per migration, which is what the Scheduling App does: a batch is
// a transaction, and a transaction cannot survive the "already present"
// statements this database is full of — the first one would roll back the whole
// migration, including the statements that did real work. Per statement means a
// genuine failure part-way leaves earlier statements applied, which is why the
// result names the statement it stopped on instead of only throwing.
export async function applyPendingMigrations(env) {
  await ensureMigrationsTable(env);
  const applied = await appliedNames(env);
  const pending = MIGRATIONS.filter((m) => !applied.has(m.name));

  const ran = [];
  for (const migration of pending) {
    let changed = 0;
    let skipped = 0;
    for (const statement of splitStatements(migration.sql)) {
      try {
        await env.DB.prepare(statement).run();
        changed += 1;
      } catch (err) {
        if (isAlreadyPresent(err)) { skipped += 1; continue; }
        return {
          ran,
          failed: {
            name: migration.name,
            statement: statement.slice(0, 200),
            error: String((err && err.message) || err),
          },
        };
      }
    }
    // Recorded only once every statement in it came back clean, so a migration
    // that stopped half way is retried rather than marked done.
    await env.DB.prepare('INSERT OR REPLACE INTO d1_migrations (name, applied_at) VALUES (?, ?)')
      .bind(migration.name, Date.now()).run();
    ran.push({ name: migration.name, changed, skipped });
  }
  return { ran };
}
