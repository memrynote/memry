CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`os_version` text,
	`app_version` text NOT NULL,
	`linked_at` text NOT NULL,
	`last_sync_at` text,
	`is_current_device` integer DEFAULT false
);
--> statement-breakpoint
CREATE TABLE `sync_history` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`item_count` integer NOT NULL,
	`direction` text,
	`details` text,
	`duration_ms` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sync_history_created` ON `sync_history` (`created_at`);--> statement-breakpoint
CREATE TABLE `sync_queue` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`item_id` text NOT NULL,
	`operation` text NOT NULL,
	`payload` text NOT NULL,
	`priority` integer DEFAULT 0,
	`attempts` integer DEFAULT 0,
	`last_attempt` text,
	`error_message` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sync_queue_type` ON `sync_queue` (`type`);--> statement-breakpoint
CREATE INDEX `idx_sync_queue_created` ON `sync_queue` (`created_at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
