/**
 * Reminder Components
 *
 * @module components/reminder
 */

export { ReminderPicker } from './reminder-picker'
export type { ReminderPickerProps } from './reminder-picker'
export { RemindersList } from './reminders-list'
export { RemindersPanel, RemindersBellButton } from './reminders-panel'
export {
  HighlightReminderPopover,
  useTextSelection,
  type HighlightSelection,
  type HighlightReminderPopoverProps
} from './highlight-reminder-popover'
export {
  standardPresets,
  journalPresets,
  snoozePresets,
  formatReminderDate,
  formatRelativeTime,
  isOverdue,
  getReminderTimeLabel,
  getTomorrow,
  getNextMonday,
  getNextWeekend,
  getNextOccurrenceOfHour,
  getInDays,
  getInWeeks,
  getInMonths,
  getLaterToday,
  type ReminderPreset
} from './reminder-presets'
