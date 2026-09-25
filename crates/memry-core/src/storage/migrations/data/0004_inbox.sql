-- data.db, migration 0004: the `inbox` projection and the device-local inbox
-- tables (spec 006 IB010).
--
-- Additive only: new tables, no existing table or row touched. `inbox_items`
-- is a cache of a parse of `sync_items.payload` like every table 0002 creates,
-- rebuildable by replaying the `inbox` rows through their projector, so an
-- install that migrated before the core subscribed to `inbox` loses nothing.
--
-- The columns are the thirteen `InboxSyncPayloadSchema` keys. Instants are
-- epoch milliseconds (§A.6); `metadata` is the payload's value as JSON text,
-- opaque (`z.unknown()` on the wire).
CREATE TABLE IF NOT EXISTS inbox_items (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL DEFAULT 'note',
  title                TEXT NOT NULL DEFAULT 'Untitled',
  content              TEXT,
  metadata             TEXT,
  filed_at             INTEGER,
  filed_to             TEXT,
  filed_action         TEXT,
  snoozed_until        INTEGER,
  snooze_reason        TEXT,
  archived_at          INTEGER,
  source_url           TEXT,
  source_title         TEXT,
  capture_source       TEXT,
  created_at           INTEGER,
  modified_at          INTEGER,
  clock                TEXT,
  synced_at            INTEGER,
  deleted_at           INTEGER
);

CREATE INDEX IF NOT EXISTS inbox_items_created ON inbox_items (created_at);
CREATE INDEX IF NOT EXISTS inbox_items_filed ON inbox_items (filed_at);
CREATE INDEX IF NOT EXISTS inbox_items_snoozed ON inbox_items (snoozed_until);
CREATE INDEX IF NOT EXISTS inbox_items_archived ON inbox_items (archived_at);

-- Desktop pushes its whole `inbox_items` row serialised, so a payload also
-- carries desktop's local columns (`viewedAt`, `processingStatus`,
-- `transcription`, ...) as keys the schema does not model. They are not
-- projection columns (a projection caches the schema's parse, §13.2 rule 2);
-- this view reads them straight from the verbatim payload.
CREATE VIEW IF NOT EXISTS inbox_view AS
SELECT i.*,
       json_extract(s.payload, '$.viewedAt')            AS viewed_at_raw,
       json_extract(s.payload, '$.processingStatus')    AS processing_status,
       json_extract(s.payload, '$.transcription')       AS transcription,
       json_extract(s.payload, '$.transcriptionStatus') AS transcription_status,
       json_extract(s.payload, '$.attachmentPath')      AS attachment_path,
       json_extract(s.payload, '$.thumbnailPath')       AS thumbnail_path
  FROM inbox_items i
  JOIN sync_items s ON s.item_type = 'inbox' AND s.item_id = i.id
 WHERE json_valid(s.payload);

-- Tags on an unfiled capture. Device-local, as on desktop (`inbox_item_tags`
-- never syncs); they are merged into the note or task the capture becomes.
CREATE TABLE IF NOT EXISTS inbox_item_tags (
  item_id    TEXT NOT NULL,
  tag        TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, tag)
);
