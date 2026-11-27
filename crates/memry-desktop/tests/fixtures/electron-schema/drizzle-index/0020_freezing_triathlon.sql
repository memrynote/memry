CREATE TABLE `property_refs` (
	`source_note_id` text NOT NULL,
	`property_name` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	PRIMARY KEY(`source_note_id`, `property_name`, `target_type`, `target_id`),
	FOREIGN KEY (`source_note_id`) REFERENCES `note_cache`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_property_refs_target` ON `property_refs` (`target_type`,`target_id`);