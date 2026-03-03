CREATE TABLE `note_positions` (
	`path` text PRIMARY KEY NOT NULL,
	`folder_path` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_note_positions_folder` ON `note_positions` (`folder_path`);--> statement-breakpoint
CREATE INDEX `idx_note_positions_order` ON `note_positions` (`folder_path`,`position`);