-- Port of apps/desktop/src/main/database/drizzle-data/0017_spotty_mongu.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.
-- Phase 8 field-level vector clocks: adds field_clocks JSON column to projects + tasks.

ALTER TABLE projects ADD field_clocks text;
ALTER TABLE tasks ADD field_clocks text;
