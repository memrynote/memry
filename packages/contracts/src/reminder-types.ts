/**
 * Canonical reminder target/status types shared across contracts and schema.
 */

export const reminderTargetType = {
  NOTE: 'note',
  JOURNAL: 'journal',
  HIGHLIGHT: 'highlight',
  TASK: 'task',
  NOTE_DATE: 'note_date'
} as const

export type ReminderTargetType = (typeof reminderTargetType)[keyof typeof reminderTargetType]

export const reminderStatus = {
  PENDING: 'pending',
  TRIGGERED: 'triggered',
  DISMISSED: 'dismissed',
  SNOOZED: 'snoozed'
} as const

export type ReminderStatus = (typeof reminderStatus)[keyof typeof reminderStatus]

/**
 * Deterministic id for `note_date` reminders.
 *
 * These rows are derived from date pills in note markdown by
 * `syncNoteDateReminders`, which runs on every note write on EVERY device.
 * Because note content syncs via CRDT, device B derives the same reminder that
 * device A already synced. A random id would produce two rows for one pill;
 * this makes them the same row.
 *
 * MUST stay character-identical to the SQL in migration 0043.
 */
export function noteDateReminderId(noteId: string, anchorId: string): string {
  return `rem_nd_${noteId}_${anchorId}`
}

/**
 * Deterministic id for the ONE user-set reminder on a note or journal.
 *
 * Desktop mints a random `rem_<nanoid>` and resolves "one reminder per note" by
 * deleting the rows it can currently see. Two devices offline cannot see each
 * other's, so random ids give a note TWO reminders after the merge. Deriving
 * the id from the target makes those the same row and lets the vector clock
 * decide the time — the same reasoning `bookmarkSyncId` and
 * `noteDateReminderId` already encode.
 *
 * Distinct prefix from `rem_nd_`: `note_date` rows are owned by desktop's
 * note-content reconciler and must never collide with a user-set reminder.
 */
export function noteReminderSyncId(noteId: string): string {
  return `rem_note_${noteId}`
}
