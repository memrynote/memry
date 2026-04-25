-- Port of apps/desktop/src/main/database/drizzle-data/0023_folder_configs.sql
-- Hand-written Electron migration; identifiers unbacktick'd.

CREATE TABLE folder_configs (
	path text PRIMARY KEY NOT NULL,
	icon text,
	clock text,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	modified_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
