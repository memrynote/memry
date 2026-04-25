-- Port of apps/desktop/src/main/database/drizzle-data/0013_last_guardian.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd;
-- boolean DEFAULT literal `false` normalized to integer 0.

PRAGMA foreign_keys=OFF;

CREATE TABLE __new_sync_devices (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	platform text NOT NULL,
	os_version text,
	app_version text NOT NULL,
	linked_at integer NOT NULL,
	last_sync_at integer,
	is_current_device integer DEFAULT 0 NOT NULL,
	signing_public_key text NOT NULL
);

INSERT INTO __new_sync_devices("id", "name", "platform", "os_version", "app_version", "linked_at", "last_sync_at", "is_current_device", "signing_public_key") SELECT "id", "name", "platform", "os_version", "app_version", "linked_at", "last_sync_at", "is_current_device", "signing_public_key" FROM sync_devices;

DROP TABLE sync_devices;

ALTER TABLE __new_sync_devices RENAME TO sync_devices;

PRAGMA foreign_keys=ON;
