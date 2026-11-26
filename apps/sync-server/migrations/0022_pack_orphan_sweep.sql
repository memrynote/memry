-- 0022_pack_orphan_sweep: resume point of the cron sweep that deletes pack
-- objects no pack_index row lists (REVIEW-5260, services/cleanup.ts).
-- Additive only. One row at most. A missing row means start from the first vault.

CREATE TABLE IF NOT EXISTS pack_orphan_sweep (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  -- R2 list cursor inside that vault's packs/ prefix, NULL at the prefix start
  list_cursor TEXT,
  updated_at INTEGER NOT NULL
);
