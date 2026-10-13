-- Uploaders are per-machine credentials for transcript ingest. Only SHA-256 digests
-- of the one-time claim code and of the bearer token are stored. `claim_hash` is
-- cleared when the claim is used or the uploader is revoked.
CREATE TABLE uploaders (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  label TEXT NOT NULL,
  harness TEXT NOT NULL,
  created_at TEXT NOT NULL,
  claim_hash TEXT UNIQUE,
  claim_expires_at TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  claimed_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX uploaders_owner ON uploaders (owner, created_at DESC);

-- Provenance of uploaded sessions: which harness and version, uploader, and host.
-- `entries` counts newly stored entries and is best effort.
CREATE TABLE sessions (
  owner TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  harness_version TEXT,
  uploader_version TEXT NOT NULL,
  uploader_id TEXT NOT NULL,
  host TEXT,
  platform TEXT,
  cwd TEXT,
  entries INTEGER NOT NULL DEFAULT 0,
  first_uploaded_at TEXT NOT NULL,
  last_uploaded_at TEXT NOT NULL,
  PRIMARY KEY (owner, source, session_id)
);
CREATE INDEX sessions_recent ON sessions (owner, last_uploaded_at DESC);
