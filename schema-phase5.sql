-- Assignment and Targets — Phase 5 migration (docs/assignment-spec.md §12).
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
