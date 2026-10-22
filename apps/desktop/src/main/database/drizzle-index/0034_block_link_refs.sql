CREATE TABLE `block_link_refs` (
	`source_note_id` text NOT NULL,
	`target_key` text NOT NULL,
	`anchor` text NOT NULL,
	PRIMARY KEY(`source_note_id`, `target_key`, `anchor`)
);
--> statement-breakpoint
CREATE INDEX `idx_block_link_refs_target` ON `block_link_refs` (`target_key`,`anchor`);
