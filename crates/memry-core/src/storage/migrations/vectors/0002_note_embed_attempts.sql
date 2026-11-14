-- One row while a note's window is in inference, written before it runs and
-- deleted when it returns. A row a later step finds belongs to a window that
-- died with its process, so that note is skipped until its source_key changes.
-- An older build ignores the table.

CREATE TABLE IF NOT EXISTS note_embed_attempts (
  note_id    TEXT PRIMARY KEY,
  source_key BLOB NOT NULL CHECK (length(source_key) = 32)
) WITHOUT ROWID;
