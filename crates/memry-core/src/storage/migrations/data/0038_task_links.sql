-- data.db, migration 0038: which tasks link to which note or canvas (Step 21,
-- #3538), for `tasks_get_linked_tasks` and the canvas entity lookups.
--
-- A task's links are `linkedNoteIds` (the `tasks.linked_note_ids` JSON column)
-- and `linkedCanvasIds` (no column: only the verbatim `sync_items.payload`), so
-- "the tasks linking to note X" scanned and parsed every task. `task_links`
-- holds one row per (task, target), keyed for lookup by target. Device-local,
-- derived, never synced.
--
-- Triggers keep it current for every writer of `tasks`. Every task write goes
-- through the task projector, which upserts `tasks` after the payload is in
-- `sync_items`, so the triggers read the canvas ids from the payload the
-- projector just stored. A build older than this migration opens the file
-- without knowing the table, and its task writes still fire the triggers, so
-- the table is never stale when this build opens the file again.
--
-- A live task holds rows; a tombstoned or removed one holds none. A trigger
-- first drops the task's rows (an `INSERT OR REPLACE` fires no delete trigger
-- for the row it replaces), then inserts the distinct targets, so its
-- insert never meets a key it has not just cleared and no conflict clause of
-- the writer's statement can make it fail. The dedupe cannot be `OR IGNORE`:
-- an upsert or an `OR` clause on the writer's statement overrides the
-- trigger's own. One `UNION` dedupes notes and canvases in a single insert.
-- Values that are not JSON, not an array, or not a non-empty string are
-- skipped, never an error: a nested `CASE` runs `json_type` only on valid
-- JSON, because SQLite does not promise to short-circuit `AND`, and
-- `json_each(NULL)` yields no row. `json_type` and `json_extract` reuse the parse
-- `json_valid` caches, so `json_each` parses only the extracted array;
-- `json_each(payload, path)` would parse the whole payload a second time.
CREATE TABLE IF NOT EXISTS task_links (
  task_id     TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  PRIMARY KEY (task_id, target_type, target_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_task_links_target ON task_links(target_type, target_id);

CREATE TRIGGER IF NOT EXISTS task_links_task_insert AFTER INSERT ON tasks
BEGIN
  DELETE FROM task_links WHERE task_id = new.id;
  INSERT INTO task_links (task_id, target_type, target_id)
  SELECT new.id, 'note', j.value
    FROM json_each(CASE WHEN new.deleted_at IS NULL AND json_valid(new.linked_note_ids) THEN
                  CASE WHEN json_type(new.linked_note_ids) = 'array'
                       THEN new.linked_note_ids END END) AS j
   WHERE j.type = 'text' AND j.value <> ''
  UNION
  SELECT new.id, 'canvas', j.value
    FROM sync_items AS s,
         json_each(CASE WHEN new.deleted_at IS NULL AND json_valid(s.payload) THEN
                  CASE WHEN json_type(s.payload, '$.linkedCanvasIds') = 'array'
                       THEN json_extract(s.payload, '$.linkedCanvasIds') END END) AS j
   WHERE s.item_type = 'task' AND s.item_id = new.id
     AND j.type = 'text' AND j.value <> '';
END;

CREATE TRIGGER IF NOT EXISTS task_links_task_update AFTER UPDATE ON tasks
BEGIN
  DELETE FROM task_links WHERE task_id = old.id OR task_id = new.id;
  INSERT INTO task_links (task_id, target_type, target_id)
  SELECT new.id, 'note', j.value
    FROM json_each(CASE WHEN new.deleted_at IS NULL AND json_valid(new.linked_note_ids) THEN
                  CASE WHEN json_type(new.linked_note_ids) = 'array'
                       THEN new.linked_note_ids END END) AS j
   WHERE j.type = 'text' AND j.value <> ''
  UNION
  SELECT new.id, 'canvas', j.value
    FROM sync_items AS s,
         json_each(CASE WHEN new.deleted_at IS NULL AND json_valid(s.payload) THEN
                  CASE WHEN json_type(s.payload, '$.linkedCanvasIds') = 'array'
                       THEN json_extract(s.payload, '$.linkedCanvasIds') END END) AS j
   WHERE s.item_type = 'task' AND s.item_id = new.id
     AND j.type = 'text' AND j.value <> '';
END;

CREATE TRIGGER IF NOT EXISTS task_links_task_delete AFTER DELETE ON tasks
BEGIN
  DELETE FROM task_links WHERE task_id = old.id;
END;

-- Every live task's links as they stand. The re-run after a crash between this
-- commit and the `user_version` write (§A.0) finds the same rows, and
-- `OR IGNORE` keeps it a no-op.
INSERT OR IGNORE INTO task_links (task_id, target_type, target_id)
SELECT DISTINCT t.id, 'note', j.value
  FROM tasks AS t,
       json_each(CASE WHEN json_valid(t.linked_note_ids) THEN
                CASE WHEN json_type(t.linked_note_ids) = 'array'
                     THEN t.linked_note_ids END END) AS j
 WHERE t.deleted_at IS NULL AND j.type = 'text' AND j.value <> '';
INSERT OR IGNORE INTO task_links (task_id, target_type, target_id)
SELECT DISTINCT t.id, 'canvas', j.value
  FROM tasks AS t
  JOIN sync_items AS s ON s.item_type = 'task' AND s.item_id = t.id,
       json_each(CASE WHEN json_valid(s.payload) THEN
                CASE WHEN json_type(s.payload, '$.linkedCanvasIds') = 'array'
                     THEN json_extract(s.payload, '$.linkedCanvasIds') END END) AS j
 WHERE t.deleted_at IS NULL AND j.type = 'text' AND j.value <> '';

-- Additive: one new table and triggers that write only to it. No existing
-- table or row changes.
