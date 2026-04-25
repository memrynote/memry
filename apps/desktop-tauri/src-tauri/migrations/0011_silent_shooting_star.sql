-- Port of apps/desktop/src/main/database/drizzle-data/0011_silent_shooting_star.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd;
-- boolean DEFAULT literal `false` normalized to integer 0.

ALTER TABLE inbox_items ADD clock text;
ALTER TABLE inbox_items ADD synced_at text;
ALTER TABLE inbox_items ADD local_only integer DEFAULT 0;
ALTER TABLE saved_filters ADD clock text;
ALTER TABLE saved_filters ADD synced_at text;
