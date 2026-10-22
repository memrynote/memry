CREATE TABLE IF NOT EXISTS `note_embedding_state` (
	`note_id` text PRIMARY KEY NOT NULL,
	`input_version` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
