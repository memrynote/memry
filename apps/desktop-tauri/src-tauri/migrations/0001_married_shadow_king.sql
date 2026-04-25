-- Port of apps/desktop/src/main/database/drizzle-data/0001_married_shadow_king.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.

CREATE TABLE bookmarks (
	id text PRIMARY KEY NOT NULL,
	item_type text NOT NULL,
	item_id text NOT NULL,
	position integer DEFAULT 0 NOT NULL,
	created_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE UNIQUE INDEX idx_bookmarks_unique_item ON bookmarks (item_type, item_id);
CREATE INDEX idx_bookmarks_item_type ON bookmarks (item_type);
CREATE INDEX idx_bookmarks_position ON bookmarks (position);
CREATE INDEX idx_bookmarks_created ON bookmarks (created_at);
