import type {
  GoogleCalendarDescriptorRecord,
  ListGoogleCalendarsResponse,
  SetDefaultGoogleCalendarInput,
  SetDefaultGoogleCalendarResponse
} from '@memry/contracts/calendar-api'
import {
  CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
  type CalendarGoogleSettings
} from '@memry/contracts/settings-schemas'
import { setSetting } from '../../settings/settings-store'
import type { DataDb } from '../../database'
import { readCalendarGoogleSettings } from './calendar-google-settings'
import type { GoogleCalendarClient, GoogleCalendarDescriptor } from '../types'

const CALENDAR_GOOGLE_SETTINGS_KEY = 'calendar.google'

function toDescriptorRecord(d: GoogleCalendarDescriptor): GoogleCalendarDescriptorRecord {
  return {
    id: d.id,
    title: d.title,
    timezone: d.timezone,
    color: d.color,
    isPrimary: d.isPrimary
  }
}

export async function listGoogleCalendars(
  db: DataDb,
  client: Pick<GoogleCalendarClient, 'listCalendars'>
): Promise<ListGoogleCalendarsResponse> {
  const remote = await client.listCalendars()
  const calendars = remote.map(toDescriptorRecord)
  const primary = calendars.find((c) => c.isPrimary) ?? null
  const { defaultTargetCalendarId } = readCalendarGoogleSettings(db)
  return {
    calendars,
    primary,
    currentDefaultId: defaultTargetCalendarId
  }
}

export function setDefaultGoogleCalendar(
  db: DataDb,
  input: SetDefaultGoogleCalendarInput
): SetDefaultGoogleCalendarResponse {
  const current = readCalendarGoogleSettings(db)
  const next: CalendarGoogleSettings = {
    ...CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
    ...current,
    defaultTargetCalendarId: input.calendarId,
    onboardingCompleted: input.markOnboardingComplete ? true : current.onboardingCompleted
  }
  setSetting(db, CALENDAR_GOOGLE_SETTINGS_KEY, JSON.stringify(next))
  return { success: true }
}
