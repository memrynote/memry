CREATE TABLE `portal_refs` (
	`host_note_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`source_note_id` text,
	`anchor` text,
	`hidden_count` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`host_note_id`, `ordinal`)
);
--> statement-breakpoint
CREATE INDEX `idx_portal_refs_source` ON `portal_refs` (`source_note_id`,`anchor`);
