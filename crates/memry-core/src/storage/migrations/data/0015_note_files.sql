-- Path identity and file state of every vault file (desktop Step 12). One row per
-- note id: the vault-relative path, the file kind, the size at the last read and
-- the content hash of the bytes the index last read. The core `notes` table has
-- no path, size or hash, which is why this table exists.
--
-- Device-local, never synced and never projected from sync: another device's
-- file layout says nothing about this one. `content_hash` is the desktop
-- vault tier's own string (djb2 over UTF-16 units, the value Electron stored)
-- and opaque to the core. `local_only` is a cache of the note's local-only
-- state, kept beside the path it was read with. No foreign key to `notes`
-- (core notes are soft deleted and a row's life belongs to the vault tier).
-- Additive: one new table and one index, no existing table or row touched, and
-- an older build never reads it.
CREATE TABLE IF NOT EXISTS note_files (
  note_id      TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  file_type    TEXT NOT NULL DEFAULT 'markdown',
  mime_type    TEXT,
  file_size    INTEGER,
  content_hash TEXT,
  local_only   INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_files_local_only ON note_files(local_only);
