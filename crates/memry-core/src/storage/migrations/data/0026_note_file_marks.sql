-- data.db, migration 0026: how far each note's body log had come when its
-- `note_files` row was stamped (desktop Step 14b-2, #3531).
--
-- A row's stamp (`indexed_at`) is a millisecond, and "the body moved after the
-- stamp" read from the log's `created_at` misses an edit stored in the same
-- millisecond: typing the file does not have yet then loses to an outside edit.
-- The mark is one past the highest sequence each namespace of the note's log
-- had claimed at the stamp (`domain::write_back::LogMark`): any entry at or
-- above it is after the stamp, whatever its clock. `indexed_at` repeats the
-- stamp the mark belongs to, so a stamp an older build moved without a mark
-- leaves the mark unused rather than wrong.
--
-- Device-local and never synced. A new table rather than columns on
-- `note_files` for the reason 0021 gives. Additive: no existing table or row
-- touched, no backfill; a row with no mark of its stamp is read by its
-- millisecond, as before. An older build never reads the table, and a removed
-- `note_files` row takes its mark with it.
CREATE TABLE IF NOT EXISTS note_file_marks (
  note_id    TEXT PRIMARY KEY,
  indexed_at INTEGER NOT NULL,
  server_seq INTEGER NOT NULL,
  local_seq  INTEGER NOT NULL
);
