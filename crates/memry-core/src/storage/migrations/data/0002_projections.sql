-- data.db, migration 0002: the typed projections.
--
-- data-model §A.4. Everything here is rebuildable from `sync_items.payload` by
-- replaying every row through the per-type projector; dropping and rebuilding
-- these tables is a supported recovery. Column names are the payload's field
-- names in snake case, so a reader can move between a table and the payload
-- schema without a mapping document.
--
-- A projection column is a cache of a parse. An update that changes only an
-- unmodelled field still rewrites `sync_items.payload` and leaves every column
-- here untouched, and a local edit merges the changed keys into the parsed copy
-- of the payload rather than serialising a row back out (§A.1).
--
-- Every table below carries `clock` TEXT (JSON), `synced_at` INTEGER and
-- `deleted_at` INTEGER, per §A.4. The two field-merged types additionally carry
-- `field_clocks` TEXT.
--
-- §A.6 governs the timestamp columns: instants the core orders by are INTEGER
-- epoch milliseconds, and wire-shaped date-only or wall-clock values stay TEXT
-- exactly as the payload carries them.

-- From `folder_config`. The item id is the folder path.
--
-- `parent_path` and `name` are derived from `path`, kept as columns so the tree
-- query does not string-split on every row.
CREATE TABLE IF NOT EXISTS folders (
  path        TEXT PRIMARY KEY,
  parent_path TEXT,
  name        TEXT NOT NULL,
  icon        TEXT,
  position    INTEGER,
  created_at  INTEGER,
  modified_at INTEGER,
  clock       TEXT,
  synced_at   INTEGER,
  deleted_at  INTEGER
);

-- From `note`.
--
-- `content` is deliberately absent: the body lives in `note_bodies` and the CRDT
-- log, and a record push for an update carries `content: null`.
CREATE TABLE IF NOT EXISTS notes (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  folder_path           TEXT,
  emoji                 TEXT,
  file_type             TEXT NOT NULL DEFAULT 'markdown',
  mime_type             TEXT,
  attachment_id         TEXT,
  attachment_references TEXT,
  aliases               TEXT,
  properties            TEXT,
  created_at            INTEGER,
  modified_at           INTEGER,
  clock                 TEXT,
  synced_at             INTEGER,
  deleted_at            INTEGER
);

-- From `journal`. One row per calendar day (FR-054).
--
-- The UNIQUE on `date` is what makes "never a duplicate for the same day"
-- structural rather than a check in the domain layer. `date` is TEXT because it
-- is a calendar date, not an instant (§A.6).
--
-- PENDING G1 ratification of Q07.1 (T035). This shape assumes the journal body is
-- a CRDT document and that this row carries metadata only. If a journal body
-- turns out to travel as a record instead, the body moves into
-- `sync_items.payload` and this table gains a column in a later migration; it is
-- never edited in place, because migrations are forward only (§A.0).
CREATE TABLE IF NOT EXISTS journal_entries (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL UNIQUE,
  properties  TEXT,
  created_at  INTEGER,
  modified_at INTEGER,
  clock       TEXT,
  synced_at   INTEGER,
  deleted_at  INTEGER
);

-- From the `tags` array on `note` and `journal`.
--
-- COLLATE NOCASE is what FR-047's "letter-case behaviour identical to desktop"
-- means in practice; desktop uses the same collation.
CREATE TABLE IF NOT EXISTS note_tags (
  note_id    TEXT NOT NULL,
  tag        TEXT NOT NULL COLLATE NOCASE,
  position   INTEGER NOT NULL DEFAULT 0,
  pinned_at  INTEGER,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (note_id, tag)
);

-- From `tag_definition`. The item id is the tag name.
--
-- `color_authored` is load bearing: false means the palette handed the colour out
-- by local tag count, so it disagrees across devices and must not repaint another
-- device's tag. Absent means "cannot tell" and the receiver honours the colour.
CREATE TABLE IF NOT EXISTS tag_definitions (
  name           TEXT PRIMARY KEY COLLATE NOCASE,
  color          TEXT NOT NULL,
  color_authored INTEGER NOT NULL DEFAULT 0,
  icon           TEXT,
  category_id    TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  views          TEXT,
  created_at     INTEGER,
  clock          TEXT,
  synced_at      INTEGER,
  deleted_at     INTEGER
);

-- From `tag_category`.
CREATE TABLE IF NOT EXISTS tag_categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  updated_at INTEGER,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER
);

-- From `property_definition`. The item id is the property name.
--
-- `options` stays opaque JSON text, exactly as the payload carries it.
-- Re-declaring the option shape would parse away a newer client's per-option
-- field on a round trip.
CREATE TABLE IF NOT EXISTS property_definitions (
  name          TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  options       TEXT,
  default_value TEXT,
  color         TEXT,
  created_at    INTEGER,
  clock         TEXT,
  synced_at     INTEGER,
  deleted_at    INTEGER
);

-- From `template`.
--
-- `properties` must remain an array. A non-array from a differently versioned
-- peer is stored verbatim in `sync_items.payload` and would throw at
-- note-creation time, so the projector validates it and refuses to project rather
-- than crashing later.
CREATE TABLE IF NOT EXISTS templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  icon        TEXT,
  tags        TEXT,
  properties  TEXT,
  content     TEXT NOT NULL DEFAULT '',
  created_at  INTEGER,
  modified_at INTEGER,
  clock       TEXT,
  synced_at   INTEGER,
  deleted_at  INTEGER
);

-- From `task`. Field-merged, so it carries `field_clocks`.
--
-- The date columns stay TEXT because they are date-only or wall-clock values on
-- the wire, not instants, and converting them to epoch integers would invent a
-- timezone (§A.6).
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  project_id      TEXT NOT NULL,
  status_id       TEXT,
  parent_id       TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  position        INTEGER NOT NULL DEFAULT 0,
  due_date        TEXT,
  due_time        TEXT,
  start_date      TEXT,
  repeat_config   TEXT,
  repeat_from     TEXT,
  source_note_id  TEXT,
  completed_at    TEXT,
  archived_at     TEXT,
  tags            TEXT,
  linked_note_ids TEXT,
  created_at      INTEGER,
  modified_at     INTEGER,
  clock           TEXT,
  field_clocks    TEXT,
  synced_at       INTEGER,
  deleted_at      INTEGER
);

-- From `project`. Read and assign only in this feature (FR-060), but projected
-- fully so the read surface is complete. Field-merged.
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  color        TEXT NOT NULL,
  icon         TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  is_inbox     INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT,
  home_note_id TEXT,
  created_at   INTEGER,
  modified_at  INTEGER,
  clock        TEXT,
  field_clocks TEXT,
  synced_at    INTEGER,
  deleted_at   INTEGER
);

-- From the nested `statuses` array on `project`.
CREATE TABLE IF NOT EXISTS project_statuses (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL,
  position   INTEGER NOT NULL,
  is_default INTEGER,
  is_done    INTEGER,
  created_at INTEGER,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER
);

-- From the nested `links` array on `project`.
CREATE TABLE IF NOT EXISTS project_links (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  item_type  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  pinned     INTEGER,
  created_at INTEGER,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER
);

-- From `task_activity`. Append only and immutable, so it has no `field_clocks`
-- and no `modified_at`.
--
-- `old_value` and `new_value` are JSON-encoded scalars and are always NULL for
-- the `description` field, because the body is note-sized and is never duplicated
-- here.
CREATE TABLE IF NOT EXISTS task_activity (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL,
  action     TEXT NOT NULL,
  field      TEXT,
  old_value  TEXT,
  new_value  TEXT,
  actor      TEXT,
  device_id  TEXT,
  created_at INTEGER,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER
);

-- From `reminder`.
--
-- No `triggered_at`: see `local_notifications` in 0001. Dismiss and snooze state
-- does sync and lives here.
CREATE TABLE IF NOT EXISTS reminders (
  id              TEXT PRIMARY KEY,
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  remind_at       TEXT NOT NULL,
  anchor_id       TEXT,
  highlight_text  TEXT,
  highlight_start INTEGER,
  highlight_end   INTEGER,
  title           TEXT,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  dismissed_at    TEXT,
  snoozed_until   TEXT,
  created_at      INTEGER,
  modified_at     INTEGER,
  clock           TEXT,
  synced_at       INTEGER,
  deleted_at      INTEGER
);

-- From `settings`, which is one sync item with the fixed id `synced_settings`.
--
-- This is a flattened index for reading. The verbatim settings payload in
-- `sync_items.payload` is what preserves a group this core does not model, which
-- is how a preference with no phone equivalent survives a round trip (FR-063).
-- The core parses settings as raw JSON and merges changed dotted paths into the
-- parsed copy; it never passes settings through a closed schema.
--
-- `group` is quoted because GROUP is a SQL keyword.
CREATE TABLE IF NOT EXISTS settings (
  "group"    TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY ("group", key)
);

-- Per-path clocks for the one settings item. `path` is a dotted path such as
-- `general.theme` or `journal.weekdayTemplates.3`.
--
-- This is the one projection table that does not carry §A.4's three common
-- columns. `clock` here is the per-path clock the table exists for, so the common
-- `clock` column cannot also be added, and `synced_at`/`deleted_at` belong to the
-- single `settings` sync item rather than to a path within it. Flagged to the
-- orchestrator as a §A.4 wording defect rather than resolved here.
CREATE TABLE IF NOT EXISTS settings_field_clocks (
  path  TEXT PRIMARY KEY,
  clock TEXT NOT NULL
);
