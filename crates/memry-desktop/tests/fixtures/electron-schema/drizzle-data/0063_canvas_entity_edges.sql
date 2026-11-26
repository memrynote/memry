-- Canvas arrows between two cards, indexed as connections (#2482). One row per
-- bound arrow: the arrow's start card and end card, both as entity refs.
--
-- Advisory, like `canvas_entity_refs`: the `.excalidraw` file is the truth and
-- every row is rewritten from it on save, on sync apply, and on vault open. No
-- sync type, no payload change, no file format change.
--
-- Additive only. One new table and two indexes, no ALTER, no backfill here, no
-- DELETE. Existing installs upgrade by gaining an empty table; the next vault
-- open fills it from the canvas files. Every existing row is untouched.
--
-- A downgrade is inert: an older build never reads or writes the table. Its max
-- journal `when` is lower than this one's, so its migrator applies nothing and
-- Drizzle never drops the table.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
CREATE TABLE IF NOT EXISTS `canvas_entity_edges` (
	`canvas_id` text NOT NULL,
	`arrow_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY (`canvas_id`, `arrow_id`),
	FOREIGN KEY (`canvas_id`) REFERENCES `canvases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_edges_source` ON `canvas_entity_edges` (`source_type`, `source_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_canvas_edges_target` ON `canvas_entity_edges` (`target_type`, `target_id`);
