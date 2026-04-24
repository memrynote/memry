CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`remind_at` text NOT NULL,
	`highlight_text` text,
	`highlight_start` integer,
	`highlight_end` integer,
	`title` text,
	`note` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`triggered_at` text,
	`dismissed_at` text,
	`snoozed_until` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`modified_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reminders_target` ON `reminders` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `idx_reminders_remind_at` ON `reminders` (`remind_at`);--> statement-breakpoint
CREATE INDEX `idx_reminders_status` ON `reminders` (`status`);