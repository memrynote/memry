-- index.db, migration 0011: the note text each stored note vector was built from.
--
-- One row per embedded note: the `note_files` content hash (data.db, the hash the
-- note index compares too: `content_hash`, else `note_file_hashes.file_hash`) the
-- note had when its vectors were built, written in the transaction that stores
-- them (`domain/note_embeddings.rs`). The embedding reconcile owes a vector to
-- every note whose hash moved since, or that has no row here, so an edit whose
-- event never reached the embedding lane (a close, a missed fact, an edit made
-- while the app was closed) is embedded on the next open.
--
-- Not in Electron's index: a table of its own, rather than a column on 0008's
-- Electron-shaped `note_embedding_state`, because `ALTER TABLE ... ADD COLUMN`
-- has no `IF NOT EXISTS` (data 0022 explains the re-run). An index from an
-- earlier build has vectors and no rows here, so every note is owed once and its
-- old vectors keep answering until new ones replace them. Derived and per
-- device, never synced. `IF NOT EXISTS`: a re-run keeps the rows.
CREATE TABLE IF NOT EXISTS note_embedding_hashes (
  note_id      TEXT PRIMARY KEY,
  content_hash TEXT
);
