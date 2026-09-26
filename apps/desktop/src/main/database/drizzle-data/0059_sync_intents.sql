-- Local changes committed together with their row that still owe the sync
-- clock bump and the `sync_queue` row (#2301).
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
-- The table is empty at rest: each row is written in the same transaction as
-- the local edit and deleted in the transaction that queues it.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. Re-upgrading replays whatever is still in it at
-- the next sync runtime start; replay is idempotent.
--
-- No foreign key: a delete intent outlives its row by design.
--
-- A row is deleted only by the replay that queues it. A row a newer build
-- wrote and this one cannot read is left in place for the next upgrade.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `sync_intents` (
	`seq` integer PRIMARY KEY,
	`type` text NOT NULL,
	`item_id` text NOT NULL,
	`op` text NOT NULL,
	`args` text DEFAULT '[]' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sync_intents_item` ON `sync_intents` (`type`, `item_id`);
