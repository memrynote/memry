import {
  CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
  type CalendarGoogleSettings
} from '@memry/contracts/settings-schemas'
import { getSetting } from '../../settings/settings-store'
import type { DataDb } from '../../database'

const CALENDAR_GOOGLE_SETTINGS_KEY = 'calendar.google'

export function readCalendarGoogleSettings(db: DataDb): CalendarGoogleSettings {
  const raw = getSetting(db, CALENDAR_GOOGLE_SETTINGS_KEY)
  if (!raw) return { ...CALENDAR_GOOGLE_SETTINGS_DEFAULTS }
  try {
    const parsed = JSON.parse(raw) as Partial<CalendarGoogleSettings>
    return { ...CALENDAR_GOOGLE_SETTINGS_DEFAULTS, ...parsed }
  } catch {
    return { ...CALENDAR_GOOGLE_SETTINGS_DEFAULTS }
  }
}
