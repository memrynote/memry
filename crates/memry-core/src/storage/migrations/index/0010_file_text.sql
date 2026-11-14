-- index.db, migration 0010: the text read out of files, and the background jobs
-- that read it (`domain/file_text.rs`).
--
-- Same names and columns as Electron's index database: `extracted_text` and
-- `file_text_jobs` of `drizzle-index/0023_extracted_text.sql`, with the
-- `ocr_languages` column of `0024_file_text_ocr_languages.sql`, so the migration
-- from Electron can copy rows when note ids are kept, and a NULL `ocr_languages`
-- still means English only. Electron's foreign keys to `note_cache` are left out,
-- as in 0008: this index has no `note_cache`, and the file text runner prunes the
-- rows of notes that are gone.
--
-- The rows are per device and derived, never synced. Every statement is
-- `IF NOT EXISTS`: an index that already holds these tables keeps them and their
-- rows.

-- One row per part of a file: a PDF page (1-based), or the one part of an image
-- or an HTML file. `source` is '' for the note's own file, else a file name in
-- the note's attachments folder.
CREATE TABLE IF NOT EXISTS extracted_text (
  note_id TEXT NOT NULL,
  source  TEXT NOT NULL DEFAULT '',
  part    INTEGER NOT NULL,
  method  TEXT NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (note_id, source, part)
);

-- One row per file: the bytes its parts came from (`signature`) and how far the
-- reading got.
CREATE TABLE IF NOT EXISTS file_text_jobs (
  note_id       TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT '',
  signature     TEXT NOT NULL,
  status        TEXT NOT NULL,
  page_count    INTEGER,
  error         TEXT,
  app_version   TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  ocr_languages TEXT,
  PRIMARY KEY (note_id, source)
);

-- The runner's next pending job and its retry scan read by status, oldest first.
-- Not in Electron's index, which scans the table.
CREATE INDEX IF NOT EXISTS idx_file_text_jobs_status ON file_text_jobs (status, updated_at);
