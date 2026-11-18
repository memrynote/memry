-- data.db, migration 0042: the graph view's saved node positions (Step 30g, #3547).
--
-- MUST NOT LAND BEFORE 0035-0041: those numbers belong to open PRs (0035
-- #4879, 0036 #4891, 0037 #5069, 0038 #5090, 0039 #5135, 0040 #5144, 0041
-- Step 27 stage 5). A migration list is applied in ascending order, so this
-- file merging first would leave a vault at 42 that never runs them.
--
-- Electron keeps `graph_layouts` in index.db (`drizzle-index/0022`), where an
-- index rebuild erases the user's pinned nodes. Here it is in data.db, which
-- is never rebuilt. `layout_json` is the JSON Electron stores in `positions`,
-- unchanged (`{"version": 1, "nodes": {"<id>": {"x", "y", "pinned"?}}}`), so
-- Step 36 copies an Electron row as is; a value that does not parse reads as
-- no layout (`domain::graph::layouts`). `updated_at` is epoch milliseconds
-- (§A.6). Device-local and never synced.
--
-- Additive only: one new table, no existing table or row touched, re-runnable
-- (§A.0). An older build skips the version and never reads the table.
CREATE TABLE IF NOT EXISTS graph_layouts (
  view_key    TEXT PRIMARY KEY,
  layout_json TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
