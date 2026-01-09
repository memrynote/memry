PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_note_cache` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
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
);
--> statement-breakpoint
INSERT INTO `__new_note_cache`("id", "path", "title", "file_type", "mime_type", "file_size", "emoji", "content_hash", "word_count", "character_count", "snippet", "date", "created_at", "modified_at", "indexed_at") SELECT "id", "path", "title", "file_type", "mime_type", "file_size", "emoji", "content_hash", "word_count", "character_count", "snippet", "date", "created_at", "modified_at", "indexed_at" FROM `note_cache`;--> statement-breakpoint
DROP TABLE `note_cache`;--> statement-breakpoint
ALTER TABLE `__new_note_cache` RENAME TO `note_cache`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `note_cache_path_unique` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_path` ON `note_cache` (`path`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_modified` ON `note_cache` (`modified_at`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_date` ON `note_cache` (`date`);--> statement-breakpoint
CREATE INDEX `idx_note_cache_file_type` ON `note_cache` (`file_type`);