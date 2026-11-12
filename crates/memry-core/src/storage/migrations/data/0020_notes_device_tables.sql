-- Manual sidebar order of notes and folders (desktop Step 13, `note_positions`
-- of the Electron data database). One row per vault-relative path, notes and
-- folders in one namespace per parent folder; the vault root is the empty
-- `folder_path`. The tree reads a missing row as "last", so a row exists only
-- for an item somebody ordered by hand.
--
-- Device-local, never synced and never projected from sync: the order is this
-- device's view of the tree, and a path is a device's file layout. No foreign
-- key to `notes` (a path outlives a note id, and a folder has no note row).
-- Additive: one new table and one index, no existing table or row touched,
-- and an older build never reads it (its `user_version` guard leaves a newer
-- file alone).
CREATE TABLE IF NOT EXISTS note_positions (
  path        TEXT PRIMARY KEY,
  folder_path TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_note_positions_order ON note_positions(folder_path, position);
