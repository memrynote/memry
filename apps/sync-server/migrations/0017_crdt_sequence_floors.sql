-- Per-document sequence floor for a deleted note or journal whose body rows
-- the server purged (#2986, protocol 07 section 7.15).
--
-- A note or journal id can be re-created after its delete (a journal day is
-- always j<date>). Its crdt_updates and crdt_snapshots rows are purged when the
-- delete is accepted, so the re-created document starts from an empty body
-- instead of pulling the deleted one back. Sequence numbers are per note and
-- derived as MAX(sequence_num) + 1 over those rows, so the purge would restart
-- them at 1, and a device still holding the old cursor would skip every update
-- of the re-created body. The floor keeps the highest purged sequence number,
-- and both sequence derivations read it, so numbering never moves down.
--
-- Backward compatibility:
--   * New table, no backfill. A note with no floor row reads 0, which is the
--     derivation's previous behaviour.
--   * A Worker deployed before this migration (or rolled back after it) never
--     reads the table and never purges, so it behaves exactly as before.
CREATE TABLE IF NOT EXISTS crdt_sequence_floors (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  note_id TEXT NOT NULL,
  floor INTEGER NOT NULL,
  PRIMARY KEY (user_id, vault_id, note_id)
);
