-- data.db, migration 0011: how many times this device purged a document's
-- body (#2986, chapter 07 §7.16).
--
-- A journal day deleted and written again reuses its id. The purge drops the
-- local log, so the re-created document would restart this device's Yjs clock
-- at 0 under the same client id, and a peer still holding the deleted
-- document would take the new items for ones it already has and drop them.
-- Each purge bumps `epoch`, and a write at epoch n > 0 authors under a client
-- id derived from the device id and n.
--
-- Additive only: one new table, no existing table or row touched. No row
-- means epoch 0, the client id every build before this one used. An older
-- build never reads the table.
CREATE TABLE IF NOT EXISTS yjs_doc_epochs (
  doc_id TEXT PRIMARY KEY,
  epoch  INTEGER NOT NULL
);
