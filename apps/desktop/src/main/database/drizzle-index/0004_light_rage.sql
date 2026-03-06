CREATE TABLE `journal_properties` (
	`entry_id` text NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`type` text NOT NULL,
	PRIMARY KEY(`entry_id`, `name`),
	FOREIGN KEY (`entry_id`) REFERENCES `journal_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_journal_props_entry` ON `journal_properties` (`entry_id`);--> statement-breakpoint
CREATE INDEX `idx_journal_props_name` ON `journal_properties` (`name`);