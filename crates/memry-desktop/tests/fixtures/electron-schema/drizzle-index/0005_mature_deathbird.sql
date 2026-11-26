ALTER TABLE `note_cache` ADD `character_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `note_cache` ADD `date` text;--> statement-breakpoint
CREATE INDEX `idx_note_cache_date` ON `note_cache` (`date`);