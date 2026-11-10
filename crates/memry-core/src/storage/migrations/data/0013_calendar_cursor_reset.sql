-- Pull every Google and CalDAV calendar in full once (#4022).
--
-- Before this release, turning a calendar off or disconnecting its account
-- deleted the calendar's events but kept its sync cursor. Turning it back on
-- or reconnecting then pulled incrementally from that cursor, which returns
-- only events changed since, so the deleted events never came back. Those
-- vaults are still missing them, and nothing tells an affected cursor apart.
--
-- Data-only and row-preserving: the cursor is a cache of pull progress, not
-- user data. The next pass pulls each calendar's window again and upserts the
-- events by id, so the events already present are rewritten, not duplicated.
-- Desktop's migration 0080 resets Google only, because its CalDAV deselect
-- already cleared the cursor; the core's did not.
--
-- The cursor lives in the synced payload and in the `calendar_sources`
-- projection of it. Both change, or the next edit of the source would project
-- the old cursor back from the payload. No clock moves and nothing is queued:
-- a peer's merge keeps its own cursor over a null anyway. Re-running it is a
-- no-op, which the crash window in migrations.rs relies on.
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
