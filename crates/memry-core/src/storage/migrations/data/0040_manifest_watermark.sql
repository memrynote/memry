-- data.db, migration 0040: the manifest check's watermark is dropped by any
-- local change it cannot vouch for (#5861).
--
-- `sync.manifest_watermark` in `meta` (`sync/hardening/manifest_watermark.rs`)
-- lets a manifest check list only the server rows written after the last
-- complete one. That skips the local-only direction, which is sound only while
-- no row can have left the outbox or `sync_items` since: a push acknowledged
-- or dropped turns a queued row into one the server must list, and a removed
-- row may be one the server still lists. These triggers delete the watermark
-- in the transaction of every such delete, so the next check lists everything.
-- `task_activity` is neither listed nor re-uploaded by the check, so its
-- pruning keeps the watermark. A build older than this migration writes no
-- watermark, and its deletes still fire the triggers.
CREATE TRIGGER IF NOT EXISTS manifest_watermark_outbox_delete AFTER DELETE ON outbox
WHEN OLD.item_type <> 'task_activity'
BEGIN
  DELETE FROM meta WHERE key = 'sync.manifest_watermark';
END;

CREATE TRIGGER IF NOT EXISTS manifest_watermark_sync_items_delete AFTER DELETE ON sync_items
WHEN OLD.item_type <> 'task_activity'
BEGIN
  DELETE FROM meta WHERE key = 'sync.manifest_watermark';
END;
