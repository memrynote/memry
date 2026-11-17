-- data.db, migration 0036: the canvas tables (Step 30d, #3547).
--
-- `canvases` caches a parse of each `canvas` payload in `sync_items`, which
-- stays the owner (§A.4): `projectors::canvas` writes it, so listing never
-- reads a scene. The scene stays in the payload only. Instants are epoch
-- milliseconds (§A.6); a canvas payload carries none, so `created_at` is when
-- this device first held the canvas and `updated_at` its last write here.
-- `vault_id` is '' for a payload that states none.
--
-- `canvas_files` (where this device keeps a canvas's `.excalidraw` file and the
-- hash of the scene it last wrote there) and `canvas_assets` (Electron's
-- per-device image dedup and GC index, `packages/db-schema/src/schema/canvas.ts`)
-- are device-local and never synced. No table has a foreign key: a projection
-- row can be rebuilt, and a canvas can sync after the rows that name it.
--
-- Existing canvases are not copied here with SQL. `pending_reprojections` names
-- the item types whose payloads the projector must replay once every migration
-- has run (`sync_items::reproject_pending`), so the projector stays the one
-- writer of `canvases`. The marker is cleared in the replay's own transaction.
--
-- Additive only: new tables, indexes and one marker row, no existing table or
-- row touched. Every statement is re-runnable (§A.0 crash window). An older
-- build never reads these tables (its `user_version` guard leaves a newer file
-- alone).
CREATE TABLE IF NOT EXISTS canvases (
  id            TEXT PRIMARY KEY,
  vault_id      TEXT NOT NULL,
  title         TEXT,
  folder        TEXT,
  icon          TEXT,
  owner_note_id TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  deleted_at    INTEGER,
  clock         TEXT,
  synced_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_canvases_vault_updated ON canvases (vault_id, updated_at);

CREATE TABLE IF NOT EXISTS canvas_files (
  canvas_id    TEXT PRIMARY KEY,
  file_path    TEXT NOT NULL,
  scene_sha256 TEXT NOT NULL,
  written_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canvas_files_path ON canvas_files (file_path);

CREATE TABLE IF NOT EXISTS canvas_assets (
  vault_id      TEXT NOT NULL,
  canvas_id     TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  file_id       TEXT NOT NULL,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  chunk_hashes  TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (canvas_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_canvas_assets_dedup ON canvas_assets (vault_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_canvas_assets_attachment ON canvas_assets (attachment_id);

CREATE TABLE IF NOT EXISTS pending_reprojections (
  item_type TEXT PRIMARY KEY
);

INSERT OR IGNORE INTO pending_reprojections (item_type) VALUES ('canvas');
