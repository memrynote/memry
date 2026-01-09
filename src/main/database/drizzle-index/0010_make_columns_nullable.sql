DROP TABLE IF EXISTS `note_links`;--> statement-breakpoint
DROP TABLE IF EXISTS `note_properties`;--> statement-breakpoint
DROP TABLE IF EXISTS `note_tags`;--> statement-breakpoint
DROP TABLE IF EXISTS `note_snapshots`;--> statement-breakpoint
DROP TABLE IF EXISTS `note_cache`;--> statement-breakpoint
CREATE TABLE `note_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`file_type` text DEFAULT 'markdown' NOT NULL,
	`mime_type` text,
	`file_size` integer,
	`emoji` text,
	`content_hash` text,
	`word_count` integer,
	`character_count` integer,
	`snippet` text,
	`date` text,
	`created_at` text NOT NULL,
	`modified_at` text NOT NULL,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_note_cache_path` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_modified` ON `note_cache` (`modified_at`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_date` ON `note_cache` (`date`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_file_type` ON `note_cache` (`file_type`);--> statement-breakpoint
CREATE TABLE `note_tags` (
	`note_id` text NOT NULL,
	`tag` text NOT NULL,
	`pinned_at` text,
	PRIMARY KEY(`note_id`, `tag`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_note_tags_tag` ON `note_tags` (`tag`);--> statement-breakpoint
CREATE INDEX `idx_note_tags_pinned` ON `note_tags` (`pinned_at`);--> statement-breakpoint
CREATE TABLE `note_links` (
	`source_id` text NOT NULL,
	`target_id` text,
	`target_title` text NOT NULL,
	PRIMARY KEY(`source_id`, `target_title`),
	FOREIGN KEY (`source_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_note_links_target` ON `note_links` (`target_id`);--> statement-breakpoint
CREATE TABLE `note_properties` (
	`note_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text,
	`type` text NOT NULL,
	PRIMARY KEY(`note_id`, `name`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_note_properties_name` ON `note_properties` (`name`);--> statement-breakpoint
CREATE INDEX `idx_note_properties_value` ON `note_properties` (`value`);--> statement-breakpoint
CREATE TABLE `note_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`content` text NOT NULL,
	`content_hash` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`character_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`reason` text DEFAULT 'auto' NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_note_snapshots_note_id` ON `note_snapshots` (`note_id`);--> statement-breakpoint
CREATE INDEX `idx_note_snapshots_created_at` ON `note_snapshots` (`created_at`);
