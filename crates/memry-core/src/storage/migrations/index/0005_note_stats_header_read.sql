-- index.db, migration 0005: whether a `note_stats` row read its file's frontmatter
-- header (#3825).
--
-- `header_read` is 0 when the file's block did not parse, or its top level is not
-- a map: `header_tags` is then empty and says nothing of the file's tags, so an
-- outside edit of a journal day is never read against it. A row an older build
-- wrote with no header tags may be such a file, so it is not taken as read until
-- the index measures its file again. An older build finds this file at a newer
-- version and rebuilds it, as it does any index it did not write.
ALTER TABLE note_stats ADD COLUMN header_read INTEGER NOT NULL DEFAULT 1;
UPDATE note_stats SET header_read = 0 WHERE header_tags = '[]';
