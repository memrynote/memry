PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_tags` (
	`task_id` text NOT NULL,
	`tag` text COLLATE NOCASE NOT NULL,
	PRIMARY KEY(`task_id`, `tag`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT OR IGNORE INTO `__new_task_tags`("task_id", "tag") SELECT "task_id", "tag" FROM `task_tags`;--> statement-breakpoint
DROP TABLE `task_tags`;--> statement-breakpoint
ALTER TABLE `__new_task_tags` RENAME TO `task_tags`;--> statement-breakpoint
CREATE INDEX `idx_task_tags_tag` ON `task_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `__new_inbox_item_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`tag` text COLLATE NOCASE NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT OR IGNORE INTO `__new_inbox_item_tags`("id", "item_id", "tag", "created_at") SELECT "id", "item_id", "tag", "created_at" FROM `inbox_item_tags`;--> statement-breakpoint
DROP TABLE `inbox_item_tags`;--> statement-breakpoint
ALTER TABLE `__new_inbox_item_tags` RENAME TO `inbox_item_tags`;--> statement-breakpoint
CREATE INDEX `idx_inbox_tags_item` ON `inbox_item_tags` (`item_id`);--> statement-breakpoint
CREATE INDEX `idx_inbox_tags_tag` ON `inbox_item_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `__new_tag_definitions` (
	`name` text COLLATE NOCASE PRIMARY KEY NOT NULL,
	`color` text NOT NULL,
	`icon` text,
	`clock` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);--> statement-breakpoint
INSERT OR IGNORE INTO `__new_tag_definitions`("name", "color", "icon", "clock", "created_at") SELECT "name", "color", "icon", "clock", "created_at" FROM `tag_definitions`;--> statement-breakpoint
DROP TABLE `tag_definitions`;--> statement-breakpoint
ALTER TABLE `__new_tag_definitions` RENAME TO `tag_definitions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
