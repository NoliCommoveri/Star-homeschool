-- Parent Sync — Phase 3 migration (docs/parent-sync-spec.md §15).
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
ALTER TABLE sessions ADD COLUMN grade TEXT;
ALTER TABLE sessions ADD COLUMN scope_id TEXT;
