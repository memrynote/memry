-- Version history snapshots of a note's body (desktop `note_snapshots`,
-- `packages/db-schema/src/schema/notes-cache.ts`). Additive: one new table with
-- its indexes, no existing table or row touched, and an older build never reads
-- it.
--
-- Columns mirror the Electron table. There is no foreign key to `notes`: core
-- notes are soft deleted and a snapshot must outlive that. The table is user
-- data, never derived from anything, and is not projected from sync. Limits and
-- reasons belong to the version-history feature, not to the schema.
CREATE TABLE IF NOT EXISTS note_snapshots (
  id           TEXT PRIMARY KEY,
  note_id      TEXT NOT NULL,
  content      TEXT NOT NULL,
  title        TEXT NOT NULL,
  word_count   INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL,
  reason       TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_note_snapshots_note_id ON note_snapshots (note_id, created_at);
CREATE INDEX IF NOT EXISTS idx_note_snapshots_created ON note_snapshots (created_at);
