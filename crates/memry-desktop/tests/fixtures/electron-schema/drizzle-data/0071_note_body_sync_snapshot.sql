-- When the server last stored a note's whole doc state (#2778). A refused body
-- push drops its rows, so a later accepted update does not carry the refused
-- text; only a stored snapshot does. The refused state now clears only on
-- `last_snapshot_at`, while `last_confirmed_at` keeps moving with every
-- accepted push.
--
-- Additive only. One nullable column. The backfill copies `last_confirmed_at`
-- so every existing row reads exactly as it did before the upgrade: a note
-- that read confirmed stays confirmed, a note that read rejected stays
-- rejected. No other column or row is touched.
--
-- A downgrade is inert: an older build selects and inserts only its own
-- columns (Drizzle lists columns explicitly), and its migrator applies nothing
-- past its own journal.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
ALTER TABLE `note_body_sync` ADD COLUMN `last_snapshot_at` integer;
--> statement-breakpoint
UPDATE `note_body_sync` SET `last_snapshot_at` = `last_confirmed_at`;
