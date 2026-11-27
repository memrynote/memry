-- data.db, migration 0040: every fire instant of each reminder this device has
-- already shown (Step 21f, #3538).
--
-- Local only: never synced, never in the outbox. Desktop marks a fired reminder
-- `status = 'triggered'` and never sends that status (`reminder-outbound.ts`),
-- so a peer's `pending` copy has to be kept from un-firing it (`a4e8920c55`).
-- Here the reminder's synced status is never touched: a reminder is due when
-- its current fire instant (`snoozedUntil` when snoozed, else `remindAt`) has
-- no row. One row per instant, not per reminder: a peer copy that turns a fired
-- snooze back into `pending` at its old `remindAt` names an instant already
-- shown and cannot refire it. A new `remindAt` or a snooze is a new instant and
-- fires again. Instants are epoch milliseconds. No foreign key: a reminder is a
-- tombstoned sync record.
CREATE TABLE IF NOT EXISTS reminder_fires (
  reminder_id  TEXT NOT NULL,
  fired_for_ms INTEGER NOT NULL,
  fired_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (reminder_id, fired_for_ms)
);
