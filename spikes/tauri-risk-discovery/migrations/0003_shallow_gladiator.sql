CREATE TABLE `suggestion_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`item_type` text NOT NULL,
	`suggested_to` text NOT NULL,
	`actual_to` text NOT NULL,
	`accepted` integer NOT NULL,
	`confidence` integer NOT NULL,
	`suggested_tags` text,
	`actual_tags` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_suggestion_feedback_item_type` ON `suggestion_feedback` (`item_type`);--> statement-breakpoint
CREATE INDEX `idx_suggestion_feedback_accepted` ON `suggestion_feedback` (`accepted`);--> statement-breakpoint
CREATE INDEX `idx_suggestion_feedback_created` ON `suggestion_feedback` (`created_at`);