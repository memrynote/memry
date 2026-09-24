-- data.db, migration 0003: the `filter` projection (saved task filters).
--
-- Additive only: one new table, no existing table or row touched. Like every
-- table 0002 creates, it is a cache of a parse of `sync_items.payload` and is
-- rebuildable by replaying the `filter` rows through their projector, so an
-- install that migrated before the core subscribed to `filter` loses nothing.
--
-- `config` is the payload's `config` as JSON text, kept opaque: desktop
-- declares it `z.unknown()` on the wire (`FilterSyncPayloadSchema`) and a key
-- a newer build adds rides in the verbatim payload regardless.
-- `created_at` is epoch milliseconds, like every instant column (§A.6).
CREATE TABLE IF NOT EXISTS saved_filters (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  config     TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER,
  clock      TEXT,
  synced_at  INTEGER,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS saved_filters_position ON saved_filters (position);
