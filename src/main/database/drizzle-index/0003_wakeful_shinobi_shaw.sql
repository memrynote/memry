CREATE TABLE IF NOT EXISTS `journal_cache` (
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
CREATE UNIQUE INDEX IF NOT EXISTS `journal_cache_date_unique` ON `journal_cache` (`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_journal_date` ON `journal_cache` (`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_journal_activity` ON `journal_cache` (`activity_level`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_journal_modified` ON `journal_cache` (`modified_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `journal_tags` (
	`entry_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`entry_id`, `tag`),
	FOREIGN KEY (`entry_id`) REFERENCES `journal_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_journal_tags_tag` ON `journal_tags` (`tag`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_journal_tags_entry` ON `journal_tags` (`entry_id`);
