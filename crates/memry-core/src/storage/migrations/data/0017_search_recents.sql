-- data.db, migration 0017: the search sheet's recently opened results (#4322),
-- desktop's `search_reasons`.
--
-- Additive only: one new table, no existing table or row touched. Device-local
-- UI state, not a projection: no record feeds it, nothing syncs it, and
-- signing out deletes it with the rest of `data.db`. `query` is the text that
-- found the item, so it stays out of logs and telemetry.
--
-- One row per item, so reopening an item moves it to the top instead of
-- listing it twice. `visited_at` is epoch milliseconds (§A.6).
CREATE TABLE IF NOT EXISTS search_recents (
  item_type  TEXT NOT NULL,
  item_id    TEXT NOT NULL,
  title      TEXT NOT NULL,
  query      TEXT NOT NULL,
  visited_at INTEGER NOT NULL,
  PRIMARY KEY (item_type, item_id)
);

CREATE INDEX IF NOT EXISTS search_recents_visited ON search_recents (visited_at);
