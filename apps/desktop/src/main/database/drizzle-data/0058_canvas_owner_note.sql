-- Note-owned canvases: the canvas behind a note's inline `whiteboard` block.
--
-- Additive only. One nullable column, no DELETE, no rewrite of any existing
-- column. Existing installs upgrade with every canvas row reading
-- `owner_note_id = NULL`, which is exactly "free-standing" — the sidebar tree
-- and every query keep behaving as before.
--
-- The one fill: a build that has 0057 but not this migration strips a peer's
-- `ownerNoteId` into `sync_unknown_fields` (#2183). Left there, the first push
-- after upgrading would send the column's NULL, which beats the capture in
-- `mergeUnknownPayloadFields` and un-owns the canvas on every device. So the
-- captured value is adopted here, once. Only string values from valid JSON, only
-- into rows still NULL; with no capture this updates nothing.
--
-- A downgrade is inert: an older build never selects the column (Drizzle lists
-- columns explicitly), so owned boards simply reappear in its sidebar, and its
-- non-strict `CanvasSyncPayloadSchema` drops the unknown key instead of failing
-- the apply. Its max journal `when` is lower than this one's, so its migrator
-- applies nothing.
--
-- No foreign key to `notes`: a canvas may sync before the note that owns it,
-- and a FK would make apply order load-bearing.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
ALTER TABLE `canvases` ADD COLUMN `owner_note_id` text;
--> statement-breakpoint
UPDATE `canvases`
SET `owner_note_id` = (
	SELECT json_extract(u.`fields`, '$.ownerNoteId')
	FROM `sync_unknown_fields` u
	WHERE u.`type` = 'canvas' AND u.`item_id` = `canvases`.`id`
)
WHERE `owner_note_id` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `sync_unknown_fields` u
		WHERE u.`type` = 'canvas'
			AND u.`item_id` = `canvases`.`id`
			-- CASE, not AND: SQLite does not promise to short-circuit, and
			-- json_type throws on malformed JSON (a failed migration bricks startup).
			AND CASE WHEN json_valid(u.`fields`) THEN json_type(u.`fields`, '$.ownerNoteId') END = 'text'
	);
