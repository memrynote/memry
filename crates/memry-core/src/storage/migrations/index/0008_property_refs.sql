-- index.db, migration 0008: the relations each note's properties name (Electron's
-- `property_refs`, `packages/db-schema/src/schema/notes-cache.ts`), so the notes that
-- relate to an item are an index seek on (target_type, target_id).
--
-- Derived from `note_properties` by `note_properties::replace` and dropped with
-- its rows, never synced. A row per property, kind and id: a value counts only
-- when it is a non-empty list of `memry://<kind>/<id>` relation URIs
-- (`parseRelationValue`, `property_values::parse_relation_uri`).
CREATE TABLE IF NOT EXISTS property_refs (
  source_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  PRIMARY KEY (source_id, name, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_property_refs_target ON property_refs (target_type, target_id);

-- An index migrated in place already holds its notes' `note_properties`, and the
-- note index reads a file again only when it changes: fill the table from those
-- rows now, with the same rule. `INSERT OR IGNORE` keeps a second run a no-op.
WITH elements AS (
  SELECT p.note_id, p.name, e.type AS kind_of, e.value AS text, substr(e.value, 9) AS rest
  FROM note_properties p, json_each(p.value) e
  WHERE p.type IN ('relation', 'project', 'multiselect')
    AND json_valid(p.value) AND json_type(p.value) = 'array'
),
parsed AS (
  SELECT note_id, name,
    CASE WHEN kind_of = 'text' AND substr(text, 1, 8) = 'memry://' AND instr(rest, '/') > 0
      THEN substr(rest, 1, instr(rest, '/') - 1) END AS kind,
    substr(rest, instr(rest, '/') + 1) AS id
  FROM elements
),
checked AS (
  SELECT note_id, name, kind, id,
    COALESCE(
      kind IN ('note', 'task', 'event', 'external-event', 'canvas', 'journal')
        AND id <> '' AND id NOT GLOB '*[^A-Za-z0-9_-]*'
        AND (kind <> 'journal' OR id GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
      0
    ) AS ok
  FROM parsed
)
INSERT OR IGNORE INTO property_refs (source_id, name, target_type, target_id)
SELECT c.note_id, c.name, c.kind, c.id FROM checked c
WHERE c.ok AND NOT EXISTS (
  SELECT 1 FROM checked d WHERE d.note_id = c.note_id AND d.name = c.name AND NOT d.ok
);
