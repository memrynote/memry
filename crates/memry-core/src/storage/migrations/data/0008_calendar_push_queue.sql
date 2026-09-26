-- Spec 007 CL070/CL075: the calendar items this device changed and has not
-- yet written to the provider that owns them. Desktop pushes on each local
-- change (`scheduleGoogleCalendarSourceSync`); this is the same trigger made
-- durable, fed by the outbox (only local changes enqueue there). Never
-- synced: the device that made a change is the one that pushes it, which is
-- what keeps two devices on one account from writing the same edit twice.
CREATE TABLE IF NOT EXISTS calendar_push_queue (
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  queued_at   INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  PRIMARY KEY (source_type, source_id)
);
