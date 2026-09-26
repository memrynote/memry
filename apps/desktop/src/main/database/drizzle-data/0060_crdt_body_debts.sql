-- Notes and journals whose server CRDT body this device knows it has not
-- merged (#2297). One row per CRDT document id.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs upgrade by gaining an empty table; every existing row is untouched.
-- The first sync engine start after the upgrade converts a standing
-- `crdtUnmergedDebt = '1'` in `sync_state` into one row per note.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table. The build that owns this table keeps
-- `crdtUnmergedDebt` as a mirror of "the table is non-empty", which is what an
-- older build reads.
--
-- `lowest_cursor` NULL means the whole body is owed; a merge of two debts keeps
-- the lower cursor, and NULL wins. `generation` rises with every debt raised,
-- and a pull settles only debts at or below the generation it started at.
-- `last_failed_at` and `failures` space out retries of a failing pull;
-- `needs_walk` marks a debt whose cause showed the snapshot watermark ahead of
-- the doc, so only a full walk may settle it; `updated_at` is for logs only.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `crdt_body_debts` (
	`note_id` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`lowest_cursor` integer,
	`generation` integer NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_failed_at` integer,
	`needs_walk` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
