-- The versions kept as an outside write (`note_snapshots::Reason::OutsideWrite`): bytes
-- the app did not write and wrote over, such as the outside edit a locked note's revert
-- replaces. Their `reason` stays `significant`, as Electron stores it, so the version
-- history could not tell them apart and called such a version the latest (S14-5).
--
-- A table of its own rather than a column on `note_snapshots`, because `ALTER TABLE ...
-- ADD COLUMN` has no `IF NOT EXISTS` (see 0022). Device-local, never synced. Additive: no
-- existing table or row touched, and an older build never reads it. An older build that
-- deletes or prunes a version leaves its row here; ids are never reused, so the row
-- marks nothing, and this build's next delete or prune removes it.
CREATE TABLE IF NOT EXISTS note_snapshot_outside_writes (
  snapshot_id TEXT PRIMARY KEY
);
