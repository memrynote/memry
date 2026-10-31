-- index.db, migration 0003: what desktop measures in a note's vault file
-- (Electron's `note_cache` counts and snippet, `syncNoteToCache`).
--
-- Derived like the rest of this file: `domain::note_stats` writes a row from
-- the file's text, and an empty table is filled again by the next scan. A row
-- names the bytes it was measured from (`file_hash`, the vault tier's hash of
-- the file, data.db `note_file_hashes.file_hash`), so a scan re-measures a
-- note whose file moved past it.
--
-- `task_ids` and `header_tags` are JSON arrays of strings. `date` is the
-- journal day the file's path names, NULL for every other note.
CREATE TABLE IF NOT EXISTS note_stats (
  note_id         TEXT PRIMARY KEY,
  file_hash       TEXT,
  word_count      INTEGER NOT NULL,
  character_count INTEGER NOT NULL,
  snippet         TEXT NOT NULL,
  cover           TEXT,
  task_ids        TEXT NOT NULL,
  header_tags     TEXT NOT NULL,
  date            TEXT,
  indexed_at      INTEGER NOT NULL
);
