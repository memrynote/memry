-- data.db, migration 0006: the four calendar projections (spec 007 CL010).
--
-- Additive only: new tables, no existing table or row touched. Every table is a
-- cache of a parse of `sync_items.payload`, rebuildable by replaying the
-- calendar rows through their projectors, so an install that migrated before
-- the core subscribed to the calendar types loses nothing.
--
-- Time columns stay TEXT, verbatim from the payload: desktop's projection
-- compares `startAt` / `endAt` as ISO strings (`projection.ts`
-- `startAt < end AND coalesce(endAt, startAt) >= start`) and sorts by the
-- string, and the phone reproduces that byte for byte (spec 007 §5 F2).
-- `created_at` / `modified_at` are epoch milliseconds like every other
-- projection (§A.6).
--
-- No foreign keys: an external event may land before its source (desktop parks
-- it; here the projection's inner join simply hides it until the source row
-- arrives).
CREATE TABLE IF NOT EXISTS calendar_sources (
  id               TEXT PRIMARY KEY,
  provider         TEXT NOT NULL DEFAULT 'google',
  kind             TEXT NOT NULL DEFAULT 'calendar',
  account_id       TEXT,
  remote_id        TEXT NOT NULL,
  title            TEXT NOT NULL DEFAULT 'Untitled calendar',
  timezone         TEXT,
  color            TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  is_selected      INTEGER NOT NULL DEFAULT 0,
  is_memry_managed INTEGER NOT NULL DEFAULT 0,
  sync_cursor      TEXT,
  sync_status      TEXT NOT NULL DEFAULT 'idle',
  last_synced_at   TEXT,
  last_error       TEXT,
  metadata         TEXT,
  archived_at      TEXT,
  created_at       INTEGER,
  modified_at      INTEGER,
  clock            TEXT,
  synced_at        INTEGER,
  deleted_at       INTEGER
);

CREATE INDEX IF NOT EXISTS calendar_sources_provider ON calendar_sources (provider, kind);
CREATE INDEX IF NOT EXISTS calendar_sources_remote ON calendar_sources (remote_id);

CREATE TABLE IF NOT EXISTS calendar_events (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL DEFAULT 'Untitled event',
  description           TEXT,
  location              TEXT,
  start_at              TEXT NOT NULL,
  end_at                TEXT,
  timezone              TEXT NOT NULL DEFAULT 'UTC',
  is_all_day            INTEGER NOT NULL DEFAULT 0,
  recurrence_rule       TEXT,
  recurrence_exceptions TEXT,
  attendees             TEXT,
  reminders             TEXT,
  visibility            TEXT,
  color_id              TEXT,
  conference_data       TEXT,
  parent_event_id       TEXT,
  original_start_time   TEXT,
  target_calendar_id    TEXT,
  archived_at           TEXT,
  created_at            INTEGER,
  modified_at           INTEGER,
  clock                 TEXT,
  field_clocks          TEXT,
  synced_at             INTEGER,
  deleted_at            INTEGER
);

CREATE INDEX IF NOT EXISTS calendar_events_start ON calendar_events (start_at);

CREATE TABLE IF NOT EXISTS calendar_external_events (
  id                TEXT PRIMARY KEY,
  source_id         TEXT NOT NULL,
  remote_event_id   TEXT NOT NULL,
  remote_etag       TEXT,
  remote_updated_at TEXT,
  title             TEXT NOT NULL DEFAULT 'Untitled imported event',
  description       TEXT,
  location          TEXT,
  start_at          TEXT NOT NULL,
  end_at            TEXT,
  timezone          TEXT,
  is_all_day        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'confirmed',
  recurrence_rule   TEXT,
  attendees         TEXT,
  reminders         TEXT,
  visibility        TEXT,
  color_id          TEXT,
  conference_data   TEXT,
  raw_payload       TEXT,
  archived_at       TEXT,
  created_at        INTEGER,
  modified_at       INTEGER,
  clock             TEXT,
  synced_at         INTEGER,
  deleted_at        INTEGER
);

CREATE INDEX IF NOT EXISTS calendar_external_events_start ON calendar_external_events (start_at);
CREATE INDEX IF NOT EXISTS calendar_external_events_source ON calendar_external_events (source_id);

CREATE TABLE IF NOT EXISTS calendar_bindings (
  id                  TEXT PRIMARY KEY,
  source_type         TEXT NOT NULL DEFAULT 'event',
  source_id           TEXT NOT NULL,
  provider            TEXT NOT NULL DEFAULT 'google',
  remote_calendar_id  TEXT NOT NULL DEFAULT 'primary',
  remote_event_id     TEXT NOT NULL,
  ownership_mode      TEXT NOT NULL DEFAULT 'memry_managed',
  writeback_mode      TEXT NOT NULL DEFAULT 'broad',
  remote_version      TEXT,
  last_local_snapshot TEXT,
  archived_at         TEXT,
  created_at_raw      TEXT,
  created_at          INTEGER,
  modified_at         INTEGER,
  clock               TEXT,
  synced_at           INTEGER,
  deleted_at          INTEGER
);

CREATE INDEX IF NOT EXISTS calendar_bindings_source ON calendar_bindings (source_type, source_id);
CREATE INDEX IF NOT EXISTS calendar_bindings_remote ON calendar_bindings (provider, remote_calendar_id, remote_event_id);

-- Device-local mirrors (spec 007 §5 F1): events of a provider whose mirror
-- never syncs (a subscribed ICS feed, `mirrorScope: 'device'`). Each device
-- fetches the feed itself, as desktop does; these rows have no clock, never
-- reach `sync_items` and never enqueue. Keyed by the synced source row.
CREATE TABLE IF NOT EXISTS calendar_local_events (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  remote_event_id TEXT NOT NULL,
  title           TEXT NOT NULL,
  description     TEXT,
  location        TEXT,
  start_at        TEXT NOT NULL,
  end_at          TEXT,
  timezone        TEXT,
  is_all_day      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'confirmed',
  recurrence_rule TEXT,
  attendees       TEXT,
  reminders       TEXT,
  conference_data TEXT,
  raw_payload     TEXT,
  modified_at     INTEGER
);

CREATE INDEX IF NOT EXISTS calendar_local_events_start ON calendar_local_events (start_at);
CREATE INDEX IF NOT EXISTS calendar_local_events_source ON calendar_local_events (source_id);
