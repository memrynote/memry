-- Port of apps/desktop/src/main/database/drizzle-data/0018_greedy_stepford_cuckoos.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd;
-- boolean DEFAULT literal `false` normalized to integer 0.
-- Massive table-rebuild migration: adds recent_searches; switches default
-- timestamp expression from datetime('now') to strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
-- backfills sync columns (clock/field_clocks/synced_at) on remaining tables.

CREATE TABLE recent_searches (
	id text PRIMARY KEY NOT NULL,
	query text NOT NULL,
	result_count integer DEFAULT 0 NOT NULL,
	searched_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

PRAGMA foreign_keys=OFF;

CREATE TABLE __new_projects (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	description text,
	color text DEFAULT '#6366f1' NOT NULL,
	icon text,
	position integer DEFAULT 0 NOT NULL,
	is_inbox integer DEFAULT 0 NOT NULL,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	modified_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	archived_at text,
	clock text,
	field_clocks text,
	synced_at text
);

INSERT INTO __new_projects("id", "name", "description", "color", "icon", "position", "is_inbox", "created_at", "modified_at", "archived_at", "clock", "field_clocks", "synced_at") SELECT "id", "name", "description", "color", "icon", "position", "is_inbox", "created_at", "modified_at", "archived_at", "clock", "field_clocks", "synced_at" FROM projects;

DROP TABLE projects;

ALTER TABLE __new_projects RENAME TO projects;

PRAGMA foreign_keys=ON;

CREATE TABLE __new_statuses (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	name text NOT NULL,
	color text DEFAULT '#6b7280' NOT NULL,
	position integer DEFAULT 0 NOT NULL,
	is_default integer DEFAULT 0 NOT NULL,
	is_done integer DEFAULT 0 NOT NULL,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade
);

INSERT INTO __new_statuses("id", "project_id", "name", "color", "position", "is_default", "is_done", "created_at") SELECT "id", "project_id", "name", "color", "position", "is_default", "is_done", "created_at" FROM statuses;

DROP TABLE statuses;

ALTER TABLE __new_statuses RENAME TO statuses;

CREATE INDEX idx_statuses_project ON statuses (project_id);

CREATE TABLE __new_tasks (
	id text PRIMARY KEY NOT NULL,
	project_id text NOT NULL,
	status_id text,
	parent_id text,
	title text NOT NULL,
	description text,
	priority integer DEFAULT 0 NOT NULL,
	position integer DEFAULT 0 NOT NULL,
	due_date text,
	due_time text,
	start_date text,
	repeat_config text,
	repeat_from text,
	source_note_id text,
	completed_at text,
	archived_at text,
	clock text,
	field_clocks text,
	synced_at text,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	modified_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (project_id) REFERENCES projects(id) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (status_id) REFERENCES statuses(id) ON UPDATE no action ON DELETE set null
);

INSERT INTO __new_tasks("id", "project_id", "status_id", "parent_id", "title", "description", "priority", "position", "due_date", "due_time", "start_date", "repeat_config", "repeat_from", "source_note_id", "completed_at", "archived_at", "clock", "field_clocks", "synced_at", "created_at", "modified_at") SELECT "id", "project_id", "status_id", "parent_id", "title", "description", "priority", "position", "due_date", "due_time", "start_date", "repeat_config", "repeat_from", "source_note_id", "completed_at", "archived_at", "clock", "field_clocks", "synced_at", "created_at", "modified_at" FROM tasks;

DROP TABLE tasks;

ALTER TABLE __new_tasks RENAME TO tasks;

CREATE INDEX idx_tasks_project ON tasks (project_id);
CREATE INDEX idx_tasks_status ON tasks (status_id);
CREATE INDEX idx_tasks_parent ON tasks (parent_id);
CREATE INDEX idx_tasks_due_date ON tasks (due_date);
CREATE INDEX idx_tasks_completed ON tasks (completed_at);

CREATE TABLE __new_task_notes (
	task_id text NOT NULL,
	note_id text NOT NULL,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(task_id, note_id),
	FOREIGN KEY (task_id) REFERENCES tasks(id) ON UPDATE no action ON DELETE cascade
);

INSERT INTO __new_task_notes("task_id", "note_id", "created_at") SELECT "task_id", "note_id", "created_at" FROM task_notes;

DROP TABLE task_notes;

ALTER TABLE __new_task_notes RENAME TO task_notes;

CREATE TABLE __new_filing_history (
	id text PRIMARY KEY NOT NULL,
	item_type text NOT NULL,
	item_content text,
	filed_to text NOT NULL,
	filed_action text NOT NULL,
	tags text,
	filed_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO __new_filing_history("id", "item_type", "item_content", "filed_to", "filed_action", "tags", "filed_at") SELECT "id", "item_type", "item_content", "filed_to", "filed_action", "tags", "filed_at" FROM filing_history;

DROP TABLE filing_history;

ALTER TABLE __new_filing_history RENAME TO filing_history;

CREATE INDEX idx_filing_history_type ON filing_history (item_type);
CREATE INDEX idx_filing_history_filed_at ON filing_history (filed_at);

CREATE TABLE __new_inbox_item_tags (
	id text PRIMARY KEY NOT NULL,
	item_id text NOT NULL,
	tag text NOT NULL,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (item_id) REFERENCES inbox_items(id) ON UPDATE no action ON DELETE cascade
);

INSERT INTO __new_inbox_item_tags("id", "item_id", "tag", "created_at") SELECT "id", "item_id", "tag", "created_at" FROM inbox_item_tags;

DROP TABLE inbox_item_tags;

ALTER TABLE __new_inbox_item_tags RENAME TO inbox_item_tags;

CREATE INDEX idx_inbox_tags_item ON inbox_item_tags (item_id);
CREATE INDEX idx_inbox_tags_tag ON inbox_item_tags (tag);

CREATE TABLE __new_inbox_items (
	id text PRIMARY KEY NOT NULL,
	type text NOT NULL,
	title text NOT NULL,
	content text,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	modified_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	filed_at text,
	filed_to text,
	filed_action text,
	snoozed_until text,
	snooze_reason text,
	viewed_at text,
	processing_status text DEFAULT 'complete',
	processing_error text,
	metadata text,
	attachment_path text,
	thumbnail_path text,
	transcription text,
	transcription_status text,
	source_url text,
	source_title text,
	archived_at text,
	clock text,
	synced_at text,
	local_only integer DEFAULT 0
);

INSERT INTO __new_inbox_items("id", "type", "title", "content", "created_at", "modified_at", "filed_at", "filed_to", "filed_action", "snoozed_until", "snooze_reason", "viewed_at", "processing_status", "processing_error", "metadata", "attachment_path", "thumbnail_path", "transcription", "transcription_status", "source_url", "source_title", "archived_at", "clock", "synced_at", "local_only") SELECT "id", "type", "title", "content", "created_at", "modified_at", "filed_at", "filed_to", "filed_action", "snoozed_until", "snooze_reason", "viewed_at", "processing_status", "processing_error", "metadata", "attachment_path", "thumbnail_path", "transcription", "transcription_status", "source_url", "source_title", "archived_at", "clock", "synced_at", "local_only" FROM inbox_items;

DROP TABLE inbox_items;

ALTER TABLE __new_inbox_items RENAME TO inbox_items;

CREATE INDEX idx_inbox_items_type ON inbox_items (type);
CREATE INDEX idx_inbox_items_created ON inbox_items (created_at);
CREATE INDEX idx_inbox_items_filed ON inbox_items (filed_at);
CREATE INDEX idx_inbox_items_snoozed ON inbox_items (snoozed_until);
CREATE INDEX idx_inbox_items_processing ON inbox_items (processing_status);
CREATE INDEX idx_inbox_items_archived ON inbox_items (archived_at);

CREATE TABLE __new_suggestion_feedback (
	id text PRIMARY KEY NOT NULL,
	item_id text NOT NULL,
	item_type text NOT NULL,
	suggested_to text NOT NULL,
	actual_to text NOT NULL,
	accepted integer NOT NULL,
	confidence integer NOT NULL,
	suggested_tags text,
	actual_tags text,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO __new_suggestion_feedback("id", "item_id", "item_type", "suggested_to", "actual_to", "accepted", "confidence", "suggested_tags", "actual_tags", "created_at") SELECT "id", "item_id", "item_type", "suggested_to", "actual_to", "accepted", "confidence", "suggested_tags", "actual_tags", "created_at" FROM suggestion_feedback;

DROP TABLE suggestion_feedback;

ALTER TABLE __new_suggestion_feedback RENAME TO suggestion_feedback;

CREATE INDEX idx_suggestion_feedback_item_type ON suggestion_feedback (item_type);
CREATE INDEX idx_suggestion_feedback_accepted ON suggestion_feedback (accepted);
CREATE INDEX idx_suggestion_feedback_created ON suggestion_feedback (created_at);

CREATE TABLE __new_saved_filters (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	config text NOT NULL,
	position integer DEFAULT 0 NOT NULL,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	clock text,
	synced_at text
);

INSERT INTO __new_saved_filters("id", "name", "config", "position", "created_at", "clock", "synced_at") SELECT "id", "name", "config", "position", "created_at", "clock", "synced_at" FROM saved_filters;

DROP TABLE saved_filters;

ALTER TABLE __new_saved_filters RENAME TO saved_filters;

CREATE TABLE __new_settings (
	key text PRIMARY KEY NOT NULL,
	value text NOT NULL,
	modified_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO __new_settings("key", "value", "modified_at") SELECT "key", "value", "modified_at" FROM settings;

DROP TABLE settings;

ALTER TABLE __new_settings RENAME TO settings;

CREATE TABLE __new_bookmarks (
	id text PRIMARY KEY NOT NULL,
	item_type text NOT NULL,
	item_id text NOT NULL,
	position integer DEFAULT 0 NOT NULL,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO __new_bookmarks("id", "item_type", "item_id", "position", "created_at") SELECT "id", "item_type", "item_id", "position", "created_at" FROM bookmarks;

DROP TABLE bookmarks;

ALTER TABLE __new_bookmarks RENAME TO bookmarks;

CREATE UNIQUE INDEX idx_bookmarks_unique_item ON bookmarks (item_type, item_id);
CREATE INDEX idx_bookmarks_item_type ON bookmarks (item_type);
CREATE INDEX idx_bookmarks_position ON bookmarks (position);
CREATE INDEX idx_bookmarks_created ON bookmarks (created_at);

CREATE TABLE __new_reminders (
	id text PRIMARY KEY NOT NULL,
	target_type text NOT NULL,
	target_id text NOT NULL,
	remind_at text NOT NULL,
	highlight_text text,
	highlight_start integer,
	highlight_end integer,
	title text,
	note text,
	status text DEFAULT 'pending' NOT NULL,
	triggered_at text,
	dismissed_at text,
	snoozed_until text,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	modified_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO __new_reminders("id", "target_type", "target_id", "remind_at", "highlight_text", "highlight_start", "highlight_end", "title", "note", "status", "triggered_at", "dismissed_at", "snoozed_until", "created_at", "modified_at") SELECT "id", "target_type", "target_id", "remind_at", "highlight_text", "highlight_start", "highlight_end", "title", "note", "status", "triggered_at", "dismissed_at", "snoozed_until", "created_at", "modified_at" FROM reminders;

DROP TABLE reminders;

ALTER TABLE __new_reminders RENAME TO reminders;

CREATE INDEX idx_reminders_target ON reminders (target_type, target_id);
CREATE INDEX idx_reminders_remind_at ON reminders (remind_at);
CREATE INDEX idx_reminders_status ON reminders (status);

CREATE TABLE __new_tag_definitions (
	name text PRIMARY KEY NOT NULL,
	color text NOT NULL,
	clock text,
	created_at text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);

INSERT INTO __new_tag_definitions("name", "color", "clock", "created_at") SELECT "name", "color", "clock", "created_at" FROM tag_definitions;

DROP TABLE tag_definitions;

ALTER TABLE __new_tag_definitions RENAME TO tag_definitions;
