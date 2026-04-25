-- Port of apps/desktop/src/main/database/drizzle-data/0002_broken_sleeper.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.
-- Note: PRAGMA foreign_keys=OFF/ON inside a transaction is silently no-op'd
-- by SQLite, but kept verbatim because Drizzle production runs it that way.

CREATE TABLE filing_history (
	id text PRIMARY KEY NOT NULL,
	item_type text NOT NULL,
	item_content text,
	filed_to text NOT NULL,
	filed_action text NOT NULL,
	tags text,
	filed_at text DEFAULT (datetime('now')) NOT NULL
);

CREATE INDEX idx_filing_history_type ON filing_history (item_type);
CREATE INDEX idx_filing_history_filed_at ON filing_history (filed_at);

CREATE TABLE inbox_item_tags (
	id text PRIMARY KEY NOT NULL,
	item_id text NOT NULL,
	tag text NOT NULL,
	created_at text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (item_id) REFERENCES inbox_items(id) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX idx_inbox_tags_item ON inbox_item_tags (item_id);
CREATE INDEX idx_inbox_tags_tag ON inbox_item_tags (tag);

CREATE TABLE inbox_stats (
	id text PRIMARY KEY NOT NULL,
	date text NOT NULL,
	capture_count_link integer DEFAULT 0,
	capture_count_note integer DEFAULT 0,
	capture_count_image integer DEFAULT 0,
	capture_count_voice integer DEFAULT 0,
	capture_count_clip integer DEFAULT 0,
	capture_count_pdf integer DEFAULT 0,
	capture_count_social integer DEFAULT 0,
	processed_count integer DEFAULT 0,
	archived_count integer DEFAULT 0
);

CREATE UNIQUE INDEX inbox_stats_date_unique ON inbox_stats (date);
CREATE INDEX idx_inbox_stats_date ON inbox_stats (date);

PRAGMA foreign_keys=OFF;

CREATE TABLE __new_inbox_items (
	id text PRIMARY KEY NOT NULL,
	type text NOT NULL,
	title text NOT NULL,
	content text,
	created_at text DEFAULT (datetime('now')) NOT NULL,
	modified_at text DEFAULT (datetime('now')) NOT NULL,
	filed_at text,
	filed_to text,
	filed_action text,
	snoozed_until text,
	snooze_reason text,
	processing_status text DEFAULT 'complete',
	processing_error text,
	metadata text,
	attachment_path text,
	thumbnail_path text,
	transcription text,
	transcription_status text,
	source_url text,
	source_title text,
	archived_at text
);

INSERT INTO __new_inbox_items("id", "type", "title", "content", "created_at", "modified_at", "filed_at", "metadata") SELECT "id", "type", COALESCE("content", 'Untitled'), "content", "created_at", "created_at", "filed_at", "metadata" FROM inbox_items;

DROP TABLE inbox_items;

ALTER TABLE __new_inbox_items RENAME TO inbox_items;

PRAGMA foreign_keys=ON;

CREATE INDEX idx_inbox_items_type ON inbox_items (type);
CREATE INDEX idx_inbox_items_created ON inbox_items (created_at);
CREATE INDEX idx_inbox_items_filed ON inbox_items (filed_at);
CREATE INDEX idx_inbox_items_snoozed ON inbox_items (snoozed_until);
CREATE INDEX idx_inbox_items_processing ON inbox_items (processing_status);
CREATE INDEX idx_inbox_items_archived ON inbox_items (archived_at);
