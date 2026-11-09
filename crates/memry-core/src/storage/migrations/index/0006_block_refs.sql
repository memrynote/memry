-- index.db, migration 0006: references into another note's blocks (Electron's
-- `portal_refs` and `block_link_refs`, `packages/db-schema/src/schema/notes-cache.ts`).
--
-- Derived from each note's document by the search reindex and never synced.
--
-- `portal_refs` holds one row per `memry-portal` fence: one per root and per
-- shown child of a blocks portal, one for a note or search portal. `ordinal`
-- is the fence's position among the host's portal fences, counting fences
-- this build cannot read. `source_note_id` and `anchor` are NULL for a search
-- portal, and `anchor` is NULL for a whole-note portal. There is no foreign
-- key: a row outlives a deleted source note, because the host still shows
-- the portal.
CREATE TABLE IF NOT EXISTS portal_refs (
  host_note_id   TEXT NOT NULL,
  ordinal        INTEGER NOT NULL,
  source_note_id TEXT,
  anchor         TEXT,
  root           INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL,
  PRIMARY KEY (host_note_id, ordinal, root)
);
CREATE INDEX IF NOT EXISTS idx_portal_refs_source ON portal_refs (source_note_id, anchor);

-- `block_link_refs` holds one row per `[[Note#^anchor]]` (or markdown link to
-- a block) in a note, deduped by the target's name key. `target` is the note
-- half as first written, which the reader resolves the way a wiki link
-- resolves; Electron kept only the key.
CREATE TABLE IF NOT EXISTS block_link_refs (
  source_note_id TEXT NOT NULL,
  target_key     TEXT NOT NULL,
  anchor         TEXT NOT NULL,
  target         TEXT NOT NULL,
  PRIMARY KEY (source_note_id, target_key, anchor)
);
CREATE INDEX IF NOT EXISTS idx_block_link_refs_target ON block_link_refs (target_key, anchor);

-- An index migrated in place keeps its watermark, and an incremental pass
-- would never derive these rows for a note that does not change again. Dropping
-- the notes watermark makes the next reindex a full one, which fills both
-- tables. A fresh file has no watermark to drop.
DELETE FROM index_meta WHERE key = 'watermark.fts_notes';
