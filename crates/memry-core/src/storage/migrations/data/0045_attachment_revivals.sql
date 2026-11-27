-- data.db, migration 0044: notes this device revived (its edit beat a pulled
-- delete) whose attachments the upload re-drive has not checked yet (Step 18
-- S5, #3535, §14.8.2). Electron keeps this set in memory and loses it on a
-- restart; a row here survives one, and goes only once the check settled.
-- Read and written only through `sync::attachments::revival`.
--
-- Additive only: one new table, no existing row touched. An older build never
-- reads it. Device-local, never synced, nothing to import from Electron.
CREATE TABLE IF NOT EXISTS attachment_revived_notes (
  note_id    TEXT PRIMARY KEY NOT NULL,
  revived_at INTEGER NOT NULL
);
