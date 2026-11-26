-- data.db, migration 0035: the durable state of desktop attachment sync
-- (Step 18, #3535, chapter 14). Four device-local tables in Electron's exact
-- shapes (`packages/db-schema/src/schema/attachment-upload-queue.ts`,
-- `attachment-download-failures.ts`, `attachment-files.ts`,
-- `deleted-asset-releases.ts`; drizzle data 0039, 0052, 0066, 0072), so the
-- Electron import (#3553) copies rows unchanged. `note_id` holds the owner id:
-- a note, canvas or home page id. Read and written only through
-- `sync::attachments::store`.
--
-- Additive only: four new tables and two indexes, no existing row touched, no
-- backfill. An existing install gains empty tables. An older build never reads
-- them. No foreign key: an owner can go while its rows stand. Never synced.
CREATE TABLE IF NOT EXISTS attachment_upload_queue (
  id         TEXT PRIMARY KEY NOT NULL,
  note_id    TEXT NOT NULL,
  disk_path  TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS attachment_upload_queue_note_path
  ON attachment_upload_queue (note_id, disk_path);

CREATE TABLE IF NOT EXISTS attachment_download_failures (
  id              TEXT PRIMARY KEY NOT NULL,
  owner_id        TEXT NOT NULL,
  attachment_id   TEXT NOT NULL,
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  next_attempt_at INTEGER,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attachment_download_failures_owner
  ON attachment_download_failures (owner_id);

CREATE TABLE IF NOT EXISTS attachment_files (
  note_id       TEXT NOT NULL,
  path          TEXT NOT NULL,
  attachment_id TEXT,
  recorded_at   INTEGER NOT NULL,
  PRIMARY KEY (note_id, path)
);

CREATE TABLE IF NOT EXISTS deleted_asset_releases (
  item_type      TEXT NOT NULL,
  item_id        TEXT NOT NULL,
  deleted_at     INTEGER NOT NULL,
  attachment_ids TEXT,
  PRIMARY KEY (item_type, item_id)
);
