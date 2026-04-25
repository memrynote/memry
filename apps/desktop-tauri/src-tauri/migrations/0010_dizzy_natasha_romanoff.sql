-- Port of apps/desktop/src/main/database/drizzle-data/0010_dizzy_natasha_romanoff.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.

ALTER TABLE tasks ADD clock text;
ALTER TABLE tasks ADD synced_at text;
