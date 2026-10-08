-- Tags with fields: a tag's schema and a task's field values, both versioned
-- JSON (`@memry/shared/versioned`, protocol chapter 06 section 6.11).
--
-- Additive only. Two nullable columns, no DELETE, no rewrite of an existing
-- column. Every existing row reads NULL, which means "this device holds no
-- value": the sync handlers omit the key on push, so an upgrade never sends a
-- clear.
--
-- The one fill, the 0058 pattern: a build that has 0057 (#2265) but not this
-- migration captured a peer's `schema` and `fields` into sync_unknown_fields
-- (#2183). Left there, the UI would never show them and the first local edit
-- would stamp over an empty column. So the captured object is adopted here,
-- once: only an object from valid JSON, only into a column still NULL, and the
-- newest capture when a mixed-case tag name matches more than one. The tag join
-- keeps the NOCASE column on the left so a legacy mixed-case name matches its
-- lowercase item id. With no capture these statements update nothing. The
-- capture rows stay for the next pull of the item to rewrite.
--
-- A downgrade is inert: an older build never selects these columns (Drizzle
-- lists columns explicitly), its payload schemas strip the two keys, and its
-- newest journal `when` is lower than this one's, so its migrator applies
-- nothing.
--
-- Hand-written (project switched off the Drizzle generator after 0020).
ALTER TABLE `tag_definitions` ADD COLUMN `schema` text;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `fields` text;
--> statement-breakpoint
UPDATE `tag_definitions`
SET `schema` = (
	SELECT json_extract(u.`fields`, '$.schema')
	FROM `sync_unknown_fields` u
	WHERE u.`type` = 'tag_definition'
		AND `tag_definitions`.`name` = u.`item_id`
		-- CASE, not AND: SQLite does not promise to short-circuit, and
		-- json_type throws on malformed JSON (a failed migration bricks startup).
		AND CASE WHEN json_valid(u.`fields`) THEN json_type(u.`fields`, '$.schema') END = 'object'
	ORDER BY u.`updated_at` DESC
	LIMIT 1
)
WHERE `tag_definitions`.`schema` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `sync_unknown_fields` u
		WHERE u.`type` = 'tag_definition'
			AND `tag_definitions`.`name` = u.`item_id`
			AND CASE WHEN json_valid(u.`fields`) THEN json_type(u.`fields`, '$.schema') END = 'object'
	);
--> statement-breakpoint
UPDATE `tasks`
SET `fields` = (
	SELECT json_extract(u.`fields`, '$.fields')
	FROM `sync_unknown_fields` u
	WHERE u.`type` = 'task'
		AND u.`item_id` = `tasks`.`id`
		AND CASE WHEN json_valid(u.`fields`) THEN json_type(u.`fields`, '$.fields') END = 'object'
)
WHERE `tasks`.`fields` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `sync_unknown_fields` u
		WHERE u.`type` = 'task'
			AND u.`item_id` = `tasks`.`id`
			AND CASE WHEN json_valid(u.`fields`) THEN json_type(u.`fields`, '$.fields') END = 'object'
	);
