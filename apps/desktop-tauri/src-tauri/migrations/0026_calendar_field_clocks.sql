-- Port of apps/desktop/src/main/database/drizzle-data/0026_calendar_field_clocks.sql
-- Hand-written Electron migration; identifiers unbacktick'd.

ALTER TABLE calendar_events ADD COLUMN field_clocks text;
