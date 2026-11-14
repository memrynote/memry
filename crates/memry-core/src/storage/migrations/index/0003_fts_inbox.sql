-- index.db, migration 0003: inbox items in search (#4320).
--
-- Desktop's `fts_inbox` (`fts-inbox.ts`): the same columns in the same order,
-- because the order is what gives `bm25(fts_inbox, 0.0, 3.0, 1.0, 1.0, 0.5)`
-- its meaning (title 3.0, content and transcription 1.0, source title 0.5).
-- Every live capture is indexed, filed, archived and snoozed ones included.
--
-- index.db is rebuilt rather than migrated (§A.0): an existing file at version
-- 2 is deleted, rebuilt at this version, and filled by the next reindex.
CREATE VIRTUAL TABLE IF NOT EXISTS fts_inbox USING fts5 (
  id UNINDEXED,
  title,
  content,
  transcription,
  source_title,
  tokenize = 'porter unicode61'
);
