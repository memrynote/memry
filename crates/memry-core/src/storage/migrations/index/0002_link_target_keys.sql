-- keys are resolved again. SQLite's `lower()` and `NOCASE` fold ASCII only, so
-- the key is computed in Rust and stored. NULL for a target with no key.
--
-- index.db is rebuilt rather than migrated (§A.0), so this runs only on a
-- fresh file, and the rebuild's full reindex writes every key.
ALTER TABLE note_links ADD COLUMN target_key TEXT;
CREATE INDEX IF NOT EXISTS note_links_target_key ON note_links (target_key);
CREATE INDEX IF NOT EXISTS note_links_target_id ON note_links (target_id);
