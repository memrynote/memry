CREATE TABLE `note_cache` (
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
CREATE UNIQUE INDEX `note_cache_path_unique` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_path` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_modified` ON `note_cache` (`modified_at`);--> statement-breakpoint
CREATE TABLE `note_links` (
	`source_id` text NOT NULL,
	`target_id` text,
	`target_title` text NOT NULL,
	PRIMARY KEY(`source_id`, `target_title`),
	FOREIGN KEY (`source_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_note_links_target` ON `note_links` (`target_id`);--> statement-breakpoint
CREATE TABLE `note_properties` (
	`note_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text,
	`type` text NOT NULL,
	PRIMARY KEY(`note_id`, `name`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_note_properties_name` ON `note_properties` (`name`);--> statement-breakpoint
CREATE INDEX `idx_note_properties_value` ON `note_properties` (`value`);--> statement-breakpoint
CREATE TABLE `note_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`content` text NOT NULL,
	`title` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`content_hash` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_note_snapshots_note_id` ON `note_snapshots` (`note_id`);--> statement-breakpoint
CREATE INDEX `idx_note_snapshots_created` ON `note_snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `note_tags` (
	`note_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`note_id`, `tag`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_note_tags_tag` ON `note_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `property_definitions` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`default_value` text,
	`color` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tag_definitions` (
	`name` text PRIMARY KEY NOT NULL,
	`color` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `journal_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`path` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`character_count` integer DEFAULT 0 NOT NULL,
	`activity_level` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`modified_at` text NOT NULL,
	`indexed_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_cache_date_unique` ON `journal_cache` (`date`);--> statement-breakpoint
CREATE INDEX `idx_journal_date` ON `journal_cache` (`date`);--> statement-breakpoint
CREATE INDEX `idx_journal_activity` ON `journal_cache` (`activity_level`);--> statement-breakpoint
CREATE INDEX `idx_journal_modified` ON `journal_cache` (`modified_at`);--> statement-breakpoint
CREATE TABLE `journal_tags` (
	`entry_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`entry_id`, `tag`),
	FOREIGN KEY (`entry_id`) REFERENCES `journal_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_journal_tags_tag` ON `journal_tags` (`tag`);--> statement-breakpoint
CREATE INDEX `idx_journal_tags_entry` ON `journal_tags` (`entry_id`);