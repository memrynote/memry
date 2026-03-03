CREATE TABLE IF NOT EXISTS `note_snapshots` (
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
CREATE INDEX IF NOT EXISTS `idx_note_snapshots_note_id` ON `note_snapshots` (`note_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_note_snapshots_created` ON `note_snapshots` (`created_at`);
