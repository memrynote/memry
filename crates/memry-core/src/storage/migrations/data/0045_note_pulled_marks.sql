-- data.db, migration 0045: the notes a pull changed whose file has not taken
-- the pulled place and frontmatter yet (desktop write-back, #5309 / #5316).
--
-- The sync observer records a row once a pulled note or journal record
-- committed; the note's next write-back pass moves the file to the record's
-- place, gives its frontmatter the record's tags, aliases and properties, and
-- deletes the row. Before this table the mark lived in memory, so a quit
-- between the pull and the pass left the pulled rename or move off the file
-- for good. `title_before` is the note's title before the first pull since the
-- file was last placed (NULL: the note was not here), which a later pull keeps:
-- the file is renamed only when the record's title differs from it.
-- `failed` counts the passes whose move failed; at the write-back's limit the
-- row stays parked, unread by passes, until the next pull resets it. `pulls`
-- counts the pulls since the row was made: a pass deletes the row only when no
-- pull came in while it ran.
--
-- Device-local and never synced. Additive: one new table, no existing table or
-- row touched, no backfill (a mark lost before this build stays lost; the next
-- pull of the note marks it again). An older build never reads the table, and
-- a removed `note_files` row takes its mark with it.
CREATE TABLE IF NOT EXISTS note_pulled_marks (
  note_id      TEXT PRIMARY KEY,
  title_before TEXT,
  failed       INTEGER NOT NULL DEFAULT 0,
  pulls        INTEGER NOT NULL DEFAULT 1
);
