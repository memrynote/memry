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

export interface GoogleCalendarRemoteEvent {
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
  raw: Record<string, unknown>
}

export interface GoogleCalendarUpsertEventInput {
  sourceType: CalendarSyncSourceType
  sourceId: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  isAllDay: boolean
  timezone: string
}

export interface GoogleCalendarClient {
  listCalendars(): Promise<GoogleCalendarDescriptor[]>
  createCalendar(input: { title: string; timezone: string }): Promise<GoogleCalendarDescriptor>
  listEvents(input: {
    calendarId: string
    syncCursor?: string | null
  }): Promise<{ events: GoogleCalendarRemoteEvent[]; nextSyncCursor: string | null }>
  upsertEvent(input: {
    calendarId: string
    eventId: string | null
    event: GoogleCalendarUpsertEventInput
  }): Promise<GoogleCalendarRemoteEvent>
  deleteEvent(input: { calendarId: string; eventId: string }): Promise<void>
}
