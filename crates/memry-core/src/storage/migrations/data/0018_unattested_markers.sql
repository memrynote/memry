-- data.db, migration 0018: purged markers the first-sync reconcile kept a
-- live row against (#5406, chapter 05 §5.8 and §5.12.3).
--
-- The reconcile deletes a row on a marker only when its attestation verifies.
-- A marker without one (a delete pushed before attestations, or before clocks)
-- leaves the row live here while the server holds it deleted. An edit of that
-- row reads this table: it applies the remembered delete locally instead of
-- pushing, because the server accepts any update over a clockless marker and
-- would reverse the delete on every device.
--
-- Additive only: one new table, no existing table or row touched. An older
-- build never reads it. `clock` is the marker's clock as JSON text, NULL for a
-- clockless marker. `deleted_at`, `recorded_at` are epoch milliseconds (§A.6).
-- A row goes when the item is deleted (pulled or local) or written on the
-- server after the marker.
CREATE TABLE IF NOT EXISTS sync_unattested_markers (
  item_type     TEXT NOT NULL,
  item_id       TEXT NOT NULL,
  deleted_at    INTEGER NOT NULL,
  server_cursor INTEGER NOT NULL,
  clock         TEXT,
  recorded_at   INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);
