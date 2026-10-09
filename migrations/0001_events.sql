CREATE TABLE events (
  owner TEXT NOT NULL,
  id TEXT NOT NULL,
  source TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  summary TEXT NOT NULL,
  raw TEXT NOT NULL,
  PRIMARY KEY (owner, id)
);
CREATE INDEX events_session ON events (owner, session_id, occurred_at DESC);
CREATE INDEX events_recent ON events (owner, occurred_at DESC);
