-- NULL until the AI Search content index confirms the trace. Existing rows start
-- NULL, so the scheduled sweep backfills them.
ALTER TABLE events ADD COLUMN indexed_at TEXT;
CREATE INDEX events_unindexed ON events (occurred_at DESC, id DESC) WHERE indexed_at IS NULL;
