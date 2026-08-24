-- The derived note path is informational (title collisions are real data:
-- journals without titles all derive "Untitled.md"), so it cannot be UNIQUE —
-- the constraint made one colliding note kill its whole apply batch
-- (SQLite error 19 inside the transaction).

DROP INDEX IF EXISTS idx_note_bodies_path;
CREATE INDEX idx_note_bodies_path ON note_bodies(path);
