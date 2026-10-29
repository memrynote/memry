-- The note identity's own state (desktop Step 13d, #3530).
--
-- Live notes by title and folder. The vault tier asks which note a file no row
-- names is by its file name and folder, once for each such file, so the first
-- open of a large folder of markdown asks it for every file; without the index
-- each ask scans every note.
CREATE INDEX IF NOT EXISTS idx_notes_live_title ON notes(title, folder_path)
  WHERE deleted_at IS NULL;

-- A note whose file moved while the identity could not tell what the move made
-- of it (the vault config unreadable, or a move into or out of the journal
-- folder): its record was left as it was, and still describes `from_path`, the
-- path it last followed. The identity applies the move once it can tell. One
-- row per note; device-local, never synced. No foreign key to `notes`, as for
-- `note_files`.
CREATE TABLE IF NOT EXISTS note_place_owed (
  note_id   TEXT PRIMARY KEY,
  from_path TEXT NOT NULL,
  marked_at INTEGER NOT NULL
);

-- Additive: one index and one new table, no existing table or row touched. An
-- older build never reads either (its `user_version` guard leaves a newer file
-- alone), and the index changes no row any build reads or writes.
