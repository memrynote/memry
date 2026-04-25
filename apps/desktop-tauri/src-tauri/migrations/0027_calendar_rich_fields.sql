-- Port of apps/desktop/src/main/database/drizzle-data/0027_calendar_rich_fields.sql
-- Hand-written Electron migration; Drizzle `--> statement-breakpoint` markers stripped;
-- identifiers unbacktick'd.

ALTER TABLE calendar_events ADD COLUMN attendees text;
ALTER TABLE calendar_events ADD COLUMN reminders text;
ALTER TABLE calendar_events ADD COLUMN visibility text;
ALTER TABLE calendar_events ADD COLUMN color_id text;
ALTER TABLE calendar_events ADD COLUMN conference_data text;
ALTER TABLE calendar_events ADD COLUMN parent_event_id text;
ALTER TABLE calendar_events ADD COLUMN original_start_time text;
ALTER TABLE calendar_external_events ADD COLUMN attendees text;
ALTER TABLE calendar_external_events ADD COLUMN reminders text;
ALTER TABLE calendar_external_events ADD COLUMN visibility text;
ALTER TABLE calendar_external_events ADD COLUMN color_id text;
ALTER TABLE calendar_external_events ADD COLUMN conference_data text;
