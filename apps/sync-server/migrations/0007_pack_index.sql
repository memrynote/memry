-- 0007_pack_index: derived-cache bookkeeping for the pack compaction pipeline
-- (#1839). Additive only — no existing table or row is touched, old clients
-- never read these tables, and nothing here is charged against quota (packs
-- are byte-concats of ciphertext blobs the server can rebuild at any time).
--
-- E2E INVARIANT: packs are opaque byte-concats. The server never decrypts;
-- every payload column below describes WHERE bytes live, never WHAT they are.

CREATE TABLE IF NOT EXISTS pack_index (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  -- R2 object key of the immutable pack file. Deterministic from the range
  -- (see services/pack-compaction.ts) so a retried compaction rewrites the
  -- same object instead of duplicating it.
  pack_key TEXT NOT NULL,
  -- 'record'        -> sync_items payloads, min/max are server_cursor values
  -- 'crdt_snapshot' -> note-body snapshots, min/max are created_at epoch seconds
  -- 'crdt_update'   -> RESERVED (updates live in D1, not R2; no small-object
  --                    GET floor exists to kill today). Not produced yet.
  item_kind TEXT NOT NULL CHECK (item_kind IN ('record', 'crdt_snapshot', 'crdt_update')),
  min_cursor INTEGER NOT NULL,
  max_cursor INTEGER NOT NULL,
  item_count INTEGER NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Range-level idempotency: a retry of the same compaction range lands on
  -- this constraint and is a no-op. Per-item membership is deliberately NOT
  -- tracked in D1 — it lives inside each pack's index block, and coverage is
  -- discoverable by range query (items whose cursor falls inside [min,max]
  -- whose blob still exists); the client verifies against the index block.
  UNIQUE (user_id, vault_id, item_kind, min_cursor)
);

CREATE INDEX IF NOT EXISTS idx_pack_user_vault_cursor ON pack_index(user_id, vault_id, max_cursor);
CREATE INDEX IF NOT EXISTS idx_pack_user_vault_min ON pack_index(user_id, vault_id, min_cursor);

-- Compaction progress watermark per (user, vault, kind): everything strictly
-- BELOW the composite marker (sort_value, sort_tiebreak) has been packed.
-- Composite because crdt_snapshot ordering keys (created_at seconds) tie;
-- the tiebreak (note_id) keeps progress exact without re-scanning ties.
-- Resumability of both the queue consumer and the cron-paced backfill hangs
-- off this table: an invocation that dies mid-vault simply leaves the
-- watermark where it was and resumes from there next time.
CREATE TABLE IF NOT EXISTS pack_watermarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL DEFAULT 'default',
  item_kind TEXT NOT NULL CHECK (item_kind IN ('record', 'crdt_snapshot', 'crdt_update')),
  last_sort_value INTEGER NOT NULL DEFAULT 0,
  last_sort_tiebreak TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, vault_id, item_kind)
);

-- Selection scans snapshots by created_at above the watermark; records reuse
-- the existing (user_id, vault_id, server_cursor) index. Additive index only.
CREATE INDEX IF NOT EXISTS idx_crdt_snapshots_created ON crdt_snapshots(user_id, vault_id, created_at);
