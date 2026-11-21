CREATE TABLE `bookmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_bookmarks_unique_item` ON `bookmarks` (`item_type`,`item_id`);--> statement-breakpoint
CREATE INDEX `idx_bookmarks_item_type` ON `bookmarks` (`item_type`);--> statement-breakpoint
CREATE INDEX `idx_bookmarks_position` ON `bookmarks` (`position`);--> statement-breakpoint
CREATE INDEX `idx_bookmarks_created` ON `bookmarks` (`created_at`);