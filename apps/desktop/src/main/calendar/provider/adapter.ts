import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'
import type { CalendarSyncSourceType } from '../types'

/**
 * The capability model lives in contracts because the renderer needs it too —
 * a provider that cannot write must not be offered a "push events" toggle.
 * Re-exported here under the main-process names so adapter code reads locally.
 *
 * `incrementalMode` is how a provider tells us "what changed since last time":
 * `sync-token` (Google), `delta-link` (Microsoft Graph), `sync-collection`
 * (CalDAV RFC 6578), `ctag-etag` (CalDAV without it), `conditional-get`
 * (plain HTTP ETag on a whole ICS feed), `full` (no incremental support).
 */
export type {
  CalendarProviderAuthFlow as ProviderAuthFlow,
  CalendarProviderCapabilities as ProviderCapabilities,
  CalendarProviderIncrementalMode as ProviderIncrementalMode
} from '@memry/contracts/calendar-api'

export interface RemoteCalendarDescriptor {
  id: string
  title: string
  timezone: string | null
  color: string | null
  isPrimary: boolean
}

/**
 * One event as the provider reports it. Field names are carried over verbatim
 * from the Google-era shape so the mappers and the `calendar_external_events`
 * mirror keep working untouched; `raw` stays the provider's own payload.
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

export interface ListRemoteEventsInput {
  calendarId: string
  /** Whatever the provider's `incrementalMode` calls a cursor, opaque to us. */
  syncCursor?: string | null
  timeMin?: string | null
  timeMax?: string | null
}

export interface ListRemoteEventsResult {
  events: RemoteCalendarEvent[]
  nextSyncCursor: string | null
}

export interface WatchCalendarInput {
  calendarId: string
  channelId: string
  token: string
  webhookUrl: string
  ttlSeconds: number
}

export interface WatchCalendarResult {
  resourceId: string
  expiration: number
}

/**
 * The one surface the calendar sync engine is allowed to talk to.
 *
 * Optional members map one-to-one onto `ProviderCapabilities`: a provider with
 * `supportsWrite: false` omits `upsertEvent`/`deleteEvent`, `supportsPush:
 * false` omits `watch`/`unwatch`, `supportsCreateCalendar: false` omits
 * `createCalendar`.
 */
export interface CalendarProviderAdapter {
  listCalendars(): Promise<RemoteCalendarDescriptor[]>
  createCalendar?(input: { title: string; timezone: string }): Promise<RemoteCalendarDescriptor>
  listEvents(input: ListRemoteEventsInput): Promise<ListRemoteEventsResult>
  getEvent(input: { calendarId: string; eventId: string }): Promise<RemoteCalendarEvent>
  upsertEvent?(input: {
    calendarId: string
    eventId: string | null
    event: UpsertRemoteEventInput
    ifMatch?: string | null
  }): Promise<RemoteCalendarEvent>
  deleteEvent?(input: { calendarId: string; eventId: string }): Promise<void>
  watch?(input: WatchCalendarInput): Promise<WatchCalendarResult>
  unwatch?(input: { channelId: string; resourceId: string }): Promise<void>
}
