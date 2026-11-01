-- The names a wiki link resolves by, keyed for lookup (desktop Step 13i, #3530).
--
-- Resolving a link read every live note and day, so a hover, a broken-link check
-- or a click cost a read of the whole vault. `wiki_name_keys` holds each live
-- row's keys (`wiki_target::Claims`), so a lookup reads only the rows that claim
-- one of its keys. The keys fold Unicode case, which SQLite's `lower()` does
-- not, so the core computes them; SQL cannot keep them current itself. The
-- triggers below list every id whose names changed in `wiki_names_owed`, for
-- every writer, and a lookup reads each owed row whole until the next reindex
-- stores its keys again (`wiki_target::settle_name_keys`). Device-local,
-- derived, never synced.
CREATE TABLE IF NOT EXISTS wiki_name_keys (
  key TEXT NOT NULL,
  id  TEXT NOT NULL,
  PRIMARY KEY (key, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_wiki_name_keys_id ON wiki_name_keys(id);

-- No key: a trigger only appends, so no writer's conflict clause can make it fail.
CREATE TABLE IF NOT EXISTS wiki_names_owed (id TEXT NOT NULL);

CREATE TRIGGER IF NOT EXISTS wiki_names_note_insert AFTER INSERT ON notes
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (new.id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_names_note_update AFTER UPDATE ON notes
WHEN old.id IS NOT new.id OR old.title IS NOT new.title
  OR old.folder_path IS NOT new.folder_path OR old.file_type IS NOT new.file_type
  OR old.aliases IS NOT new.aliases OR old.deleted_at IS NOT new.deleted_at
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (old.id), (new.id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_names_note_delete AFTER DELETE ON notes
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (old.id);
END;

CREATE TRIGGER IF NOT EXISTS wiki_names_day_insert AFTER INSERT ON journal_entries
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (new.id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_names_day_update AFTER UPDATE ON journal_entries
WHEN old.id IS NOT new.id OR old.date IS NOT new.date
  OR old.deleted_at IS NOT new.deleted_at
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (old.id), (new.id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_names_day_delete AFTER DELETE ON journal_entries
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (old.id);
END;

CREATE TRIGGER IF NOT EXISTS wiki_names_day_aliases_insert AFTER INSERT ON journal_aliases
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (new.journal_id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_names_day_aliases_update AFTER UPDATE ON journal_aliases
WHEN old.journal_id IS NOT new.journal_id OR old.aliases IS NOT new.aliases
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (old.journal_id), (new.journal_id);
END;
CREATE TRIGGER IF NOT EXISTS wiki_names_day_aliases_delete AFTER DELETE ON journal_aliases
BEGIN
  INSERT INTO wiki_names_owed (id) VALUES (old.journal_id);
END;

-- Every existing row is owed its keys; the first reindex stores them. The
-- re-run after a crash between this commit and the `user_version` write (§A.0)
-- lists them again, which costs one more settle and nothing else.
INSERT INTO wiki_names_owed (id) SELECT id FROM notes UNION SELECT id FROM journal_entries;

-- Additive: two new tables, and triggers that write only to them. No existing
-- table or row changes.
