-- Port of apps/desktop/src/main/database/drizzle-data/0025_event_target_calendar.sql
-- Hand-written Electron migration; identifiers unbacktick'd.

ALTER TABLE calendar_events ADD COLUMN target_calendar_id text;
