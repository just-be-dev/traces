-- LLM usage, one row per model response, projected from transcript entries in
-- `events` by the scheduled sweep. Derived and rebuildable: deleting these rows and
-- resetting the cursor to 0 recomputes them. `key` identifies the response across
-- duplicate entries (see src/usage.ts), so the first row wins.
CREATE TABLE usage_records (
  owner TEXT NOT NULL,
  key TEXT NOT NULL,
  event_id TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  PRIMARY KEY (owner, key)
);
CREATE INDEX usage_records_recent ON usage_records (owner, occurred_at);
CREATE INDEX usage_records_session ON usage_records (owner, source, session_id, occurred_at DESC);

-- The sweep's position in `events`, by rowid. Starts at 0, so existing traces are
-- backfilled.
CREATE TABLE usage_sweep (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL
);
INSERT INTO usage_sweep (id, cursor) VALUES (1, 0);

-- The homepage's precomputed stats per owner (`StatsSnapshot` in src/usage.ts), so
-- public requests read one row instead of aggregating. Derived; safe to delete.
CREATE TABLE usage_snapshots (
  owner TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  snapshot TEXT NOT NULL
);
