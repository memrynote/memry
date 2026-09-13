-- index.db, migration 0001: the rebuildable search and link index.
--
-- data-model §A.5. Everything here is derived from `data.db`, and the whole file
-- may be deleted and rebuilt. That is the point of the split: a full-text index
-- rebuild never touches a row that holds unsynced user data. The core deletes and
-- rebuilds this file when it is missing, corrupt, or at an unexpected
-- `user_version`, rather than migrating it (§A.0).
--
-- The tokenizer and the bm25 weight vector are part of the contract, not tuning
-- knobs. Desktop ranks with bm25(fts_notes, 0.0, 2.0, 1.0, 1.0) and
-- bm25(fts_tasks, 0.0, 2.0, 1.0, 1.0); a different weight vector produces a
-- different order for the same query and corpus and fails FR-053. The column
-- order below is what makes those weight vectors mean what they mean, so it must
-- not be reordered.
--
-- What FR-053 parity claims: both shells run the same ranking function over each
-- client's own extracted text. Desktop indexes markdown; this core indexes
-- extract_text(doc) output (§A.3), because the core has no markdown. Those are
-- not the same bytes, so identical ordering is a testable claim only where the
-- extracted text matches on both sides. The contract is the ranking function.
--
-- Journals are indexed in `fts_notes` alongside notes, distinguished by the
-- `date` on their `journal_entries` projection row, which is what desktop does.
-- `fts_inbox` is not created: inbox is out of scope for this feature.
--
-- One operational note carried over from the mobile baseline: on that stack,
-- closing a connection while an FTS5 virtual table is attached segfaults, and the
-- code defensively drops FTS tables before close. That is a bug in a particular
-- JavaScript SQLite binding, not in SQLite, and it must not be copied here.

CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5 (
  id UNINDEXED,
  title,
  content,
  tags,
  tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_tasks USING fts5 (
  id UNINDEXED,
  title,
  description,
  tags,
  tokenize = 'porter unicode61'
);

-- `target_id` is NULL for a wiki-link whose target does not exist yet, which is
-- how a forward reference survives until the note it points at is created.
CREATE TABLE IF NOT EXISTS note_links (
  source_id    TEXT NOT NULL,
  target_id    TEXT,
  target_title TEXT NOT NULL,
  PRIMARY KEY (source_id, target_title)
);

-- Denormalised from `notes.properties` so a property query is an index seek.
CREATE TABLE IF NOT EXISTS note_properties (
  note_id TEXT NOT NULL,
  name    TEXT NOT NULL,
  value   TEXT,
  type    TEXT NOT NULL,
  PRIMARY KEY (note_id, name)
);

-- Holds the `data.db` `user_version` the index was built against and a per-table
-- watermark, so an incremental reindex is possible and a full rebuild is only
-- needed when the watermark is missing.
CREATE TABLE IF NOT EXISTS index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
