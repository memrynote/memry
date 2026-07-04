PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_note_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`file_type` text DEFAULT 'markdown' NOT NULL,
	`mime_type` text,
	`file_size` integer,
	`attachment_id` text,
	`emoji` text,
	`local_only` integer DEFAULT false,
	`content_hash` text,
	`word_count` integer,
	`character_count` integer,
	`snippet` text,
	`date` text,
	`clock` text,
	`synced_at` text,
	`created_at` text NOT NULL,
	`modified_at` text NOT NULL,
	`indexed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_note_cache`("id", "path", "title", "file_type", "mime_type", "file_size", "attachment_id", "emoji", "local_only", "content_hash", "word_count", "character_count", "snippet", "date", "clock", "synced_at", "created_at", "modified_at", "indexed_at") SELECT "id", "path", "title", "file_type", "mime_type", "file_size", "attachment_id", "emoji", "local_only", "content_hash", "word_count", "character_count", "snippet", "date", "clock", "synced_at", "created_at", "modified_at", "indexed_at" FROM `note_cache`;--> statement-breakpoint
DROP TABLE `note_cache`;--> statement-breakpoint
ALTER TABLE `__new_note_cache` RENAME TO `note_cache`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `note_cache_path_unique` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_path` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_modified` ON `note_cache` (`modified_at`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_date` ON `note_cache` (`date`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_file_type` ON `note_cache` (`file_type`);--> statement-breakpoint
CREATE TABLE `__new_note_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`content` text NOT NULL,
	`title` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`content_hash` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_note_snapshots`("id", "note_id", "content", "title", "word_count", "content_hash", "reason", "created_at") SELECT "id", "note_id", "content", "title", "word_count", "content_hash", "reason", "created_at" FROM `note_snapshots`;--> statement-breakpoint
DROP TABLE `note_snapshots`;--> statement-breakpoint
ALTER TABLE `__new_note_snapshots` RENAME TO `note_snapshots`;--> statement-breakpoint
CREATE INDEX `idx_note_snapshots_note_id` ON `note_snapshots` (`note_id`);--> statement-breakpoint
CREATE INDEX `idx_note_snapshots_created` ON `note_snapshots` (`created_at`);--> statement-breakpoint
CREATE TABLE `__new_note_tags` (
	`note_id` text NOT NULL,
	`tag` text COLLATE NOCASE NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`pinned_at` text,
	PRIMARY KEY(`note_id`, `tag`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_note_tags`("note_id", "tag", "position", "pinned_at") SELECT "note_id", "tag", "position", "pinned_at" FROM `note_tags`;--> statement-breakpoint
DROP TABLE `note_tags`;--> statement-breakpoint
ALTER TABLE `__new_note_tags` RENAME TO `note_tags`;--> statement-breakpoint
CREATE INDEX `idx_note_tags_tag` ON `note_tags` (`tag`);--> statement-breakpoint
CREATE INDEX `idx_note_tags_pinned` ON `note_tags` (`pinned_at`);--> statement-breakpoint
CREATE TABLE `__new_property_definitions` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`default_value` text,
	`color` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_property_definitions`("name", "type", "options", "default_value", "color", "created_at") SELECT "name", "type", "options", "default_value", "color", "created_at" FROM `property_definitions`;--> statement-breakpoint
DROP TABLE `property_definitions`;--> statement-breakpoint
ALTER TABLE `__new_property_definitions` RENAME TO `property_definitions`;