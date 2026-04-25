-- Port of apps/desktop/src/main/database/drizzle-data/0006_late_infant_terrible.sql
-- Drizzle `--> statement-breakpoint` markers stripped; identifiers unbacktick'd.

CREATE TABLE note_positions (
	path text PRIMARY KEY NOT NULL,
	folder_path text NOT NULL,
	position integer DEFAULT 0 NOT NULL
);

CREATE INDEX idx_note_positions_folder ON note_positions (folder_path);
CREATE INDEX idx_note_positions_order ON note_positions (folder_path, position);
