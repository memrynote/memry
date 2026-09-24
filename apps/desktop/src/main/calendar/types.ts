import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'

export type CalendarSyncSourceType = 'event' | 'task' | 'reminder' | 'inbox_snooze'

export interface CalendarSyncTarget {
  sourceType: CalendarSyncSourceType
  sourceId: string
}

export interface GoogleCalendarDescriptor {
  id: string
  title: string
  timezone: string | null
  color: string | null
  isPrimary: boolean
}

/**
 * A remote event as any writable provider returns it (#1391). The field names
 * are the ones the Google engine always used; `raw` is the provider's own
 * representation (Google's JSON, a CalDAV object's parsed iCalendar).
 */
export interface RemoteCalendarEvent {
  id: string
  calendarId: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  isAllDay: boolean
  timezone: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  etag: string | null
  updatedAt: string | null
  attendees: CalendarAttendee[] | null
  reminders: CalendarReminders | null
  visibility: CalendarVisibility | null
  colorId: string | null
  conferenceData: CalendarConferenceData | null
  recurringEventId: string | null
  originalStartTime: string | null
  raw: Record<string, unknown>
}

/** A Memry item as a provider receives it on push (#1391). */
export interface UpsertRemoteEventInput {
  sourceType: CalendarSyncSourceType
  sourceId: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  isAllDay: boolean
  timezone: string
  recurrence: string[] | null
  attendees?: CalendarAttendee[] | null
  reminders?: CalendarReminders | null
  visibility?: CalendarVisibility | null
  colorId?: string | null
  conferenceData?: CalendarConferenceData | null
  recurringEventId?: string | null
  originalStartTime?: string | null
}

/** Kept so the Google engine does not churn: the neutral types are the same shape. */
export type GoogleCalendarRemoteEvent = RemoteCalendarEvent
export type GoogleCalendarUpsertEventInput = UpsertRemoteEventInput

export interface GoogleCalendarClient {
  listCalendars(): Promise<GoogleCalendarDescriptor[]>
  createCalendar(input: { title: string; timezone: string }): Promise<GoogleCalendarDescriptor>
  listEvents(input: {
    calendarId: string
    syncCursor?: string | null
    timeMin?: string | null
    timeMax?: string | null
  }): Promise<{ events: GoogleCalendarRemoteEvent[]; nextSyncCursor: string | null }>
  getEvent(input: { calendarId: string; eventId: string }): Promise<GoogleCalendarRemoteEvent>
  upsertEvent(input: {
    calendarId: string
    eventId: string | null
    event: GoogleCalendarUpsertEventInput
    ifMatch?: string | null
  }): Promise<GoogleCalendarRemoteEvent>
  deleteEvent(input: { calendarId: string; eventId: string }): Promise<void>
  watchCalendar(input: {
    calendarId: string
    channelId: string
    token: string
    webhookUrl: string
    ttlSeconds: number
  }): Promise<{ resourceId: string; expiration: number }>
  stopChannel(input: { channelId: string; resourceId: string }): Promise<void>
}
