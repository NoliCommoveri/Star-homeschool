PRAGMA foreign_keys = ON;

CREATE TABLE families (
  id          TEXT PRIMARY KEY,      -- 128-bit random hex; never derived (§6.5)
  created_at  INTEGER NOT NULL
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
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER                -- non-null once redeemed; single use
);

CREATE TABLE sessions (
  child_id    TEXT NOT NULL REFERENCES children(id),
  app         TEXT NOT NULL,         -- 'spelling' | 'math'
  device_id   TEXT NOT NULL REFERENCES devices(id),
  session_id  TEXT NOT NULL,         -- the client's Date.now() id, as text
  occurred_at INTEGER NOT NULL,      -- from the client
  received_at INTEGER NOT NULL,      -- from the server; clock-skew insurance
  mode        TEXT NOT NULL,
  score       INTEGER,
  total       INTEGER,
  deleted     INTEGER NOT NULL DEFAULT 0,
  payload     TEXT NOT NULL,         -- JSON (or ciphertext — see §10)
  PRIMARY KEY (child_id, app, device_id, session_id)
);
CREATE INDEX idx_sessions_child_app ON sessions(child_id, app, occurred_at);
