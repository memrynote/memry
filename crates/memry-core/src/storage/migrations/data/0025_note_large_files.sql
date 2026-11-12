-- data.db, migration 0025: the notes whose file is large-file class (desktop
-- Step 14c-2, #3531).
--
-- A note file past 1 MiB, or with a blank-line block past 128 KiB
-- (`markdown::shared::markdown_class`), is shown in the large-file viewer and
-- never edited: the editor opens its document read-only and refuses its edits
-- (`api::editor`). The desktop code that reads the file measures it and records
-- the class here, so the editor decides from the database and never reads the
-- file again. A row: the last read found the file large. No row: note class,
-- or not measured since this migration.
--
-- Device-local and never synced: another device's file says nothing about
-- this one's. Keyed by note id with no foreign key, as `note_files`, and a
-- removed `note_files` row takes its class with it. A new table rather than a
-- column on `note_files` for the reason 0021 gives: `ADD COLUMN` has no
-- `IF NOT EXISTS`, so a re-run after a crash before the `user_version` write
-- would fail forever.
--
-- Additive: one new table, no existing table or row touched, no backfill. The
-- open walk reads again every file whose text its note did not take, which a
-- large file's never is, and records its class then; opening a note reads its
-- file and records it too. An older build reads this database as before and
-- never reads the table.
CREATE TABLE IF NOT EXISTS note_large_files (
  note_id TEXT PRIMARY KEY
);
