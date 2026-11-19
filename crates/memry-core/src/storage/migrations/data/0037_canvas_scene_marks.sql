-- data.db, migration 0037: the record scene each canvas document agreed with
-- (desktop Step 30e2, #3547).
--
-- `canvas_files.scene_sha256` is the document's bytes as the app last wrote or
-- read them when the document and the canvas record held the same scene. Settle
-- tells "the document changed" from that sha, and needs the record's side of
-- the same agreement to tell "the record changed": the sha256 of the record's
-- scene text then. A timestamp cannot say it (a title change moves the record's
-- clock without touching its scene).
--
-- `file_sha256` repeats the `canvas_files.scene_sha256` the mark belongs to: a
-- row whose sha moved without a matching mark (written by a build before this
-- one) reads as "record side unknown", and an unknown side is treated as
-- changed, so an edit on disk then becomes a conflict copy, never overwritten.
--
-- Device-local and never synced. A new table rather than a column on
-- `canvas_files`, because `ADD COLUMN` has no `IF NOT EXISTS` (see 0022).
-- Additive: no existing table or row touched, no backfill. An older build never
-- reads the table. Re-runnable (§A.0 crash window).
CREATE TABLE IF NOT EXISTS canvas_scene_marks (
  canvas_id     TEXT PRIMARY KEY,
  file_sha256   TEXT NOT NULL,
  record_sha256 TEXT NOT NULL
);
