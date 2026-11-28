-- data.db, migration 0019: when the re-drive asks again for an attachment
-- whose download failed.
--
-- Additive only: one new table, no existing table or row touched. Before it,
-- every sync pass and path change asked again for every missing attachment,
-- so one the server answers 404 for failed on every trigger, and 25 of them
-- held the re-drive's whole batch. A row here is written by a failed re-drive
-- and deleted by the download that lands. `next_attempt_at` NULL means no
-- automatic retry is left; opening the note still asks. An older build
-- ignores the table and re-drives as before.
CREATE TABLE IF NOT EXISTS attachment_download_failures (
  attachment_id   TEXT PRIMARY KEY,
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL CHECK (attempts > 0),
  next_attempt_at INTEGER,
  updated_at      INTEGER NOT NULL
) WITHOUT ROWID;
