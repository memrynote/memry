ALTER TABLE `calendar_events` ADD COLUMN `attendees` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD COLUMN `reminders` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD COLUMN `visibility` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD COLUMN `color_id` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD COLUMN `conference_data` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD COLUMN `parent_event_id` text;
--> statement-breakpoint
ALTER TABLE `calendar_events` ADD COLUMN `original_start_time` text;
--> statement-breakpoint
ALTER TABLE `calendar_external_events` ADD COLUMN `attendees` text;
--> statement-breakpoint
ALTER TABLE `calendar_external_events` ADD COLUMN `reminders` text;
--> statement-breakpoint
ALTER TABLE `calendar_external_events` ADD COLUMN `visibility` text;
--> statement-breakpoint
ALTER TABLE `calendar_external_events` ADD COLUMN `color_id` text;
--> statement-breakpoint
ALTER TABLE `calendar_external_events` ADD COLUMN `conference_data` text;
