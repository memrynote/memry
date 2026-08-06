-- Last-seen cumulative download total per GitHub release asset.
--
-- `assets[].download_count` from `GET /repos/:owner/:repo/releases` is CUMULATIVE
-- per asset. Emitting it raw produces a monotonically increasing counter that is
-- useless as an event stream, and it fails silently rather than erroring — the
-- numbers just quietly stop meaning "downloads". The daily cron therefore stores
-- the last total it saw here and emits only the DELTA. The first run for an asset
-- seeds its row and emits nothing.
--
-- Purely additive: a new table nothing else reads or writes, so a Worker deployed
-- before this migration (or rolled back after it) is unaffected.
CREATE TABLE IF NOT EXISTS release_download_counts (
  asset_id TEXT PRIMARY KEY,
  release_tag TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  download_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
