CREATE TABLE `note_embeddings` (
	`note_id` text PRIMARY KEY NOT NULL,
	`embedding` blob NOT NULL,
	`model` text NOT NULL,
	`content_hash` text NOT NULL,
	`computed_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_note_embeddings_model` ON `note_embeddings` (`model`);