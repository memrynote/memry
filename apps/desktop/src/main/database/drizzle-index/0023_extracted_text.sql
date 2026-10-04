CREATE TABLE IF NOT EXISTS `extracted_text` (
	`note_id` text NOT NULL,
	`part` integer NOT NULL,
	`method` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`note_id`, `part`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `file_text_jobs` (
	`note_id` text PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`status` text NOT NULL,
	`page_count` integer,
	`error` text,
	`app_version` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
