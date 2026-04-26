-- M5: snapshot of derived list-view fields. Refreshed on notes_create /
-- notes_update / notes_delete. Avoids re-reading body markdown on list paginates.

CREATE TABLE IF NOT EXISTS notes_cache (
    id text PRIMARY KEY NOT NULL,
    title text NOT NULL,
    path text NOT NULL,
    snippet text NOT NULL DEFAULT '',
    word_count integer NOT NULL DEFAULT 0,
    tags_json text NOT NULL DEFAULT '[]',
    emoji text,
    modified_at text NOT NULL,
    created_at text NOT NULL,
    local_only integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_notes_cache_modified ON notes_cache (modified_at DESC);
