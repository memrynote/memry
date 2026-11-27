-- BBF-43: builds before this one stored an unquoted YAML date as the JSON text
-- of a Date ("2026-10-07T00:00:00.000Z", quotes included) with type text, and
-- the indexer skips unchanged notes, so those rows would stay until each note
-- is edited. Rewrite them to the value the same date quoted in the file gives.
UPDATE `note_properties`
SET
  `type` = CASE WHEN `type` = 'text' THEN 'date' ELSE `type` END,
  `value` = CASE
    WHEN substr(`value`, 12, 14) = 'T00:00:00.000Z' THEN substr(`value`, 2, 10)
    ELSE substr(`value`, 2, 24)
  END
WHERE `value` GLOB '"[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z"';
