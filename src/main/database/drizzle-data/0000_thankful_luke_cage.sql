CREATE TABLE IF NOT EXISTS `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text DEFAULT '#6366f1' NOT NULL,
	`icon` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_inbox` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`modified_at` text DEFAULT (datetime('now')) NOT NULL,
	`archived_at` text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `statuses` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#6b7280' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_done` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_statuses_project` ON `statuses` (`project_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`status_id` text,
	`parent_id` text,
	`title` text NOT NULL,
	`description` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`due_date` text,
	`due_time` text,
	`start_date` text,
	`repeat_config` text,
	`repeat_from` text,
	`source_note_id` text,
	`completed_at` text,
	`archived_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`modified_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`status_id`) REFERENCES `statuses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_project` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_status` ON `tasks` (`status_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_parent` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_due_date` ON `tasks` (`due_date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_completed` ON `tasks` (`completed_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_notes` (
	`task_id` text NOT NULL,
	`note_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`task_id`, `note_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `task_tags` (
	`task_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`task_id`, `tag`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_tags_tag` ON `task_tags` (`tag`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`content` text NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`filed_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_inbox_type` ON `inbox_items` (`type`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `saved_filters` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`modified_at` text DEFAULT (datetime('now')) NOT NULL
);
