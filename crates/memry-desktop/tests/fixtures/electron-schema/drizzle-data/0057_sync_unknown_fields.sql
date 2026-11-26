-- Payload keys stripped by this build's schemas, kept for round trip (#2183).
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
--
-- A downgrade is inert: an older build never reads or writes the table, so it
-- keeps stripping unknown keys the way it does today. Its max journal `when` is
-- lower than this one's, so its migrator applies nothing and Drizzle never drops
-- the table. Re-upgrading resumes merging whatever is still in it.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE `sync_unknown_fields` (
	`type` text NOT NULL,
	`item_id` text NOT NULL,
	`fields` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`type`, `item_id`)
);
