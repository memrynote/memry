-- Idempotent CRDT update store (#2296). storeUpdates writes the SHA-256 of the
-- stored update bytes, and a retried push of the same bytes for the same note
-- hits this unique index and is ignored instead of stored a second time.
--
-- Backward compatibility:
--   * Nullable, no default, no backfill. A row written before this migration
--     keeps NULL, and the index is partial on update_hash IS NOT NULL, so old
--     rows never conflict with each other or with a new row.
--   * A Worker deployed before this migration (or rolled back after it) names
--     its insert columns explicitly and writes NULL, so old server code keeps
--     working and simply does not deduplicate.
ALTER TABLE crdt_updates ADD COLUMN update_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_crdt_updates_note_hash
  ON crdt_updates(user_id, vault_id, note_id, update_hash) WHERE update_hash IS NOT NULL;
