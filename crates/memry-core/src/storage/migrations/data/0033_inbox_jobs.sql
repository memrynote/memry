-- data.db, migration 0033: the Inbox's background jobs (Step 27, #3544): link
-- metadata, article extraction and voice transcription, resumable after a
-- restart (desktop's `inbox_jobs`, `apps/desktop/src/main/inbox/jobs.ts`).
--
-- Local only: never synced, never in the outbox. One row per (capture, type),
-- as desktop's upsert keeps one current job per pair. Instants are epoch
-- milliseconds. No foreign key: a capture is a tombstoned sync record, so a job
-- whose capture is gone is dropped by `resume_pending`.
CREATE TABLE IF NOT EXISTS inbox_jobs (
  id           TEXT PRIMARY KEY,
  item_id      TEXT NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  next_run_at  INTEGER NOT NULL,
  last_error   TEXT,
  started_at   INTEGER,
  completed_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_jobs_item_type ON inbox_jobs (item_id, type);
CREATE INDEX IF NOT EXISTS idx_inbox_jobs_due ON inbox_jobs (status, next_run_at);
