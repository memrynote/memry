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
 * MUST stay character-identical to the SQL in migration 0040.
 */
export function noteDateReminderId(noteId: string, anchorId: string): string {
  return `rem_nd_${noteId}_${anchorId}`
}
