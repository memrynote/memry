-- Port of apps/desktop/src/main/database/drizzle-data/0015_brief_hex.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.

ALTER TABLE projects ADD clock text;
ALTER TABLE projects ADD synced_at text;
