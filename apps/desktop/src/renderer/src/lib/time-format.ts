import type { GeneralSettings } from '@memry/contracts/settings-schemas'
import { getActiveLocale } from '@/lib/active-locale'

export type ClockFormat = GeneralSettings['clockFormat']

// Module-scoped clock format so pure (non-React) helpers and Intl calls follow the
// user's 12h/24h setting, the same way `setDateFormatPref` serves date helpers.
// Kept in sync by useClockFormatSync at the app root. '12h' is the settings default.
let currentClockFormat: ClockFormat = '12h'

export function setClockFormatPref(format: ClockFormat): void {
  currentClockFormat = format
}

export function getClockFormatPref(): ClockFormat {
  return currentClockFormat
}

/** `hour12` for an Intl call that shows a time, so it honors the clock setting. */
export function isHour12(format: ClockFormat = currentClockFormat): boolean {
  return format === '12h'
}

// Any fixed calendar day works: only the time-of-day is ever formatted, so this
// just gives Intl a Date to read the hour and minute off.
const CLOCK_REFERENCE_YEAR = 2000

export function formatHour(hour: number, format: ClockFormat): string {
  if (format === '24h') {
    return `${String(hour).padStart(2, '0')}:00`
  }
  return new Intl.DateTimeFormat(getActiveLocale(), {
    hour: 'numeric',
    hour12: true
  }).format(new Date(CLOCK_REFERENCE_YEAR, 0, 1, hour))
}

export function formatTimeOfDay(date: Date, format: ClockFormat): string {
  return new Intl.DateTimeFormat(getActiveLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    hour12: format === '12h'
  }).format(date)
}

export function formatTimeString(time: string, format: ClockFormat): string {
  const [hours, minutes] = time.split(':').map(Number)
  // Stored times that are not `HH:mm` (an empty-ish value, `"9"`, anything an
  // older version or an importer wrote) used to degrade into a garbage string.
  // Intl would build an Invalid Date out of them and throw mid-render instead,
  // so hand the raw value back rather than taking the whole view down.
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return time
  if (format === '24h') {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
  }
  return new Intl.DateTimeFormat(getActiveLocale(), {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(new Date(CLOCK_REFERENCE_YEAR, 0, 1, hours, minutes))
}
