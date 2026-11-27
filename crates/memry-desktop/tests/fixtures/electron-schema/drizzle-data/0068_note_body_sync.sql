-- Where each note's body stands with the server (#2647). One row per CRDT
-- document id, written by the note body outbox when a push starts and ends.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
-- A note with no row reads as "no body push recorded by this version".
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. Re-upgrading finds the rows still there.
--
-- No foreign key: the note row can be deleted while the row stands.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `note_body_sync` (
	`note_id` text PRIMARY KEY NOT NULL,
	`last_sent_at` integer,
	`last_confirmed_at` integer,
	`last_failed_at` integer,
	`last_rejected_at` integer,
	`updated_at` integer NOT NULL
);
