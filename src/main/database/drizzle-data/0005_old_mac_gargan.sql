ALTER TABLE `inbox_items` ADD `viewed_at` text;--> statement-breakpoint
ALTER TABLE `inbox_stats` ADD `capture_count_reminder` integer DEFAULT 0;