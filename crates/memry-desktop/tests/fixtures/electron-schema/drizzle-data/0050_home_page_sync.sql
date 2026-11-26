-- Home boards sync across devices (#1380).
--
-- Additive only. Two nullable columns on an existing table, no backfill, no
-- DELETE, no rewrite of any row. Existing installs upgrade by gaining two NULLs.
--
-- A NULL `clock` is exactly what `home-page-handler.seedUnclocked` keys on, so
-- every board that already exists on a live-beta device is picked up on the
-- first sync run after upgrade and pushed to the account — nothing is orphaned.
--
-- Rollback is inert: both columns are nullable and every query in the older
-- build is column-listed, so an older Drizzle model simply never reads them.
-- Its max journal `when` is lower than this one's, so its migrator applies
-- nothing and Drizzle never drops the columns. Boards keep working there, they
-- just stop syncing; re-upgrading resumes from the clocks still in the row.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
ALTER TABLE `home_pages` ADD `clock` text;--> statement-breakpoint
ALTER TABLE `home_pages` ADD `synced_at` text;
