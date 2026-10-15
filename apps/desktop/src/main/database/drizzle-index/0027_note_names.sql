CREATE TABLE IF NOT EXISTS `note_names` (
	`note_id` text NOT NULL,
	`key` text NOT NULL,
	`display` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`note_id`, `key`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_names_key` ON `note_names` (`key`);--> statement-breakpoint
ALTER TABLE `note_links` ADD `target_key` text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_links_target_key` ON `note_links` (`target_key`);
