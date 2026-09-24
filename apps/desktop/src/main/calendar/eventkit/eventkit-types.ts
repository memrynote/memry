/**
 * The macOS Calendar bridge (#1405) as the rest of main sees it. Types only:
 * importing this file never loads the bridge. The implementation lives in
 * `eventkit-bridge.ts` and is reached only through `loadEventKitBridge()`.
 */

/** `EKAuthorizationStatus` for events. `write_only` (macOS 14+) cannot read. */
export type EventKitAuthorizationStatus =
  'not_determined' | 'restricted' | 'denied' | 'write_only' | 'full_access'

export interface EventKitCalendar {
  /** `EKCalendar.calendarIdentifier`. */
  id: string
  title: string
  /** `#rrggbb` in sRGB, or null when EventKit has no colour. */
  color: string | null
  /** `local`, `caldav`, `exchange`, `subscription`, `birthday`. */
  type: string
  allowsModifications: boolean
  /** `EKSource.sourceIdentifier`: the account the calendar belongs to. */
  sourceId: string | null
  /** `EKSource.title`: usually the account's email, or "On My Mac", "iCloud". */
  sourceTitle: string | null
  /** `local`, `exchange`, `caldav`, `mobileme`, `subscribed`, `birthdays`. */
  sourceType: string | null
}

export type EventKitEventStatus = 'none' | 'confirmed' | 'tentative' | 'canceled'

export interface EventKitParticipant {
  name: string | null
  /** From a `mailto:` URL; null for participants without one. */
  email: string | null
  /** `accepted`, `declined`, `tentative`, `pending`, `delegated`, `completed`. */
  status: string
  /** `required`, `optional`, `chair`, `non_participant`, `unknown`. */
  role: string
  /** `person`, `room`, `resource`, `group`, `unknown`. */
  type: string
  isCurrentUser: boolean
}

export interface EventKitEvent {
  calendarId: string
  /** `EKEvent.eventIdentifier`: local to this Mac and can change on re-sync. */
  eventId: string | null
  /** `calendarItemExternalIdentifier`: the server's id, stabler across re-syncs. */
  externalId: string | null
  title: string
  location: string | null
  notes: string | null
  url: string | null
  isAllDay: boolean
  /** Timed events: ISO instants. */
  start: string | null
  end: string | null
  /** Timed events: the IANA zone, or null for a floating time. */
  timeZone: string | null
  /** All-day events: the first and last calendar dates, `YYYY-MM-DD`, inclusive. */
  startDate: string | null
  lastDate: string | null
  status: EventKitEventStatus
  availability: string
  isRecurring: boolean
  lastModified: string | null
  /** The occurrence's original start (ISO), set for occurrences of a series. */
  occurrenceStart: string | null
  attendees: EventKitParticipant[]
  organizer: EventKitParticipant | null
  /** Alerts, in minutes before the start (negative = after). */
  alarmMinutes: number[]
  /** The series rule as an RRULE value without the `RRULE:` prefix. */
  recurrenceRule: string | null
}

export interface ListEventKitEventsInput {
  calendarIds: string[]
  start: string
  end: string
}

export interface EventKitBridge {
  authorizationStatus(): Promise<EventKitAuthorizationStatus>
  /** Shows the macOS dialog only when the status is `not_determined`. */
  requestFullAccess(): Promise<EventKitAuthorizationStatus>
  listCalendars(): Promise<EventKitCalendar[]>
  listEvents(input: ListEventKitEventsInput): Promise<EventKitEvent[]>
  /** `EKEventStoreChanged`. Returns the unsubscribe. */
  onChanged(listener: () => void): () => void
  dispose(): void
}

export class EventKitBridgeError extends Error {
  constructor(
    readonly code: string,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'EventKitBridgeError'
  }
}
