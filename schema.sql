-- Parent Sync backend schema (docs/parent-sync-spec.md §6).
-- Apply with: npx wrangler d1 execute star-homeschool --remote --file=./schema.sql

PRAGMA foreign_keys = ON;

CREATE TABLE families (
  id          TEXT PRIMARY KEY,      -- 128-bit random hex; never derived (§6.5)
  created_at  INTEGER NOT NULL,
  -- assignment-spec.md §9.3, §9.4. One family, one school day: the IANA zone
  -- every local date is stamped in, and which weekday a week bucket starts on
  -- (0 = Sunday, matching data.schedule's indexing). Nullable because a family
  -- created before Phase 5 has no zone until a parent phone sets one.
  timezone    TEXT,
  week_start  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE devices (
  id          TEXT PRIMARY KEY,      -- client-generated UUID; stable across re-pairing
  family_id   TEXT NOT NULL REFERENCES families(id),
  token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256; raw token never stored. Rotates; id does not.
  role        TEXT NOT NULL,         -- 'child' | 'parent'
  label       TEXT,                  -- "Ada's tablet"
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER,
  revoked     INTEGER NOT NULL DEFAULT 0,
  rl_window   INTEGER NOT NULL DEFAULT 0,  -- rate-limit window start, epoch (§6.6)
  rl_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_devices_token ON devices(token_hash);

CREATE TABLE children (
  id          TEXT PRIMARY KEY,      -- 128-bit random hex; NOT derived from family_id
  family_id   TEXT NOT NULL REFERENCES families(id),
  name        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_children_family ON children(family_id);

CREATE TABLE pairing_codes (
  code_hash   TEXT PRIMARY KEY,      -- SHA-256 of the 6-char code
  family_id   TEXT NOT NULL REFERENCES families(id),
  role        TEXT NOT NULL,
  child_id    TEXT REFERENCES children(id), -- role='child' only (§6.2 parent-assigned id)
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                -- non-null once redeemed; single use
);

CREATE TABLE sessions (
  child_id    TEXT NOT NULL REFERENCES children(id),
  app         TEXT NOT NULL,         -- 'spelling' | 'math' | 'reading'
  device_id   TEXT NOT NULL REFERENCES devices(id),
  session_id  TEXT NOT NULL,         -- the client's Date.now() id, as text
  occurred_at INTEGER NOT NULL,      -- from the client
  received_at INTEGER NOT NULL,      -- from the server; clock-skew insurance
  mode        TEXT NOT NULL,
  score       INTEGER,
  total       INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL,         -- JSON (or ciphertext — see §10)
  -- Columns rather than payload fields because the multi-year view GROUPs BY
  -- them, and a Worker cannot parse every payload to do that inside its CPU
  -- budget. Both stay NULL until the apps stamp them; NULL reads as
  -- "before grades".
  grade       TEXT,                  -- school grade when the session happened
  scope_id    TEXT,                  -- list id (spelling) / focus area id (math) / book id (reading)
  scope_name  TEXT,                  -- its label, frozen at write time
  -- The calendar day this sitting belongs to, YYYY-MM-DD in the family
  -- timezone, stamped by the client (assignment-spec.md §9.3). Same reasoning
  -- as the columns above, only stronger: a Worker cannot derive a local day at
  -- all, because SQLite has no IANA timezone database (§9.2).
  local_date  TEXT,
  PRIMARY KEY (child_id, app, device_id, session_id)
);
CREATE INDEX idx_sessions_child_app ON sessions(child_id, app, occurred_at);
CREATE INDEX idx_sessions_local_date ON sessions(child_id, app, local_date);

-- ---------------------------------------------------------------------------
-- Phase 3 (§15): parent -> child. Also in schema-phase3.sql as a standalone
-- migration, for a database that was already created from the tables above.
-- ---------------------------------------------------------------------------

-- The parent -> child queue (§15.2). Append-only, like sessions: a command is
-- never edited, only canceled, and delivery is recorded in command_acks.
CREATE TABLE commands (
  id          TEXT PRIMARY KEY,      -- 128-bit random hex
  family_id   TEXT NOT NULL REFERENCES families(id),
  child_id    TEXT NOT NULL REFERENCES children(id),
  app         TEXT NOT NULL,         -- 'spelling' | 'math' | 'reading'
  kind        TEXT NOT NULL,         -- §15.3's fixed set
  payload     TEXT NOT NULL,         -- JSON
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL REFERENCES devices(id),
  canceled    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_commands_child ON commands(child_id, app, created_at);

-- Delivery is per device, not per command (§15.2): two tablets sharing one
-- childId must each apply an assignment, and the parent wants to see which
-- have. A device pulls what it has not yet acked; nothing is ever "consumed."
CREATE TABLE command_acks (
  command_id  TEXT NOT NULL REFERENCES commands(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  applied_at  INTEGER NOT NULL,
  PRIMARY KEY (command_id, device_id)
);

-- What the tablet actually has right now (§15.4) — word lists, focus areas,
-- and the category catalog — so the parent composes against reality instead
-- of against a copy of the child apps' data model.
CREATE TABLE child_state (
  child_id    TEXT NOT NULL REFERENCES children(id),
  app         TEXT NOT NULL,
  device_id   TEXT NOT NULL REFERENCES devices(id),
  updated_at  INTEGER NOT NULL,
  state       TEXT NOT NULL,         -- JSON
  PRIMARY KEY (child_id, app, device_id)
);

-- ---------------------------------------------------------------------------
-- Phase 5 (docs/assignment-spec.md §12): the plan document. Also in
-- schema-phase5.sql as a standalone migration, for a database that was already
-- created from the tables above. The timezone and local_date columns folded
-- into families and sessions above belong to this phase too.
-- ---------------------------------------------------------------------------

-- The current plan for one child, as a document. Parent-owned state: an
-- instruction, not a record, which is why it may live server-side without
-- inverting the one-way rule (§3).
CREATE TABLE plans (
  child_id    TEXT PRIMARY KEY REFERENCES children(id),
  family_id   TEXT NOT NULL REFERENCES families(id),
  revision    INTEGER NOT NULL,
  items       TEXT NOT NULL,        -- JSON, §4
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL REFERENCES devices(id)
);

-- Every version, so a past period evaluates against the plan that was in force
-- (§6.3). Progress is recomputed from history rather than stored, so without
-- this, editing the plan on Thursday would silently rewrite what Monday's
-- targets were.
CREATE TABLE plan_revisions (
  child_id       TEXT NOT NULL REFERENCES children(id),
  revision       INTEGER NOT NULL,
  items          TEXT NOT NULL,
  effective_from TEXT NOT NULL,     -- local date, YYYY-MM-DD (§9)
  created_at     INTEGER NOT NULL,
  created_by     TEXT NOT NULL REFERENCES devices(id),
  PRIMARY KEY (child_id, revision)
);

-- Which revision each device holds, for the delivery status in §11. Not an
-- ack: a plan is idempotent desired-state (§6.1), so a device that misses a
-- delivery self-heals on its next sync with no bookkeeping.
CREATE TABLE plan_state (
  child_id    TEXT NOT NULL REFERENCES children(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  revision    INTEGER NOT NULL,
  seen_at     INTEGER NOT NULL,
  PRIMARY KEY (child_id, device_id)
);
