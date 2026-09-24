import type {
  CalendarEventAttendeeRecord,
  CalendarEventConferenceDataRecord,
  CalendarEventRemindersRecord,
  CalendarExternalEventDetails
} from '@memry/contracts/calendar-api'
import type { DataDb } from '../database'
import { getCalendarExternalEventById } from './repositories/calendar-external-events-repository'
import { getCalendarSourceById } from './repositories/calendar-sources-repository'

/**
 * One mirrored event with everything the read-only event card shows (#2374):
 * attendees, reminders, the join link and the series rule, plus which
 * calendar and account it belongs to. Null when the event is gone.
 */
export function getExternalEventDetails(
  db: DataDb,
  externalEventId: string
): CalendarExternalEventDetails | null {
  const row = getCalendarExternalEventById(db, externalEventId)
  if (!row) return null
  const source = getCalendarSourceById(db, row.sourceId)
  const sourceMetadata = (source?.metadata as Record<string, unknown> | null) ?? null
  const accountTitle =
    typeof sourceMetadata?.sourceTitle === 'string' ? sourceMetadata.sourceTitle : null

  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    startAt: row.startAt,
    endAt: row.endAt ?? null,
    timezone: row.timezone ?? null,
    isAllDay: row.isAllDay,
    status: row.status,
    recurrenceRule: row.recurrenceRule ?? null,
    attendees: (row.attendees as CalendarEventAttendeeRecord[] | null) ?? null,
    reminders: (row.reminders as CalendarEventRemindersRecord | null) ?? null,
    conferenceData: (row.conferenceData as CalendarEventConferenceDataRecord | null) ?? null,
    source: source
      ? {
          id: source.id,
          provider: source.provider,
          title: source.title,
          color: source.color ?? null,
          accountTitle
        }
      : null
  }
}
