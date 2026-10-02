-- data.db, migration 0009: the `bookmark` projection (the sidebar's bookmarks).
--
-- Additive only: one new table, no existing table or row touched. Like every
-- table 0002 creates, it is a cache of a parse of `sync_items.payload` and is
-- rebuildable by replaying the `bookmark` rows through their projector. An
-- install that migrated before the core subscribed to `bookmark` holds no
-- bookmark rows at all; the grown declaration restarts the record feed
-- (`sync::feed_restart`), which brings them in.
--
-- `item_type` and `item_id` name the bookmarked item (desktop's
-- `bookmarks` table, `BookmarkSyncPayloadSchema`). `created_at` is epoch
-- milliseconds, like every instant column (§A.6).
CREATE TABLE IF NOT EXISTS bookmarks (
  id         TEXT PRIMARY KEY,
  item_type  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS bookmarks_position ON bookmarks (position);
