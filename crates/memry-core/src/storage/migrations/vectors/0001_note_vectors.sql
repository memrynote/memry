-- vectors.db: per vault, device-local, never synced. A cache rebuilt from data.db.
--
-- Additive only: a new column has a default, a new table is IF NOT EXISTS, so an
-- older build keeps reading a file a newer one migrated. A change in what a vector
-- means is a new vector_key or input_version (rows go stale), never a schema rewrite.

CREATE TABLE IF NOT EXISTS note_vector_state (
  note_id       TEXT    PRIMARY KEY,
  vector_key    TEXT    NOT NULL,   -- which weights built it; another key never serves
  input_version INTEGER NOT NULL,   -- EMBEDDING_INPUT_VERSION at build time
  source_key    BLOB    NOT NULL CHECK (length(source_key) = 32),
  window_count  INTEGER NOT NULL,   -- 0 for a note under 10 units: done, nothing to search
  embedded_at   INTEGER NOT NULL    -- epoch ms, diagnostics only
) WITHOUT ROWID;

-- A rowid table on purpose: a 1 KiB row overflows a WITHOUT ROWID (index) b-tree
-- page, which made 10k windows take 46.8 MB instead of 14.1 MB.
CREATE TABLE IF NOT EXISTS note_vectors (
  note_id   TEXT    NOT NULL,
  window    INTEGER NOT NULL,       -- 0 = head (desktop vec_notes), 1.. = chunks (vec_note_chunks)
  embedding BLOB    NOT NULL CHECK (length(embedding) = 1024),  -- 256 x f32 LE, unit length
  PRIMARY KEY (note_id, window)
);
