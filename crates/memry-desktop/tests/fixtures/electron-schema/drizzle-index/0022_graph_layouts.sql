CREATE TABLE IF NOT EXISTS `graph_layouts` (
	`view_key` text PRIMARY KEY NOT NULL,
	`positions` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
