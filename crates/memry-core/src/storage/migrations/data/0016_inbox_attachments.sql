-- data.db, migration 0016: an Inbox capture's file travels between devices
-- (#4157, §14.7.2).
--
-- Additive only. `inbox_view` is a view, so it holds no data: it is dropped and
-- recreated with one more column, `attachment_id`, read from the verbatim
-- payload like the other keys the projection does not model. A column on
-- `inbox_items` would need `ALTER TABLE ... ADD COLUMN`, which has no `IF NOT
-- EXISTS`, so a crash between this migration's commit and the `user_version`
-- write (§A.0) would make the re-run fail forever (see 0015). An older build
-- reads the view by column name and never meets the new column.
DROP VIEW IF EXISTS inbox_view;

CREATE VIEW IF NOT EXISTS inbox_view AS
SELECT i.*,
       json_extract(s.payload, '$.viewedAt')            AS viewed_at_raw,
       json_extract(s.payload, '$.processingStatus')    AS processing_status,
       json_extract(s.payload, '$.transcription')       AS transcription,
       json_extract(s.payload, '$.transcriptionStatus') AS transcription_status,
       json_extract(s.payload, '$.attachmentPath')      AS attachment_path,
       json_extract(s.payload, '$.thumbnailPath')       AS thumbnail_path,
       json_extract(s.payload, '$.attachmentId')        AS attachment_id
  FROM inbox_items i
  JOIN sync_items s ON s.item_type = 'inbox' AND s.item_id = i.id
 WHERE json_valid(s.payload);

-- A capture's file waits here until it is uploaded. The row is written in the
-- capture's own transaction, so only a capture made by a build that knows this
-- table is ever uploaded: older captures have no row and never upload.
CREATE TABLE IF NOT EXISTS inbox_attachment_uploads (
  item_id    TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- A permanently deleted capture's uploaded file, held for the 30-day grace of
-- §14.8 before its chunks are dereferenced (unless a note references it).
CREATE TABLE IF NOT EXISTS inbox_attachment_releases (
  item_id       TEXT PRIMARY KEY,
  attachment_id TEXT NOT NULL,
  deleted_at    INTEGER NOT NULL
);
