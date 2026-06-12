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
