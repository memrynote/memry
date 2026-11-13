-- data.db, migration 0030: the refused-items ledger (#4453, chapter 13 §13.2
-- rule 5), the core's equal of desktop's `SchemaInvalidLedger`
-- (`apps/desktop/src/main/sync/engine/schema-invalid-ledger.ts`).
--
-- One row per pulled record this build's schema refused: the record was not
-- applied, the local row was left as it was, and the cursor moved past it. The
-- pull refetches every row whose `refused_by_version` is not the running app
-- version, so a newer peer's shape lands once a build understands it.
--
-- Additive only: one new table, no existing table or row touched, no backfill.
-- An older build never reads it.
CREATE TABLE IF NOT EXISTS sync_refused_items (
  item_type          TEXT NOT NULL,
  item_id            TEXT NOT NULL,
  refused_by_version TEXT NOT NULL,
  refused_at         INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);
