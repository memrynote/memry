-- Live notes by title and folder (desktop Step 13d, #3530). The vault tier asks
-- which note a file no row names is by its file name and folder, once for each
-- such file, so the first open of a large folder of markdown asks it for every
-- file; without the index each ask scans every note.
--
-- Additive: one partial index, no table or row touched. An older build never
-- reads it (its `user_version` guard leaves a newer file alone), and an index
-- changes no row any build reads or writes.
CREATE INDEX IF NOT EXISTS idx_notes_live_title ON notes(title, folder_path)
  WHERE deleted_at IS NULL;
