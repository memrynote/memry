-- Notes and journals whose change-feed body this device dropped because no row
-- existed for the id yet (#2421). One row per CRDT document id.
--
-- Not a debt: nothing pulls a row here. It keeps a later record of the id on
-- its whole-body pull and the note off snapshot claims, until the whole-body
-- walk of the note merges or a delete tombstone for the id applies.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. Re-upgrading finds the rows still there.
--
-- No foreign key: the row describes an id that has no note row.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `crdt_body_withheld` (
	`note_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
