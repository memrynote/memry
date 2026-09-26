-- #2302. A tombstone past version_history_days sheds its payload (the R2
-- object, signature and content hash) but keeps its row. deleted_at, clock,
-- server_cursor and the (type, id) identity stay, so delete-wins and replay
-- detection keep refusing a stale push from a device that was offline past
-- retention. A client that declares purged_tombstones in X-Memry-Sync-Types
-- also sees the delete: the changes feed names it and POST /sync/pull serves it
-- as a purgedTombstones entry. Every other client never sees a marker, as with
-- the old hard delete. The marker is blob_key = '', payload_purged_at records
-- when the payload was shed.
--
-- Backward compatibility:
--   * Nullable, no default, no backfill. Every existing row keeps NULL, which is
--     exactly what an unshed tombstone or a live row is.
--   * Tombstones the previous cleanup already hard-deleted are gone and cannot
--     be recovered: nothing identifies them, so they stay unprotected.
--   * A Worker deployed before this migration (or rolled back after it) names
--     its columns explicitly and never reads these. A rolled-back cleanup would
--     hard-delete marker rows again, refunding size_bytes = 0.
ALTER TABLE sync_items ADD COLUMN payload_purged_at INTEGER;

-- #2302. Set by POST /sync/pull when a live row's R2 object is confirmed gone
-- while the row still points at it. Report only, never a reason to delete the
-- row. The next accepted push of the item clears it.
ALTER TABLE sync_items ADD COLUMN blob_missing_at INTEGER;

-- The cleanup's working set: tombstones that still hold a payload. A marker
-- has blob_key = '' and leaves the index, so the ever-growing marker set is
-- never scanned.
CREATE INDEX IF NOT EXISTS idx_sync_items_unshed_tombstones
  ON sync_items(deleted_at) WHERE deleted_at IS NOT NULL AND blob_key <> '';
