-- Saved folder-view configurations for a tag.
-- Additive and nullable: existing rows keep NULL, which the handler reads as
-- "no saved views" and resolves to DEFAULT_VIEW, exactly as a folder with no
-- views in its .folder.md does.
ALTER TABLE tag_definitions ADD COLUMN views TEXT;
