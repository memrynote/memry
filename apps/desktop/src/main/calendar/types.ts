import type {
  CalendarProviderAdapter,
  RemoteCalendarDescriptor,
  RemoteCalendarEvent,
  UpsertRemoteEventInput,
  WatchCalendarInput,
  WatchCalendarResult
} from './provider/adapter'

export type CalendarSyncSourceType = 'event' | 'task' | 'reminder' | 'inbox_snooze'

export interface CalendarSyncTarget {
  sourceType: CalendarSyncSourceType
  sourceId: string
}

// The remote-event shapes are provider-neutral now (`provider/adapter.ts`).
// These aliases keep the Google-era names alive for the existing Google call
// sites; new code should import the neutral names directly.
export type GoogleCalendarDescriptor = RemoteCalendarDescriptor
export type GoogleCalendarRemoteEvent = RemoteCalendarEvent
export type GoogleCalendarUpsertEventInput = UpsertRemoteEventInput

/**
 * Google's adapter. Everything optional on `CalendarProviderAdapter` is
 * required here — Google writes, creates calendars and pushes — plus the two
 * Google-named push-channel methods the channel manager still calls. Those
 * stay until the sync-server relay is generalized (#1404); `watch`/`unwatch`
 * are the neutral names the engine sees.
 */
export interface GoogleCalendarClient extends CalendarProviderAdapter {
  createCalendar(input: { title: string; timezone: string }): Promise<RemoteCalendarDescriptor>
  upsertEvent(input: {
    calendarId: string
    eventId: string | null
    event: UpsertRemoteEventInput
    ifMatch?: string | null
  }): Promise<RemoteCalendarEvent>
  deleteEvent(input: { calendarId: string; eventId: string }): Promise<void>
  watch(input: WatchCalendarInput): Promise<WatchCalendarResult>
  unwatch(input: { channelId: string; resourceId: string }): Promise<void>
  watchCalendar(input: WatchCalendarInput): Promise<WatchCalendarResult>
  stopChannel(input: { channelId: string; resourceId: string }): Promise<void>
}
