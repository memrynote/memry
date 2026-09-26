-- The highest delete clock this device has seen per re-creatable id (#2409),
-- so a re-created journal day, tag, folder or restored note is minted with a
-- clock that happens strictly after its tombstone.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
-- Deletes made before the upgrade have no recorded clock and keep today's
-- behaviour.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. Re-upgrading finds the rows still there.
--
-- No foreign key: the row describes an item that has been deleted.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `sync_tombstone_clocks` (
	`type` text NOT NULL,
	`item_id` text NOT NULL,
	`clock` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`type`, `item_id`)
);
