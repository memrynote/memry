ALTER TABLE `note_cache` ADD `file_type` text DEFAULT 'markdown' NOT NULL;--> statement-breakpoint
ALTER TABLE `note_cache` ADD `mime_type` text;--> statement-breakpoint
ALTER TABLE `note_cache` ADD `file_size` integer;--> statement-breakpoint
CREATE INDEX `idx_note_cache_file_type` ON `note_cache` (`file_type`);
