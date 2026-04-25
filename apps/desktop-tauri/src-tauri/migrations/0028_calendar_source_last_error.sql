-- Port of apps/desktop/src/main/database/drizzle-data/0028_calendar_source_last_error.sql
-- Hand-written Electron migration; identifiers unbacktick'd.

ALTER TABLE calendar_sources ADD COLUMN last_error text;
