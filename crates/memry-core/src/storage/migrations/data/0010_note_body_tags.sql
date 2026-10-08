-- data.db, migration 0010: `note_body_tags`, the inline `#tags` a note or
-- journal body carries (desktop indexes them beside the frontmatter tags and
-- never pushes them in the payload).
--
-- Additive only: one new table, no existing table or row touched. A cache of
-- a parse of the body document, written by the search reindex the way
-- `note_bodies` is; the data version change forces that full reindex, which
-- fills it for every existing note.
CREATE TABLE IF NOT EXISTS note_body_tags (
  note_id TEXT NOT NULL,
  tag     TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (note_id, tag)
);
