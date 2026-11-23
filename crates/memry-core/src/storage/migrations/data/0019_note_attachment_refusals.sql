-- data.db, migration 0019: the refusal the shell was last told about for an
-- attachment still owed its upload (#5532).
--
-- Additive only: one new table. A later sync pass that the server refuses
-- again for the same status tells the shell nothing new, so the user sees
-- one alert per refusal rather than one per pass, across relaunches too. A
-- side table rather than a column on `note_attachment_uploads`, because
-- `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` (see 0016). An older
-- build ignores the table; a row it leaves behind once its upload lands
-- names an id no new attach reuses, so it is never read again.
CREATE TABLE IF NOT EXISTS note_attachment_refusals (
  attachment_id TEXT PRIMARY KEY,
  status        INTEGER NOT NULL
);
