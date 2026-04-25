-- Port of apps/desktop/src/main/database/drizzle-data/0005_old_mac_gargan.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.

ALTER TABLE inbox_items ADD viewed_at text;

ALTER TABLE inbox_stats ADD capture_count_reminder integer DEFAULT 0;
