import { describe, expect, it } from 'vitest'
import {
  mapGoogleEventToCalendarEventChanges,
  mapGoogleEventToExternalEventRecord
} from './mappers'
import type { GoogleCalendarRemoteEvent } from '../types'

const BASE_EVENT: GoogleCalendarRemoteEvent = {
  id: 'google-evt-1',
  calendarId: 'primary',
  title: 'Team sync',
  description: 'Weekly check-in',
  location: 'Zoom',
  startAt: '2026-05-03T15:00:00.000Z',
  endAt: '2026-05-03T15:30:00.000Z',
  isAllDay: false,
  timezone: 'UTC',
  status: 'confirmed',
  etag: 'etag-1',
  updatedAt: '2026-05-03T14:00:00.000Z',
  attendees: null,
  reminders: null,
  visibility: null,
  colorId: null,
  conferenceData: null,
  recurringEventId: null,
  originalStartTime: null,
  raw: {}
}

const RICH_EVENT: GoogleCalendarRemoteEvent = {
  ...BASE_EVENT,
  attendees: [
    { email: 'alice@example.com', responseStatus: 'accepted', displayName: 'Alice' },
    { email: 'bob@example.com', responseStatus: 'needsAction', optional: true }
  ],
  reminders: {
    useDefault: false,
    overrides: [
      { method: 'popup', minutes: 10 },
      { method: 'email', minutes: 60 }
    ]
  },
  visibility: 'private',
  colorId: '9',
  conferenceData: {
    conferenceId: 'abc-defg-hij',
    entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }]
  }
}

describe('mapGoogleEventToExternalEventRecord', () => {
  it('includes every rich field when Google returns it', () => {
    // #when
    const record = mapGoogleEventToExternalEventRecord(
      'source-1',
      RICH_EVENT,
      '2026-05-03T14:05:00.000Z'
    )

    // #then the persisted external-event row carries the full Google payload
    expect(record.attendees).toEqual(RICH_EVENT.attendees)
    expect(record.reminders).toEqual(RICH_EVENT.reminders)
    expect(record.visibility).toBe('private')
    expect(record.colorId).toBe('9')
    expect(record.conferenceData).toEqual(RICH_EVENT.conferenceData)
  })

  it('null-coalesces rich fields that Google omits', () => {
    // #when a plain event with no attendees/reminders/etc. is mapped
    const record = mapGoogleEventToExternalEventRecord(
      'source-1',
      BASE_EVENT,
      '2026-05-03T14:05:00.000Z'
    )

    // #then each rich field is explicitly null on the row (not undefined)
    expect(record.attendees).toBeNull()
    expect(record.reminders).toBeNull()
    expect(record.visibility).toBeNull()
    expect(record.colorId).toBeNull()
    expect(record.conferenceData).toBeNull()
  })
})

describe('mapGoogleEventToCalendarEventChanges', () => {
  it('exposes every rich field for field-level merge', () => {
    // #when
    const changes = mapGoogleEventToCalendarEventChanges(RICH_EVENT)

    // #then the change set mirrors Google's rich payload
    expect(changes.attendees).toEqual(RICH_EVENT.attendees)
    expect(changes.reminders).toEqual(RICH_EVENT.reminders)
    expect(changes.visibility).toBe('private')
    expect(changes.colorId).toBe('9')
    expect(changes.conferenceData).toEqual(RICH_EVENT.conferenceData)
  })

  it('null-coalesces rich fields omitted by Google', () => {
    const changes = mapGoogleEventToCalendarEventChanges(BASE_EVENT)

    expect(changes.attendees).toBeNull()
    expect(changes.reminders).toBeNull()
    expect(changes.visibility).toBeNull()
    expect(changes.colorId).toBeNull()
    expect(changes.conferenceData).toBeNull()
    expect(changes.parentEventId).toBeNull()
    expect(changes.originalStartTime).toBeNull()
  })

  it('promotes recurringEventId + originalStartTime to parentEventId + originalStartTime', () => {
    // #given a single-instance exception returned by Google
    const exception: GoogleCalendarRemoteEvent = {
      ...BASE_EVENT,
      id: 'google-evt-1_20260510T090000Z',
      recurringEventId: 'google-evt-1',
      originalStartTime: '2026-05-10T09:00:00.000Z'
    }

    // #when
    const changes = mapGoogleEventToCalendarEventChanges(exception)

    // #then the Memry row can be resolved as "exception of <series>"
    expect(changes.parentEventId).toBe('google-evt-1')
    expect(changes.originalStartTime).toBe('2026-05-10T09:00:00.000Z')
  })
})
