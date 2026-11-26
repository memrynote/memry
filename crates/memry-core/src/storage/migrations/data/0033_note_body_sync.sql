-- data.db, migration 0033: where each note's body stands with the server
-- (Step 17 L6, #3534), Electron's `note_body_sync` (drizzle 0068 and 0071,
-- `packages/db-schema/src/schema/note-body-sync.ts`). One row per CRDT
-- document id, written by the push wave when a body push starts and ends and
-- when the server stores a snapshot of the whole document
-- (`sync::hardening::body_state`).
--
-- Electron's `pushed_state_vector` (0074) is left out: the core's delete keep
-- rule 4 reads the whole body log's state vector, so nothing would read it.
-- A later build adds it as one nullable column.
--
-- Additive only: one new table, no existing row touched, no backfill. A note
-- with no row reads "no body push recorded by this version". An older build
-- never reads the table. No foreign key: the note can go while its row stands,
-- and a row whose note is gone is never read.
CREATE TABLE IF NOT EXISTS note_body_sync (
  note_id           TEXT PRIMARY KEY NOT NULL,
  last_sent_at      INTEGER,
  last_confirmed_at INTEGER,
  last_failed_at    INTEGER,
  last_rejected_at  INTEGER,
  last_snapshot_at  INTEGER,
  updated_at        INTEGER NOT NULL
);
