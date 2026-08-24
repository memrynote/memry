/**
 * Mobile vault DB migration ledger. Additive only — a new change is a new
 * entry, never an edit (Constitution I; live-data rules match the desktop and
 * D1 ledgers). The sibling `.sql` files are the reviewable canonical text; the
 * strings here are what ships (Metro cannot import .sql), and a test keeps the
 * two byte-identical.
 */
export interface MobileMigration {
  version: number
  name: string
  sql: string
}

export const BASELINE_SQL = `-- Mobile-local vault DB baseline (data-model.md §1). One database per vault,
-- under Application Support with NSFileProtectionCompleteUntilFirstUserAuthentication.
-- Ledger starts here; every later change is a new additive file.
--
-- Deviations from the data-model sketch, on record:
--   * sync_items.type carries NO enum CHECK — the protocol already has 25 item
--     types and newer desktops may add more; an enum here would make mobile
--     reject rows a newer desktop wrote (backward compat is mandatory).
--   * yjs_updates.update is named update_blob (UPDATE is a reserved word).
--   * sync_items.payload stores the decrypted payload JSON verbatim as
--     received, so unknown fields written by newer clients round-trip
--     untouched (spec edge case: mobile never re-serializes them).

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sync_items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  vector_clock TEXT,
  remote_revision TEXT,
  payload_state TEXT NOT NULL DEFAULT 'metadata-only'
    CHECK (payload_state IN ('metadata-only', 'full')),
  payload TEXT
) WITHOUT ROWID;

CREATE INDEX idx_sync_items_type_updated ON sync_items(type, updated_at);
CREATE INDEX idx_sync_items_deleted ON sync_items(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT NOT NULL,
  position INTEGER
) WITHOUT ROWID;

CREATE INDEX idx_folders_parent ON folders(parent_id);

CREATE TABLE note_bodies (
  item_id TEXT PRIMARY KEY,
  path TEXT,
  markdown TEXT NOT NULL,
  body_hash TEXT,
  fetched_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE UNIQUE INDEX idx_note_bodies_path ON note_bodies(path) WHERE path IS NOT NULL;

CREATE TABLE yjs_updates (
  doc_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  update_blob BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, seq)
) WITHOUT ROWID;

CREATE TABLE yjs_snapshots (
  doc_id TEXT PRIMARY KEY,
  snapshot BLOB NOT NULL,
  last_seq INTEGER NOT NULL,
  compacted_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_type TEXT NOT NULL,
  item_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete', 'crdt-update')),
  payload BLOB,
  payload_path TEXT,
  enqueued_at INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at INTEGER
);

CREATE INDEX idx_outbox_next_attempt ON outbox(next_attempt_at);

CREATE TABLE sync_cursors (
  scope TEXT PRIMARY KEY,
  cursor TEXT,
  window_start INTEGER,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE attachments (
  item_id TEXT PRIMARY KEY,
  note_refs TEXT,
  remote_size INTEGER,
  local_path TEXT,
  downloaded_at INTEGER,
  wifi_only INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
`

export const PATH_NONUNIQUE_SQL = `-- The derived note path is informational (title collisions are real data:
-- journals without titles all derive "Untitled.md"), so it cannot be UNIQUE —
-- the constraint made one colliding note kill its whole apply batch
-- (SQLite error 19 inside the transaction).

DROP INDEX IF EXISTS idx_note_bodies_path;
CREATE INDEX idx_note_bodies_path ON note_bodies(path);
`

export const MOBILE_MIGRATIONS: MobileMigration[] = [
  { version: 1, name: '0001_baseline', sql: BASELINE_SQL },
  { version: 2, name: '0002_note_body_path_nonunique', sql: PATH_NONUNIQUE_SQL }
]
