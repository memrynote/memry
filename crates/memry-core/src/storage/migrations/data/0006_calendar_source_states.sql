-- Spec 007 CL073: what this device last saw from each subscribed feed. Never
-- synced (desktop keeps the same facts per device: the fetch outcome it
-- writes without enqueueing, and the validators it holds in memory). A
-- validator is only valid for the events this device wrote from that
-- response, so it must not travel with the synced source row.
CREATE TABLE IF NOT EXISTS calendar_source_states (
  source_id       TEXT PRIMARY KEY,
  sync_status     TEXT NOT NULL DEFAULT 'idle',
  last_synced_at  TEXT,
  last_error      TEXT,
  etag            TEXT,
  last_modified   TEXT,
  refresh_ms      INTEGER,
  next_refresh_ms INTEGER
);
