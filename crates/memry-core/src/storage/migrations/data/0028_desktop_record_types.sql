-- data.db, migration 0028: projection tables of three desktop-only record
-- types (Step 16, #3533; chapter 13 §13.7.23-25): `canvas_folder`
-- (`CanvasFolderSyncPayloadSchema`), `home_page` (`HomePageSyncPayloadSchema`)
-- and `sticky_draft` (`StickyDraftSyncPayloadSchema`), all in
-- `packages/contracts/src/sync-payloads.ts`.
--
-- Each table caches a parse of the record's verbatim payload in `sync_items`,
-- which stays the owner (§A.4): `rebuild_projections` refills them from it.
-- Instants are epoch milliseconds (§A.6); the wire keeps the payload's ISO
-- strings. `deleted_at` is the tombstone column (§A.4), and a `canvas_folder`
-- whose payload states `deletedAt` reads as deleted too. A `canvas_folder`
-- payload carries no timestamps, so its `created_at` is when this device first
-- held the folder. `home_pages.cover` is the payload's `cover` as JSON text,
-- and `widgets` the payload's opaque string.
--
-- Additive only: three new tables and one index, no existing table or row
-- touched, no backfill. An older build never reads these tables (its
-- `user_version` guard leaves a newer file alone).
CREATE TABLE IF NOT EXISTS canvas_folders (
  id         TEXT PRIMARY KEY,
  vault_id   TEXT,
  path       TEXT NOT NULL,
  icon       TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  deleted_at INTEGER,
  synced_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_canvas_folders_path ON canvas_folders (path);

CREATE TABLE IF NOT EXISTS home_pages (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT,
  position   REAL NOT NULL DEFAULT 0,
  widgets    TEXT NOT NULL DEFAULT '[]',
  cover      TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  deleted_at INTEGER,
  synced_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sticky_drafts (
  id          TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'note',
  created_at  INTEGER,
  modified_at INTEGER,
  deleted_at  INTEGER,
  synced_at   INTEGER
);
