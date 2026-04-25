-- Port of apps/desktop/src/main/database/drizzle-data/0020_search_reasons.sql
-- Hand-written Electron migration; identifiers unbacktick'd.

DROP TABLE IF EXISTS recent_searches;

CREATE TABLE search_reasons (
	id text PRIMARY KEY NOT NULL,
	item_id text NOT NULL,
	item_type text NOT NULL,
	item_title text NOT NULL,
	item_icon text,
	search_query text NOT NULL,
	visited_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

CREATE UNIQUE INDEX idx_search_reasons_item ON search_reasons (item_type, item_id);

CREATE INDEX idx_search_reasons_visited ON search_reasons (visited_at);
