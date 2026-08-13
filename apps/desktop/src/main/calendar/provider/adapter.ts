import type {
  CalendarAttendee,
  CalendarConferenceData,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'
import type { CalendarSyncSourceType } from '../types'

/**
 * How a provider tells us "what changed since last time".
 *
 * - `sync-token` — Google: opaque token returned with each page
 * - `delta-link` — Microsoft Graph: `@odata.deltaLink`
 * - `sync-collection` — CalDAV RFC 6578
 * - `ctag-etag` — CalDAV without RFC 6578: collection ctag, then per-item etags
 * - `conditional-get` — plain HTTP `ETag` / `Last-Modified` on a whole feed (ICS)
 * - `full` — no incremental support; every pass re-reads everything
 */
export type ProviderIncrementalMode =
  'sync-token' | 'delta-link' | 'sync-collection' | 'ctag-etag' | 'conditional-get' | 'full'

/** Which connect flow the UI shell has to render for this provider. */
export type ProviderAuthFlow = 'oauth2' | 'basic' | 'url' | 'none'

export interface ProviderCapabilities {
  /** False for read-only providers (ICS). The engine — not the adapter — refuses writes. */
  supportsWrite: boolean
  /** Can we provision our own "memrynote" calendar on the remote? */
  supportsCreateCalendar: boolean
  /** Real-time change notifications. False means the runner polls. */
  supportsPush: boolean
  /** More than one connected account per provider. */
  supportsMultiAccount: boolean
  incrementalMode: ProviderIncrementalMode
  authFlow: ProviderAuthFlow
}

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
