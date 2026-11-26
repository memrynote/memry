-- 0025_pack_bootstrap_enqueues: when a bootstrap last started a vault's pack
-- backfill chain per kind (#5230). Additive only. A bootstrap sends a chain's
-- first message only when the kind has no row here younger than
-- BOOTSTRAP_ENQUEUE_SKIP_SECONDS (pack-coverage.ts), so repeated opens of one
-- vault start one chain. A Worker built before this migration never reads or
-- writes the table.
CREATE TABLE IF NOT EXISTS pack_bootstrap_enqueues (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('record', 'crdt_snapshot', 'crdt_update')),
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, vault_id, item_kind)
);
