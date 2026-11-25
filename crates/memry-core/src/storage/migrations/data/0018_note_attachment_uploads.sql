-- data.db, migration 0018: a note's attachment waits here until it is
-- uploaded (#5510, §14.7).
--
-- Additive only: one new table, no existing table or row touched. The bytes
-- are already under `images/<attachment_id>` and the `attachments` row already
-- names them when this row is written, all before the shell inserts the block,
-- so an attach made offline survives a relaunch and uploads on a later sync
-- pass under this same attachment id. The note's `attachmentReferences` gains
-- the id only after the manifest is stored. An older build ignores the table:
-- its pending uploads stay on this device until a build that knows it runs.
CREATE TABLE IF NOT EXISTS note_attachment_uploads (
  attachment_id TEXT PRIMARY KEY,
  note_id       TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
