-- Pull every Google and CalDAV calendar in full once more (#4069).
--
-- A source's sync cursor is this device's pull position, but it travels in the
-- synced `calendar_source` payload and a remote one used to overwrite the
-- local one. A device that took another device's cursor then listed the
-- calendar incrementally from that token, so every event it had purged or
-- never pulled stayed missing. Migration 13 cleared the cursors once, and a
-- peer's push put a foreign one back. The merge no longer adopts a remote
-- cursor (`calendar_items::merge`); this repairs vaults that already hold one.
-- Nothing tells a foreign cursor apart from this device's own, so all of them
-- reset.
--
-- Data-only and row-preserving, shaped like 0013: the cursor is a cache of pull
-- progress, not user data. The next pass pulls each calendar's window again
-- and upserts the events by id. The cursor lives in the synced payload and in
-- the `calendar_sources` projection of it, and both change, or the next edit of
-- the source would project the old cursor back. No clock moves and nothing is
-- queued. Re-running it is a no-op, which the crash window in migrations.rs
-- relies on.
UPDATE sync_items
   SET payload = json_set(payload, '$.syncCursor', NULL)
 WHERE item_type = 'calendar_source'
   AND payload IS NOT NULL
   AND json_valid(payload)
   AND json_extract(payload, '$.provider') IN ('google', 'caldav')
   AND json_extract(payload, '$.kind') = 'calendar'
   AND json_extract(payload, '$.syncCursor') IS NOT NULL;

UPDATE calendar_sources
   SET sync_cursor = NULL
 WHERE provider IN ('google', 'caldav')
   AND kind = 'calendar'
   AND sync_cursor IS NOT NULL;
