CREATE TABLE `crdt_sequence_state` (
	`note_id` text PRIMARY KEY NOT NULL,
	`last_known_sequence` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
