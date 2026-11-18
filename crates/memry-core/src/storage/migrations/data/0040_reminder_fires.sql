-- data.db, migration 0040: which fire instant of each reminder this device has
-- already shown (Step 21f, #3538).
--
-- Local only: never synced, never in the outbox. Desktop marks a fired reminder
-- `status = 'triggered'` and never sends that status (`reminder-outbound.ts`),
-- so a peer's `pending` copy has to be kept from un-firing it (`a4e8920c55`).
-- Here the reminder's synced status is never touched: a reminder is due when no
-- row records its current fire instant (`snoozedUntil` when snoozed, else
-- `remindAt`), so a pulled copy with the same instant cannot refire it, and a
-- new `remindAt` or a snooze moves the instant and fires it again. Instants are
-- epoch milliseconds. No foreign key: a reminder is a tombstoned sync record.
CREATE TABLE IF NOT EXISTS reminder_fires (
  reminder_id  TEXT PRIMARY KEY,
  fired_for_ms INTEGER NOT NULL,
  fired_at_ms  INTEGER NOT NULL
);
