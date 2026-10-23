CREATE TABLE IF NOT EXISTS `note_fold_chunks` (
	`chunk_hash` text NOT NULL,
	`language` text NOT NULL,
	`model_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`chunk_hash`, `language`, `model_id`)
);
