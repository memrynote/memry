-- index.db, migration 0011: the note text each stored note vector was built from.
--
-- One row per embedded note, written in the transaction that stores its vectors
-- (`domain/note_embeddings.rs`): `content_hash` is the hash of the file bytes the
-- vectors were built from (the vault tier's hash, as `note_file_hashes.file_hash`
-- in data.db names them), and `title` the title they were built with. The
-- embedding reconcile owes a vector to every note whose file hash (else its
-- `note_files.content_hash`) or title moved since, or that has no row here, so an
-- edit or rename whose event never reached the embedding lane (a close, a missed
-- fact, a change made while the app was closed) is embedded on the next open.
--
-- Not in Electron's index: a table of its own, rather than a column on 0008's
-- Electron-shaped `note_embedding_state`, because `ALTER TABLE ... ADD COLUMN`
-- has no `IF NOT EXISTS` (data 0022 explains the re-run). An index from an
-- earlier build has vectors and no rows here, so every note is owed once and its
-- old vectors keep answering until new ones replace them. Derived and per
-- device, never synced. `IF NOT EXISTS`: a re-run keeps the rows.
CREATE TABLE IF NOT EXISTS note_embedding_hashes (
  note_id      TEXT PRIMARY KEY,
  content_hash TEXT,
  title        TEXT
);
