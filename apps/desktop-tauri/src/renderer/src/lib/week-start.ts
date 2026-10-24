// Global first-day-of-week, mirrored from the Calendar `weekStartDay` setting by
// useWeekStartSync (App root). Non-React consumers that can't read hooks — the
// raw-DOM date-mention pill and the pure task-filter utils — read it from here.
// 0 = Sunday, 1 = Monday. Defaults to Monday to match CALENDAR_SETTINGS_DEFAULTS.
let weekStartsOn: 0 | 1 = 1

export function setWeekStartsOn(value: 0 | 1): void {
  weekStartsOn = value
}

export function getWeekStartsOn(): 0 | 1 {
  return weekStartsOn
}
