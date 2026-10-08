-- The permission bits each file had before a read-only lock cleared its write
-- bits, so unlocking restores them exactly (a 664 file comes back 664, not
-- 644). Keyed by vault-relative path. Device-local, never synced.
--
-- Additive only: one new table, no ALTER, no backfill. Files locked by an
-- older build have no row and unlock as before, with the owner write bit set.
-- An older build never reads or writes this table.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `vault_lock_file_modes` (
	`path` text PRIMARY KEY NOT NULL,
	`mode` integer NOT NULL
);
