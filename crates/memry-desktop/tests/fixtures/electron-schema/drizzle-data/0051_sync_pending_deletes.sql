-- Deletes raised while the sync runtime was down (#1579).
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
--
-- A downgrade is inert: an older build never reads or writes the table, so it
-- simply keeps dropping deletes the way it does today. Its max journal `when`
-- is lower than this one's, so its migrator applies nothing and Drizzle never
-- drops the table. Re-upgrading resumes draining whatever is still in it.
--
-- Deliberately no foreign key and no cascade: the row this describes has
-- already been deleted, which is the whole point of the table.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE `sync_pending_deletes` (
	`type` text NOT NULL,
	`item_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`type`, `item_id`)
);
