CREATE TABLE `project_links` (
  `id` text PRIMARY KEY NOT NULL,
  `project_id` text NOT NULL,
  `item_type` text NOT NULL,
  `item_id` text NOT NULL,
  `position` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_project_links_unique` ON `project_links` (`project_id`,`item_type`,`item_id`);
--> statement-breakpoint
CREATE INDEX `idx_project_links_project` ON `project_links` (`project_id`,`item_type`);
--> statement-breakpoint
CREATE INDEX `idx_project_links_item` ON `project_links` (`item_id`,`item_type`);
--> statement-breakpoint
ALTER TABLE `projects` ADD `home_note_id` text;
