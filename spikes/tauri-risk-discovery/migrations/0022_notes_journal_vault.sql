CREATE TABLE `note_metadata` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`emoji` text,
	`file_type` text DEFAULT 'markdown' NOT NULL,
	`mime_type` text,
	`file_size` integer,
	`attachment_id` text,
	`attachment_references` text,
	`local_only` integer DEFAULT false NOT NULL,
	`sync_policy` text DEFAULT 'sync' NOT NULL,
	`journal_date` text,
	`property_definition_names` text,
	`clock` text,
	`synced_at` text,
	`created_at` text NOT NULL,
	`modified_at` text NOT NULL,
	`stored_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_note_metadata_path` ON `note_metadata` (`path`);
--> statement-breakpoint
CREATE INDEX `idx_note_metadata_modified` ON `note_metadata` (`modified_at`);
--> statement-breakpoint
CREATE INDEX `idx_note_metadata_journal_date` ON `note_metadata` (`journal_date`);
--> statement-breakpoint
CREATE INDEX `idx_note_metadata_local_only` ON `note_metadata` (`local_only`);
--> statement-breakpoint
CREATE TABLE `property_definitions` (
	`name` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`default_value` text,
	`color` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
