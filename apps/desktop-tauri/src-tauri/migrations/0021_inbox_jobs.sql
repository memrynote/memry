-- Port of apps/desktop/src/main/database/drizzle-data/0021_inbox_jobs.sql
-- Hand-written Electron migration; identifiers unbacktick'd.

CREATE TABLE inbox_jobs (
	id text PRIMARY KEY NOT NULL,
	item_id text NOT NULL,
	type text NOT NULL,
	status text DEFAULT 'pending' NOT NULL,
	run_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	attempts integer DEFAULT 0 NOT NULL,
	max_attempts integer DEFAULT 1 NOT NULL,
	payload text,
	result text,
	last_error text,
	started_at text,
	completed_at text,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	updated_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (item_id) REFERENCES inbox_items(id) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX idx_inbox_jobs_item ON inbox_jobs (item_id);

CREATE INDEX idx_inbox_jobs_status ON inbox_jobs (status);

CREATE INDEX idx_inbox_jobs_run_at ON inbox_jobs (run_at);

CREATE INDEX idx_inbox_jobs_item_type ON inbox_jobs (item_id, type);
