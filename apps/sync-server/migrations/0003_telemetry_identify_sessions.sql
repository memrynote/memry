-- Once-per-session guard for PostHog $identify.
--
-- $identify is idempotent in PostHog but bills as an identified event, and the
-- desktop flushes a telemetry batch roughly every 30s. Without a guard an
-- 8-hour authenticated session emits ~960 $identify events instead of 1.
--
-- The Worker has no KV binding (D1 + R2 + two Durable Objects), so this is a D1
-- table, following the same convention as `rate_limits`: a single TEXT primary
-- key, an integer unix timestamp, and a scheduled sweep (see
-- cleanupStaleIdentifySessions).
--
-- Additive: new table only, no existing table or column is touched.
CREATE TABLE IF NOT EXISTS telemetry_identify_sessions (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telemetry_identify_sessions_created_at
  ON telemetry_identify_sessions(created_at);
