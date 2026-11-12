-- data.db, migration 0015: `saved_filter_expressions`, a saved filter's
-- advanced rules (the payload's top-level `expression`, §13.7.14).
--
-- Additive only: one new table, no existing table or row touched. A table
-- rather than a `saved_filters.expression` column for 0005's reason: `ALTER
-- TABLE ... ADD COLUMN` has no `IF NOT EXISTS`, so a crash between this
-- migration's commit and the `user_version` write (§A.0) would make the re-run
-- fail forever. An older build never reads the table.
--
-- `expression` is the payload's object as JSON text; no row means the payload
-- carries none. The backfill reads the verbatim payloads an older build
-- already stored, so a filter synced before this build keeps its rules.
CREATE TABLE IF NOT EXISTS saved_filter_expressions (
  filter_id  TEXT PRIMARY KEY,
  expression TEXT NOT NULL
);

INSERT OR IGNORE INTO saved_filter_expressions (filter_id, expression)
SELECT item_id, json_extract(payload, '$.expression')
  FROM sync_items
 WHERE item_type = 'filter'
   AND json_valid(payload)
   AND json_type(payload, '$.expression') = 'object';
