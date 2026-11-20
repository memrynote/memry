-- Stored assets of notes and canvases this device deleted, freed on the server
-- once the 30-day grace period after the delete has passed (#3015). One row
-- per (item type, item id). The row outlives restarts, so the grace period is
-- measured from the delete, not from the last app start.
--
-- Additive only. One new table, no ALTER, no backfill, no DELETE. Existing
-- installs gain an empty table, so items deleted before this build keep their
-- assets, as they did before.
--
-- A downgrade is inert: an older build never reads or writes the table, its
-- max journal `when` is lower than this one's, so its migrator applies nothing
-- and Drizzle never drops the table.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `deleted_asset_releases` (
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`deleted_at` integer NOT NULL,
	`attachment_ids` text,
	PRIMARY KEY(`item_type`, `item_id`)
);
