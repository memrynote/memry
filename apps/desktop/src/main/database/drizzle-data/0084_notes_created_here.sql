-- Notes the app's create command made on this device (#5371). One row per note
-- id, written only by `createNoteCommand`; the vault ingest and the file watcher
-- never write one. An in-memory editor open seeds a never-synced note offline
-- only with a row here.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table, so every note created before the
-- upgrade has no row and keeps the read-only exit.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. Re-upgrading finds the rows still there.
--
-- No foreign key: the note row can be deleted while the marker stands.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `notes_created_here` (
	`note_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
