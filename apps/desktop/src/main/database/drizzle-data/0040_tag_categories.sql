CREATE TABLE IF NOT EXISTS `tag_categories` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `clock` text,
  `created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
  `deleted_at` text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tag_categories_sort` ON `tag_categories` (`sort_order`);
--> statement-breakpoint
ALTER TABLE `tag_definitions` ADD `category_id` text;
--> statement-breakpoint
ALTER TABLE `tag_definitions` ADD `sort_order` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tag_definitions_category` ON `tag_definitions` (`category_id`);
