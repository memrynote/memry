-- Canvas folders: placement + icon for canvases.
--
-- Additive only. Existing `canvases` rows keep NULL in both new columns, which
-- already means "root, no icon" — exactly what every pre-folder canvas is. No
-- backfill, no DELETE, no reset. An older app version ignores both the columns
-- and the table, so a rollback still opens every canvas from its file_path.
--
-- `canvas_folders.id` is derived from `path` (`cvf_` || NFC-lowercased path,
-- see canvasFolderSyncId in packages/contracts/src/canvas-folder-types.ts).
-- Nothing is inserted here, so there is no SQL copy of that expression to drift
-- — but the unique index below is what makes the derivation load-bearing: two
-- devices creating `Work/` offline must mint the SAME id or they collide here.
--
-- Hand-written (project switched off Drizzle generator after 0020).
ALTER TABLE `canvases` ADD `folder` text;
--> statement-breakpoint
ALTER TABLE `canvases` ADD `icon` text;
--> statement-breakpoint
CREATE TABLE `canvas_folders` (
	`id` text PRIMARY KEY NOT NULL,
	`vault_id` text NOT NULL,
	`path` text NOT NULL,
	`icon` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	`clock` text,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canvas_folders_vault_path_idx` ON `canvas_folders` (`vault_id`,`path`);
