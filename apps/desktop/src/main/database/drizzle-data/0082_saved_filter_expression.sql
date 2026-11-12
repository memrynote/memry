-- A saved filter's advanced rules (`expression`), which sync beside `config`
-- as a top-level payload key (docs/protocol §13.7.14).
--
-- The 0058 pattern: a build that has 0057 (#2265) but not this migration
-- captured a peer's `expression` into sync_unknown_fields (#2183), and its
-- push put it back. Adopt it here, once, or this build's first push would send
-- `expression: null` from the empty column and the locally built key would
-- win over the captured one.
--
-- A downgrade is inert: an older build never selects this column (Drizzle
-- lists columns explicitly), its payload schema strips the key into
-- sync_unknown_fields again, and its newest journal `when` is lower than this
-- one's, so its migrator applies nothing.
ALTER TABLE `saved_filters` ADD COLUMN `expression` text;
--> statement-breakpoint
UPDATE `saved_filters`
SET `expression` = (
	SELECT json_extract(u.`fields`, '$.expression')
	FROM `sync_unknown_fields` u
	WHERE u.`type` = 'filter'
		AND u.`item_id` = `saved_filters`.`id`
		-- CASE, not AND: SQLite does not promise to short-circuit, and
		-- json_type throws on malformed JSON (a failed migration bricks startup).
		AND CASE WHEN json_valid(u.`fields`) THEN json_type(u.`fields`, '$.expression') END = 'object'
)
WHERE `saved_filters`.`expression` IS NULL
	AND EXISTS (
		SELECT 1
		FROM `sync_unknown_fields` u
		WHERE u.`type` = 'filter'
			AND u.`item_id` = `saved_filters`.`id`
			AND CASE WHEN json_valid(u.`fields`) THEN json_type(u.`fields`, '$.expression') END = 'object'
	);
