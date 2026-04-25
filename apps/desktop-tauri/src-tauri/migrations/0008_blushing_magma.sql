-- Port of apps/desktop/src/main/database/drizzle-data/0008_blushing_magma.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.

CREATE TABLE sync_devices (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	platform text NOT NULL,
	os_version text,
	app_version text NOT NULL,
	linked_at integer NOT NULL,
	last_sync_at integer,
	is_current_device integer DEFAULT 0 NOT NULL
);

CREATE TABLE sync_queue (
	id text PRIMARY KEY NOT NULL,
	type text NOT NULL,
	item_id text NOT NULL,
	operation text NOT NULL,
	payload text NOT NULL,
	priority integer DEFAULT 0 NOT NULL,
	attempts integer DEFAULT 0 NOT NULL,
	last_attempt integer,
	error_message text,
	created_at integer NOT NULL
);

CREATE TABLE sync_state (
	key text PRIMARY KEY NOT NULL,
	value text NOT NULL,
	updated_at integer NOT NULL
);

CREATE TABLE sync_history (
	id text PRIMARY KEY NOT NULL,
	type text NOT NULL,
	item_count integer NOT NULL,
	direction text,
	details text,
	duration_ms integer,
	created_at integer NOT NULL
);

CREATE INDEX idx_sync_history_created ON sync_history (created_at);
