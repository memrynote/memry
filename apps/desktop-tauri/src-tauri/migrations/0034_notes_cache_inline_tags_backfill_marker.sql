-- M5: rows that existed before inline_tags_json was added all received the
-- empty-array default. Mark them as unindexed so the runtime backfill refreshes
-- full bodies once and then rewrites the real inline tag array.

UPDATE notes_cache SET inline_tags_json = 'null' WHERE inline_tags_json = '[]';
