CREATE TABLE IF NOT EXISTS `note_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`emoji` text,
	`content_hash` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`modified_at` text NOT NULL,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `note_cache_path_unique` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_cache_path` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_cache_modified` ON `note_cache` (`modified_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `note_links` (
	`source_id` text NOT NULL,
	`target_id` text,
	`target_title` text NOT NULL,
	PRIMARY KEY(`source_id`, `target_title`),
	FOREIGN KEY (`source_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_links_target` ON `note_links` (`target_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `note_properties` (
	`note_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text,
	`type` text NOT NULL,
	PRIMARY KEY(`note_id`, `name`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_properties_name` ON `note_properties` (`name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_properties_value` ON `note_properties` (`value`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `note_tags` (
	`note_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`note_id`, `tag`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_tags_tag` ON `note_tags` (`tag`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `property_definitions` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`default_value` text,
	`color` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
