CREATE TABLE IF NOT EXISTS `custom_icons` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`ext` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`clock` text,
	`synced_at` text
);
