/**
 * Snooze Components
 *
 * Components for snoozing inbox items.
 *
 * @module components/snooze
 */

export { SnoozePicker, QuickSnoozeButton } from './snooze-picker'
export type { SnoozePickerProps, QuickSnoozeButtonProps } from './snooze-picker'

export { SnoozeCountdown } from './snooze-countdown'
export type { SnoozeCountdownProps } from './snooze-countdown'

export { useSnoozeCountdown } from './use-snooze-countdown'

export {
  snoozePresets,
  quickSnoozePresets,
  laterToday,
  tomorrow,
  thisWeekend,
  nextWeek,
  inOneHour,
  inTwoHours,
  formatSnoozeTime,
  formatSnoozeDuration,
  formatSnoozeReturn
} from './snooze-presets'
export type { SnoozePreset } from './snooze-presets'
