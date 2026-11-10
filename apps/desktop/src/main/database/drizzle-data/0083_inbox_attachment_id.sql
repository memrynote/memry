-- An inbox capture's file now syncs (#4157). `attachment_id` is the sync
-- attachment id of the bytes at `attachment_path`; it rides the whole-row push
-- as `attachmentId` and a remote payload never clears it. `inbox_attachment_uploads`
-- is the device-local "upload pending" mark, a table of its own so the flag never
-- travels in the pushed row.
--
-- Additive only. One nullable column, one new empty table, no backfill: items
-- captured before this build never upload, so their files stay on the device
-- that captured them, as before.
--
-- A downgrade is inert: an older build never selects the column (Drizzle lists
-- columns explicitly) or the table, and its newest journal `when` is lower than
-- this one's, so its migrator applies nothing.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
ALTER TABLE `inbox_items` ADD COLUMN `attachment_id` text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inbox_attachment_uploads` (
	`item_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
