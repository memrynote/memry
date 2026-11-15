-- data.db, migration 0031: the desktop sync hardening ledgers (Step 17 L3a,
-- #3534), written only by the desktop `SyncDriver`. iOS runs this migration
-- and never writes either table.
--
-- `sync_quarantine`: Electron's `QuarantineManager`
-- (`apps/desktop/src/main/sync/engine/quarantine-manager.ts`). One row per
-- (type, id) whose record signature did not verify, with the number of
-- failures. At 3 the entry is permanent and the pull neither decodes nor
-- refetches the item until 7 days after its last failure.
--
-- `sync_history`: the `SyncHistoryEntry` rows the sync settings list
-- (`packages/contracts/src/ipc-sync-ops.ts`), one per pull, push or failed
-- pass, newest 500 kept. `kind` is `push`, `pull` or `error`.
--
-- Additive only: two new tables, no existing table or row touched, no
-- backfill. An older build never reads them.
CREATE TABLE IF NOT EXISTS sync_quarantine (
  item_type        TEXT NOT NULL,
  item_id          TEXT NOT NULL,
  signer_device_id TEXT NOT NULL,
  failed_at        INTEGER NOT NULL,
  attempt_count    INTEGER NOT NULL,
  last_error       TEXT NOT NULL,
  PRIMARY KEY (item_type, item_id)
);

CREATE TABLE IF NOT EXISTS sync_history (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  item_count  INTEGER NOT NULL,
  direction   TEXT,
  details     TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS sync_history_created_at ON sync_history (created_at);
