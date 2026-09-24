-- Note bodies in the change feed (#2295). crdt_updates and crdt_snapshots take
-- a server_cursor from the same per-user server_cursor_sequence as sync_items,
-- allocated inside the batch that commits the row, so GET /sync/changes can
-- serve body rows in one cursor order with records.
--
-- Backward compatibility:
--   * Nullable, no default, no backfill. A row written before this migration
--     keeps NULL and never matches server_cursor > ?, so the feed never serves
--     it. Bootstrap (snapshot GET, packs) and the per-note CRDT routes still do.
--   * The indexes are partial on server_cursor IS NOT NULL, so they are empty
--     at creation and cost nothing for the pre-migration rows.
--   * A Worker deployed before this migration (or rolled back after it) names
--     its insert columns explicitly and writes NULL, so old server code keeps
--     working. Its rows are invisible to the feed.
ALTER TABLE crdt_updates ADD COLUMN server_cursor INTEGER;
ALTER TABLE crdt_snapshots ADD COLUMN server_cursor INTEGER;

CREATE INDEX IF NOT EXISTS idx_crdt_updates_user_cursor
  ON crdt_updates(user_id, vault_id, server_cursor) WHERE server_cursor IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crdt_snapshots_user_cursor
  ON crdt_snapshots(user_id, vault_id, server_cursor) WHERE server_cursor IS NOT NULL;
