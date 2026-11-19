-- MUST NOT LAND BEFORE data migrations 0035-0040, held by other open PRs: the
-- numbering tests fail until every lower number is in.
--
-- data.db, migration 0041: feedback on the Inbox's filing suggestions (Step 27,
-- #3544; Electron's `suggestion_feedback`, `packages/db-schema/src/schema/inbox.ts`,
-- written by `trackSuggestionFeedback`, `apps/desktop/src/main/inbox/suggestions.ts`).
--
-- Additive: one new table, no existing table or row touched, and an older build
-- never reads it. Local only: never synced, never in the outbox. `accepted` is
-- 0 or 1, `confidence` the suggestion's confidence times 100 rounded, the tag
-- columns JSON string arrays, `created_at` epoch milliseconds.
CREATE TABLE IF NOT EXISTS inbox_suggestion_feedback (
  id             TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL,
  item_type      TEXT NOT NULL,
  suggested_to   TEXT NOT NULL,
  actual_to      TEXT NOT NULL,
  accepted       INTEGER NOT NULL,
  confidence     INTEGER NOT NULL,
  suggested_tags TEXT NOT NULL DEFAULT '[]',
  actual_tags    TEXT NOT NULL DEFAULT '[]',
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_suggestion_feedback_item_type
  ON inbox_suggestion_feedback (item_type);
CREATE INDEX IF NOT EXISTS idx_inbox_suggestion_feedback_accepted
  ON inbox_suggestion_feedback (accepted);
CREATE INDEX IF NOT EXISTS idx_inbox_suggestion_feedback_created
  ON inbox_suggestion_feedback (created_at);
