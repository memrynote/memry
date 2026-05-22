CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`selected_quote` text NOT NULL,
	`block_id` text,
	`range_start` integer,
	`range_end` integer,
	`prefix` text,
	`suffix` text,
	`body` text DEFAULT '' NOT NULL,
	`attachment_refs` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`clock` text,
	`synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comments_target` ON `comments` (`target_type`,`target_id`);
--> statement-breakpoint
CREATE INDEX `idx_comments_target_status` ON `comments` (`target_type`,`target_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_comments_status` ON `comments` (`status`);
