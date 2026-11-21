-- data.db, migration 0038: Readwise's device-local state (Step 33, #3550), the tables of
-- desktop's `0078_readwise_links.sql` and `0079_readwise_highlights.sql` and the run state
-- desktop kept in its `settings` table under `readwise.<name>` keys (`sync-state.ts`).
--
-- Additive: three new tables, no existing table or row touched, and an older build never
-- reads them. None syncs (no clock, no outbox row): a note's `readwise_url` is the identity
-- that travels, the links are rebuilt from it, and a full export refills the highlights.
--
-- `readwise_links.updated_at` is epoch milliseconds (desktop wrote ISO text).
-- `readwise_run_state` holds one row per desktop key, `key` without its `readwise.` prefix
-- (`cursor`, `retryList`, `lastRun`, ...), and `value` the exact text desktop stored.
CREATE TABLE IF NOT EXISTS readwise_links (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  readwise_book_id   INTEGER,
  reader_document_id TEXT,
  note_id            TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'linked',
  updated_at         INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_readwise_links_book_id
  ON readwise_links (readwise_book_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_readwise_links_reader_document_id
  ON readwise_links (reader_document_id);
CREATE INDEX IF NOT EXISTS idx_readwise_links_note_id ON readwise_links (note_id);
CREATE INDEX IF NOT EXISTS idx_readwise_links_state ON readwise_links (state);

CREATE TABLE IF NOT EXISTS readwise_highlights (
  highlight_id   INTEGER PRIMARY KEY NOT NULL,
  book_id        INTEGER NOT NULL,
  highlighted_at TEXT,
  created_at     TEXT,
  deleted        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_readwise_highlights_book_id ON readwise_highlights (book_id);

CREATE TABLE IF NOT EXISTS readwise_run_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  modified_at INTEGER NOT NULL
);
