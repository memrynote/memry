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
  recurrence: string[] | null
}

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
