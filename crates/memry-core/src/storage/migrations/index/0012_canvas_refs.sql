-- index.db, migration 0012: what each canvas's scene points at (Step 30d,
-- #3547; Electron's `canvas_entity_refs` and `canvas_entity_edges`,
-- `packages/db-schema/src/schema/canvas.ts`).
--
-- Advisory and never synced: `domain::canvas::edges` rewrites a canvas's rows
-- from its scene on every save, sync apply and vault-open reconcile. A ref is
-- one entity card on the canvas; an edge is one live arrow bound to two cards,
-- oriented the way it points. No foreign key: `canvases` lives in data.db, and
-- every read keeps only the rows of live canvases.
CREATE TABLE IF NOT EXISTS canvas_entity_refs (
  canvas_id   TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  PRIMARY KEY (canvas_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_canvas_refs_entity ON canvas_entity_refs (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS canvas_entity_edges (
  canvas_id   TEXT NOT NULL,
  arrow_id    TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  PRIMARY KEY (canvas_id, arrow_id)
);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_source ON canvas_entity_edges (source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_canvas_edges_target ON canvas_entity_edges (target_type, target_id);
