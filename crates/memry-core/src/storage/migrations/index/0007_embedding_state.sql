-- index.db, migration 0007: what the embedding lanes have derived, and the inbox
-- full-text table.
--
-- Same names and columns as Electron's index database (`note_embedding_state`
-- and `image_embedding_state` in `packages/db-schema/src/schema/`,
-- `voice_embedding_state` in `apps/desktop/src/main/database/voice-vectors.ts`),
-- so the migration from Electron can copy rows when note ids are kept.
-- Electron's foreign keys to `note_cache` are left out: this index has no
-- `note_cache`, and the embedding reconcile prunes rows of notes that are gone.
-- `fts_inbox` is different: Electron keeps it in `data.db`
-- (`apps/desktop/src/main/database/fts-inbox.ts` takes a `DataDb`), so there is
-- nothing to copy from an Electron index; it is built here from the inbox items.
--
-- The vectors these rows describe live in vec0 tables that `storage/vec.rs`
-- creates when the index opens, never in a migration, so no later migration of
-- this file can drop hours of embeddings. Every statement is `IF NOT EXISTS`: an
-- index that already holds these tables keeps them and their rows.

-- One row per embedded note: the input version its vectors were built from, and
-- how many windows after the first (`vec_note_chunks`) it has.
CREATE TABLE IF NOT EXISTS note_embedding_state (
  note_id       TEXT PRIMARY KEY,
  input_version INTEGER NOT NULL,
  chunk_count   INTEGER NOT NULL DEFAULT 0
);

-- One row per embedded image of a note; `source` is the image's path ('' for an
-- image file note itself) and `signature` identifies the file version that was
-- embedded. Its vector is `vec_images` row `<note_id>/<source>`.
CREATE TABLE IF NOT EXISTS image_embedding_state (
  note_id       TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT '',
  signature     TEXT NOT NULL,
  input_version INTEGER NOT NULL,
  PRIMARY KEY (note_id, source)
);

-- One row per embedded voice memo: which input it came from, its version and
-- how many `vec_voice` windows it has.
CREATE TABLE IF NOT EXISTS voice_embedding_state (
  item_id       TEXT PRIMARY KEY NOT NULL,
  source        TEXT NOT NULL,
  input_version INTEGER NOT NULL,
  chunks        INTEGER NOT NULL
);

-- Inbox items for search, which migration 0001 left out. The column order is
-- what Electron's `bm25(fts_inbox, 0.0, 3.0, 1.0, 1.0, 0.5)` weights refer to,
-- so it must not be reordered. `id` has no unique index: a write deletes the
-- item's row before inserting it.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_inbox USING fts5 (
  id UNINDEXED,
  title,
  content,
  transcription,
  source_title,
  tokenize = 'porter unicode61'
);
