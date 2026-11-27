-- 0023_pack_rollup: pack coverage and the replaced-object grace (#5229,
-- protocol 08 §8.10, §8.12). Additive only. A Worker built before this
-- migration names its insert columns, so its rows carry NULL coverage, which
-- means a cache-only pack, and it never writes the new table.

-- Coverage range (cover_from, cover_through] on the server_cursor axis. NULL
-- on a pack built before this migration and on body packs: a cache only.
ALTER TABLE pack_index ADD COLUMN cover_from INTEGER;
ALTER TABLE pack_index ADD COLUMN cover_through INTEGER;

-- cover_through of the kind's newest committed pack, the next build's
-- cover_from. NULL on a row written before this migration, whose builds then
-- stay cache-only.
ALTER TABLE pack_watermarks ADD COLUMN covered_through INTEGER;

-- Objects of pack_index rows a rollup removed. Each is deleted no earlier than
-- PACK_REPLACED_GRACE_SECONDS after removed_at. A row here outlives a Worker
-- restart until the deletion runs.
CREATE TABLE IF NOT EXISTS pack_replaced_objects (
  pack_key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  -- pack_index id of the pack that replaced it
  replaced_by TEXT NOT NULL,
  removed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pack_replaced_removed ON pack_replaced_objects(removed_at);
CREATE INDEX IF NOT EXISTS idx_pack_replaced_by ON pack_replaced_objects(replaced_by);
