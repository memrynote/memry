CREATE TABLE `folder_configs` (
	`path` text PRIMARY KEY NOT NULL,
	`icon` text,
	`clock` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
