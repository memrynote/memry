-- index.db, migration 0005: the note fold cache (Electron's `note_fold_chunks`,
-- `packages/db-schema/src/schema/note-fold-chunks.ts`).
--
-- One row per fold chunk (a heading and its paragraphs, or a slice of a long
-- section), keyed by the chunk's content hash, the note language and the model
-- that wrote it (`model_id`). As in Electron, only a model's lines are kept: the
-- Brief the app picks from the note's own sentences is picked again on every
-- fold. An edit elsewhere in the note never invalidates a row. `payload`
-- is the JSON of the chunk's lines; `created_at` is epoch milliseconds, and
-- rows past the retention window are dropped. Derived and never synced: an
-- empty table is filled again as notes fold.
CREATE TABLE IF NOT EXISTS note_fold_chunks (
  chunk_hash TEXT NOT NULL,
  language   TEXT NOT NULL,
  model_id   TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chunk_hash, language, model_id)
);
