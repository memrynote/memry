-- The note-attachment files this device knows the server has (#2651). One row
-- per (note, vault-relative path), written when an upload succeeds or a
-- download lands. The backfill queues a file a note owns or embeds only when
-- no row knows it, so a new file on a note that already holds references is
-- uploaded while one already up is not.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; the app fills it lazily, counting
-- an older note's files the first time it sees the note, so nothing that is
-- already on disk is uploaded again.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. Re-upgrading finds the rows still there.
--
-- No foreign key: a note can be deleted while its rows stand.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `attachment_files` (
	`note_id` text NOT NULL,
	`path` text NOT NULL,
	`attachment_id` text,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`note_id`, `path`)
);
