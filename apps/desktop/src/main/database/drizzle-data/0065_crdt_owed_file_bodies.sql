-- Notes whose vault file holds a body their CRDT doc has not taken (#2646).
-- One row per CRDT document id.
--
-- Written when a main-process edit reaches a note whose doc could not take it
-- (no store, no editor). Deleted when the doc takes the file.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. Re-upgrading finds the rows still there.
--
-- No foreign key: the note row can be deleted while the marker stands.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `crdt_owed_file_bodies` (
	`note_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
