CREATE TABLE IF NOT EXISTS `image_embedding_state` (
	`note_id` text NOT NULL,
	`source` text DEFAULT '' NOT NULL,
	`signature` text NOT NULL,
	`input_version` integer NOT NULL,
	PRIMARY KEY(`note_id`, `source`),
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
