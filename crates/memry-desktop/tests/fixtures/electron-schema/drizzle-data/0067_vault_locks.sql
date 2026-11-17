-- Read-only locks for notes and folders (#2606).
--
-- `vault_locks` holds the `vault_lock` sync records: one row per note or folder
-- that is or was locked. Unlocking flips `locked` to 0 and keeps the row.
-- `vault_lock_baselines` is device-local: the bytes of each locked markdown
-- note as the app last wrote or accepted them, written back when the file
-- changes outside the app.
--
-- Additive only. Two new tables, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining two empty tables; nothing is locked until the
-- owner locks something.
--
-- A downgrade is inert: an older build never reads or writes these tables and
-- never declares `vault_lock` in X-Memry-Sync-Types, so the server never sends
-- it one. Its max journal `when` is lower than this one's, so its migrator
-- applies nothing and Drizzle never drops the tables. Re-upgrading finds the
-- rows still there.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `vault_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`target_kind` text NOT NULL,
	`target` text NOT NULL,
	`locked` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`clock` text,
	`synced_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vault_lock_baselines` (
	`note_id` text PRIMARY KEY NOT NULL,
	`content_hash` text NOT NULL,
	`content` text NOT NULL,
	`updated_at` text NOT NULL
);
