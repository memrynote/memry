-- One row per note whose window began at `source_key`. `unfinished` counts
-- the windows at that key that never returned: each window adds one when it
-- begins and takes it back when it returns, so a positive count a later step
-- finds belongs to windows that died with their process. The note's commit
-- deletes the row, and a new source key starts the count over. An older build
-- ignores the table.

CREATE TABLE IF NOT EXISTS note_embed_attempts (
  note_id    TEXT PRIMARY KEY,
  source_key BLOB NOT NULL CHECK (length(source_key) = 32),
  unfinished INTEGER NOT NULL DEFAULT 0 CHECK (unfinished >= 0)
) WITHOUT ROWID;
