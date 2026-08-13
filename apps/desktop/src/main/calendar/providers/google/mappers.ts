/**
 * The event mappers are provider-neutral — they translate the shared
 * `RemoteCalendarEvent` shape to and from local rows, and every adapter
 * produces that shape. They live in `calendar/sync/remote-event-mappers.ts`
 * now; this re-export keeps the Google-era import path working.
 */
export * from '../../sync/remote-event-mappers'
