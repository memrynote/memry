-- data.db, migration 0036: the recently opened trail and the icon of a search
-- recent (desktop Step 30a, #3547).
--
-- Additive only: two new tables and one index, no existing table or row
-- touched. Both are device-local UI state, not projections: no record feeds
-- them, nothing syncs them, and signing out deletes them with the rest of
-- `data.db`. An older build never reads them.
--
-- `search_recent_icons` holds the icon a shell stored with a search recent
-- (Electron's `search_reasons.item_icon`), one row per `search_recents` row
-- that has one. A table rather than a column on `search_recents`, because
-- `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` (see 0005).
--
-- `recorded_at` is the `visited_at` of the visit the icon was recorded with.
-- A build that predates this table (0017 only) bumps `visited_at` when it
-- reopens an item and leaves the icon behind, so a reader shows an icon only
-- while `recorded_at` equals its recent's `visited_at`.
CREATE TABLE IF NOT EXISTS search_recent_icons (
  item_type   TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  icon        TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);

-- `recently_opened`: the notes and canvases this device opened, newest first
-- (Electron's `recently_opened`). One row per item, so reopening an item
-- bumps its row instead of adding one. The row stores no title: a reader
-- resolves the item and skips one that is gone. `opened_at` is epoch
-- milliseconds (§A.6).
CREATE TABLE IF NOT EXISTS recently_opened (
  item_type TEXT NOT NULL,
  item_id   TEXT NOT NULL,
  opened_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);

CREATE INDEX IF NOT EXISTS recently_opened_opened ON recently_opened (opened_at);
