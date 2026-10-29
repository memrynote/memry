-- The hash of the bytes the desktop vault tier last read from each note's file
-- (desktop Step 12, #3744), whether or not the note's document took them.
-- `note_files.content_hash` names only the text the document holds, so a file
-- the document refused (too large, frontmatter that does not parse, a body
-- that was already there) has none or an older one there, and a move made
-- while the app was closed could not be told from a delete. Rename pairing
-- reads this hash; nothing else does.
--
-- Device-local, never synced, opaque to the core like `content_hash`. A new
-- table rather than a column on `note_files`, because `ALTER TABLE ... ADD
-- COLUMN` has no `IF NOT EXISTS`: a crash between this migration's commit and
-- the `user_version` write (§A.0) would make the re-run fail forever. The
-- backfill copies every hash a row has, which names the same bytes, and is a
-- no-op on that re-run. Additive: no existing table or row touched, and an
-- older build never reads it.
CREATE TABLE IF NOT EXISTS note_file_hashes (
  note_id   TEXT PRIMARY KEY,
  file_hash TEXT NOT NULL
);

INSERT OR IGNORE INTO note_file_hashes (note_id, file_hash)
  SELECT note_id, content_hash FROM note_files WHERE content_hash IS NOT NULL;
