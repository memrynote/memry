CREATE TABLE `tag_definitions` (
	`name` text PRIMARY KEY NOT NULL,
	`color` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
