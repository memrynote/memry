-- data.db, migration 0025: read-only locks on notes and folders (desktop Step 14,
-- #3531; Electron `packages/db-schema/src/schema/vault-locks.ts`, drizzle 0067,
-- 0069, 0070).
--
-- `vault_locks` holds the `vault_lock` records (`VaultLockSyncPayloadSchema`:
-- `targetKind`, `target`, `locked`, `clock`, `createdAt`, `updatedAt`). The id
-- is `note:<note id>` or `folder:<vault-relative path>`, so two devices locking
-- the same target share one record. Unlocking sets `locked` to 0 and keeps the
-- row. `target_kind` is free text: a kind a newer build adds is kept, not
-- refused, and this build reads it as no lock. `clock` NULL means never synced;
-- this step writes no clock and no outbox row, and the `vault_lock` projector
-- and handler (Step 16, #3533) sync these rows. `created_at` and `updated_at`
-- are epoch milliseconds (§A.6), as the `bookmarks` projection stores the
-- payload's ISO `createdAt`; `deleted_at` is the tombstone column (§A.4).
--
-- `vault_lock_baselines` and `vault_lock_file_modes` are device-local and never
-- synced: the bytes of each locked markdown note as the app last wrote or
-- accepted them, and the permission bits each file had before a lock made it
-- read-only, with the file identity they belong to (NULL: not known yet).
--
-- Additive only: three new tables and one index, no existing table or row
-- touched, no backfill. Nothing is locked until the owner locks something. An
-- older build never reads these tables (its `user_version` guard leaves a newer
-- file alone).
CREATE TABLE IF NOT EXISTS vault_locks (
  id          TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target      TEXT NOT NULL,
  locked      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  clock       TEXT,
  synced_at   INTEGER,
  deleted_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_vault_locks_target ON vault_locks (target_kind, target);

CREATE TABLE IF NOT EXISTS vault_lock_baselines (
  note_id      TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  content      TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_lock_file_modes (
  path     TEXT PRIMARY KEY,
  mode     INTEGER NOT NULL,
  identity TEXT
);
