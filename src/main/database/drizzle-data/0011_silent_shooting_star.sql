ALTER TABLE `inbox_items` ADD `clock` text;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `synced_at` text;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `local_only` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `saved_filters` ADD `clock` text;--> statement-breakpoint
ALTER TABLE `saved_filters` ADD `synced_at` text;