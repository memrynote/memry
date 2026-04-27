-- M5: full-body inline hashtag index for notes_cache tag filtering.

ALTER TABLE notes_cache ADD COLUMN inline_tags_json text NOT NULL DEFAULT '[]';
