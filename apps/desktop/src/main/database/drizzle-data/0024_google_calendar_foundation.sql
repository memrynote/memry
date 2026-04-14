CREATE TABLE `calendar_events` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`start_at` text NOT NULL,
	`end_at` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`is_all_day` integer DEFAULT false NOT NULL,
	`recurrence_rule` text,
	`recurrence_exceptions` text,
	`archived_at` text,
	`clock` text,
	`synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_calendar_events_start_at` ON `calendar_events` (`start_at`);
--> statement-breakpoint
CREATE INDEX `idx_calendar_events_archived_at` ON `calendar_events` (`archived_at`);
--> statement-breakpoint
CREATE TABLE `calendar_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`account_id` text,
	`remote_id` text NOT NULL,
	`title` text NOT NULL,
	`timezone` text,
	`color` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`is_selected` integer DEFAULT false NOT NULL,
	`is_memry_managed` integer DEFAULT false NOT NULL,
	`sync_cursor` text,
	`sync_status` text DEFAULT 'idle' NOT NULL,
	`last_synced_at` text,
	`metadata` text,
	`archived_at` text,
	`clock` text,
	`synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_calendar_sources_provider_remote` ON `calendar_sources` (`provider`,`kind`,`remote_id`);
--> statement-breakpoint
CREATE INDEX `idx_calendar_sources_account` ON `calendar_sources` (`account_id`);
--> statement-breakpoint
CREATE INDEX `idx_calendar_sources_selected` ON `calendar_sources` (`is_selected`);
--> statement-breakpoint
CREATE TABLE `calendar_external_events` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`remote_event_id` text NOT NULL,
	`remote_etag` text,
	`remote_updated_at` text,
	`title` text NOT NULL,
	`description` text,
	`location` text,
	`start_at` text NOT NULL,
	`end_at` text,
	`timezone` text,
	`is_all_day` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`recurrence_rule` text,
	`raw_payload` text,
	`archived_at` text,
	`clock` text,
	`synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `calendar_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_calendar_external_events_source_remote` ON `calendar_external_events` (`source_id`,`remote_event_id`);
--> statement-breakpoint
CREATE INDEX `idx_calendar_external_events_start_at` ON `calendar_external_events` (`start_at`);
--> statement-breakpoint
CREATE INDEX `idx_calendar_external_events_archived_at` ON `calendar_external_events` (`archived_at`);
--> statement-breakpoint
CREATE TABLE `calendar_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`provider` text NOT NULL,
	`remote_calendar_id` text NOT NULL,
	`remote_event_id` text NOT NULL,
	`ownership_mode` text NOT NULL,
	`writeback_mode` text NOT NULL,
	`remote_version` text,
	`last_local_snapshot` text,
	`archived_at` text,
	`clock` text,
	`synced_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`modified_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_calendar_bindings_source` ON `calendar_bindings` (`source_type`,`source_id`,`provider`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_calendar_bindings_remote` ON `calendar_bindings` (`provider`,`remote_calendar_id`,`remote_event_id`);
--> statement-breakpoint
CREATE INDEX `idx_calendar_bindings_source_type` ON `calendar_bindings` (`source_type`);
--> statement-breakpoint
CREATE INDEX `idx_calendar_bindings_archived_at` ON `calendar_bindings` (`archived_at`);
