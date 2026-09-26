-- data.db, migration 0004: the highest delete clock seen per id (#2409).
--
-- A re-created journal day or folder path must be minted with a clock that
-- happens strictly after its tombstone (chapter 05 §5.8), and a tombstone
-- whose clock the local row already dominates must not delete it. This is
-- where both read that clock from.
--
-- Additive only: one new table, no existing table or row touched. A separate
-- table rather than a column on `sync_items`, because `ALTER TABLE ... ADD
-- COLUMN` has no `IF NOT EXISTS`: a crash between this migration's commit and
-- the `user_version` write (§A.0) would make the re-run fail forever.
--
-- `clock` is the pointwise max of every delete clock recorded for the key, as
-- JSON text. `updated_at` is epoch milliseconds (§A.6). Rows are never
-- pruned, matching the server's markers, which are kept forever (#2302). An
-- older build never reads the table.
CREATE TABLE IF NOT EXISTS sync_tombstone_clocks (
  item_type  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  clock      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);
