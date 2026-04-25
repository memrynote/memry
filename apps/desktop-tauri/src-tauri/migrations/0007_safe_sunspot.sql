-- Port of apps/desktop/src/main/database/drizzle-data/0007_safe_sunspot.sql
-- Identifiers unbacktick'd.

CREATE TABLE tag_definitions (
	name text PRIMARY KEY NOT NULL,
	color text NOT NULL,
	created_at text DEFAULT (datetime('now')) NOT NULL
);
