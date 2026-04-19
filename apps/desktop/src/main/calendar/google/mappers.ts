import type { NewCalendarExternalEvent } from '@memry/db-schema/schema/calendar-external-events'
import type {
  calendarEvents,
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'
import type { inboxItems } from '@memry/db-schema/schema/inbox'
import type { reminders } from '@memry/db-schema/schema/reminders'
import type { tasks } from '@memry/db-schema/schema/tasks'
import type {
  CalendarSyncSourceType,
  GoogleCalendarRemoteEvent,
  GoogleCalendarUpsertEventInput
} from '../types'

export interface CalendarEventChanges {
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  isAllDay: boolean
  timezone: string
  attendees: CalendarAttendee[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  colorId: string | null
  conferenceData: CalendarConferenceData | null
  parentEventId: string | null
  originalStartTime: string | null
}

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function toTimeZoneDateParts(
  iso: string,
  timeZone: string
): { year: string; month: string; day: string; hour: string; minute: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })

  const parts = formatter.formatToParts(new Date(iso))
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? ''

  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute')
  }
}

function toLocalDateTime(dateStr: string, timeStr: string | null): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hours, minutes] = (timeStr ?? '00:00').split(':').map(Number)
  return new Date(year, month - 1, day, hours, minutes, 0, 0).toISOString()
}

function toLocalAllDayEnd(dateStr: string): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day + 1, 0, 0, 0, 0).toISOString()
}

function toGoogleRecurrenceArray(
  rule: Record<string, unknown> | null | undefined
): string[] | null {
  if (!rule) return null
  const rrule = typeof rule.rrule === 'string' ? rule.rrule : null
  return rrule ? [`RRULE:${rrule}`] : null
}

function isoToIcalStamp(iso: string, keepZ: boolean): string {
  // Strip separators: 2026-05-10T09:00:00.000Z → 20260510T090000Z
  const trimmed = iso.replace(/\.\d+/, '')
  const compact = trimmed.replace(/[-:]/g, '')
  return keepZ ? compact : compact.replace(/Z$/, '')
}

function buildExdateLine(iso: string, timezone: string): string {
  if (timezone === 'UTC') {
    return `EXDATE:${isoToIcalStamp(iso, true)}`
  }
  return `EXDATE;TZID=${timezone}:${isoToIcalStamp(iso, false)}`
}

function toGoogleRecurrenceWithExceptions(
  rule: Record<string, unknown> | null | undefined,
  exceptions: string[] | null | undefined,
  timezone: string
): string[] | null {
  const rruleLines = toGoogleRecurrenceArray(rule) ?? []
  const exdateLines =
    exceptions && exceptions.length > 0
      ? exceptions.map((iso) => buildExdateLine(iso, timezone))
      : []

  const all = [...rruleLines, ...exdateLines]
  return all.length > 0 ? all : null
}

export function mapCalendarEventToGoogleInput(
  row: typeof calendarEvents.$inferSelect
): GoogleCalendarUpsertEventInput {
  return {
    sourceType: 'event',
    sourceId: row.id,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    startAt: row.startAt,
    endAt: row.endAt ?? null,
    isAllDay: row.isAllDay,
    timezone: row.timezone,
    recurrence: toGoogleRecurrenceWithExceptions(
      row.recurrenceRule as Record<string, unknown> | null,
      row.recurrenceExceptions ?? null,
      row.timezone
    ),
    attendees: row.attendees ?? null,
    reminders: row.reminders ?? null,
    visibility: row.visibility ?? null,
    colorId: row.colorId ?? null,
    conferenceData: row.conferenceData ?? null,
    recurringEventId: row.parentEventId ?? null,
    originalStartTime: row.originalStartTime ?? null
  }
}

export function mapTaskToGoogleInput(
  row: typeof tasks.$inferSelect
): GoogleCalendarUpsertEventInput {
  if (!row.dueDate) {
    throw new Error(`Task ${row.id} is not scheduled on the calendar`)
  }

  const isAllDay = !row.dueTime

  return {
    sourceType: 'task',
    sourceId: row.id,
    title: row.title,
    description: row.description ?? null,
    location: null,
    startAt: toLocalDateTime(row.dueDate, row.dueTime ?? null),
    endAt: isAllDay ? toLocalAllDayEnd(row.dueDate) : null,
    isAllDay,
    timezone: LOCAL_TIMEZONE,
    recurrence: null
  }
}

export function mapReminderToGoogleInput(
  row: typeof reminders.$inferSelect
): GoogleCalendarUpsertEventInput {
  const startAt = row.status === 'snoozed' && row.snoozedUntil ? row.snoozedUntil : row.remindAt

  return {
    sourceType: 'reminder',
    sourceId: row.id,
    title: row.title?.trim() || 'Reminder',
    description: row.note ?? row.highlightText ?? null,
    location: null,
    startAt,
    endAt: null,
    isAllDay: false,
    timezone: LOCAL_TIMEZONE,
    recurrence: null
  }
}

export function mapInboxSnoozeToGoogleInput(
  row: typeof inboxItems.$inferSelect
): GoogleCalendarUpsertEventInput {
  if (!row.snoozedUntil) {
    throw new Error(`Inbox item ${row.id} is not snoozed`)
  }

  return {
    sourceType: 'inbox_snooze',
    sourceId: row.id,
    title: row.title,
    description: row.content ?? null,
    location: null,
    startAt: row.snoozedUntil,
    endAt: null,
    isAllDay: false,
    timezone: LOCAL_TIMEZONE,
    recurrence: null
  }
}

export function mapGoogleEventToExternalEventRecord(
  sourceId: string,
  event: GoogleCalendarRemoteEvent,
  now: string
): NewCalendarExternalEvent {
  return {
    id: `calendar_external_event:${sourceId}:${event.id}`,
    sourceId,
    remoteEventId: event.id,
    remoteEtag: event.etag,
    remoteUpdatedAt: event.updatedAt,
    title: event.title,
    description: event.description,
    location: event.location,
    startAt: event.startAt,
    endAt: event.endAt,
    timezone: event.timezone,
    isAllDay: event.isAllDay,
    status: event.status,
    recurrenceRule: null,
    attendees: event.attendees ?? null,
    reminders: event.reminders ?? null,
    visibility: event.visibility ?? null,
    colorId: event.colorId ?? null,
    conferenceData: event.conferenceData ?? null,
    rawPayload: event.raw,
    archivedAt: event.status === 'cancelled' ? now : null,
    createdAt: now,
    modifiedAt: now
  }
}

export function mapGoogleEventToCalendarEventChanges(
  event: GoogleCalendarRemoteEvent
): CalendarEventChanges {
  return {
    title: event.title,
    description: event.description,
    location: event.location,
    startAt: event.startAt,
    endAt: event.endAt,
    isAllDay: event.isAllDay,
    timezone: event.timezone,
    attendees: event.attendees ?? null,
    reminders: event.reminders ?? null,
    visibility: event.visibility ?? null,
    colorId: event.colorId ?? null,
    conferenceData: event.conferenceData ?? null,
    parentEventId: event.recurringEventId ?? null,
    originalStartTime: event.originalStartTime ?? null
  }
}

export function mapGoogleEventToTaskSchedule(event: GoogleCalendarRemoteEvent): {
  dueDate: string
  dueTime: string | null
} {
  const timeZone = event.timezone || LOCAL_TIMEZONE

  if (event.isAllDay) {
    const parts = toTimeZoneDateParts(event.startAt, timeZone)
    return {
      dueDate: `${parts.year}-${parts.month}-${parts.day}`,
      dueTime: null
    }
  }

  const parts = toTimeZoneDateParts(event.startAt, timeZone)
  return {
    dueDate: `${parts.year}-${parts.month}-${parts.day}`,
    dueTime: `${parts.hour}:${parts.minute}`
  }
}

export function mapGoogleEventToReminderAt(event: GoogleCalendarRemoteEvent): string {
  if (event.isAllDay) {
    return event.startAt.replace(/T.*$/, 'T00:00:00.000Z')
  }

  return event.startAt
}

export function getLocalSourceTimezone(event: GoogleCalendarRemoteEvent): string {
  return event.timezone || LOCAL_TIMEZONE
}

export function supportsDeleteClearSchedule(sourceType: CalendarSyncSourceType): boolean {
  return sourceType !== 'event'
}
