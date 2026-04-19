import { describe, expect, it } from 'vitest'
import {
  mapCalendarEventToGoogleInput,
  mapGoogleEventToCalendarEventChanges,
  mapGoogleEventToExternalEventRecord
} from './mappers'
import type { GoogleCalendarRemoteEvent } from '../types'
import type { CalendarEvent } from '@memry/db-schema/schema/calendar-events'

const LOCAL_EVENT_BASE: CalendarEvent = {
  id: 'local-evt-1',
  title: 'Local meeting',
  description: null,
  location: null,
  startAt: '2026-05-03T15:00:00.000Z',
  endAt: '2026-05-03T15:30:00.000Z',
  timezone: 'UTC',
  isAllDay: false,
  recurrenceRule: null,
  recurrenceExceptions: null,
  attendees: null,
  reminders: null,
  visibility: null,
  colorId: null,
  conferenceData: null,
  parentEventId: null,
  originalStartTime: null,
  targetCalendarId: null,
  archivedAt: null,
  clock: { 'device-a': 1 },
  fieldClocks: null,
  syncedAt: null,
  createdAt: '2026-05-03T14:00:00.000Z',
  modifiedAt: '2026-05-03T14:00:00.000Z'
}

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

  it('promotes recurringEventId + originalStartTime to parentEventId + originalStartTime for recurring single-instance edits', () => {
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

describe('mapCalendarEventToGoogleInput', () => {
  it('forwards attendees, reminders, visibility, colorId, conferenceData to the Google payload', () => {
    // #given a rich local event
    const rich: CalendarEvent = {
      ...LOCAL_EVENT_BASE,
      attendees: [{ email: 'alice@example.com', responseStatus: 'accepted' }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
      visibility: 'private',
      colorId: '9',
      conferenceData: {
        conferenceId: 'abc',
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc' }]
      }
    }

    // #when
    const input = mapCalendarEventToGoogleInput(rich)

    // #then every rich field flows to Google
    expect(input.attendees).toEqual(rich.attendees)
    expect(input.reminders).toEqual(rich.reminders)
    expect(input.visibility).toBe('private')
    expect(input.colorId).toBe('9')
    expect(input.conferenceData).toEqual(rich.conferenceData)
  })

  it('null-coalesces rich fields when the local event has none', () => {
    // #when a plain event is mapped
    const input = mapCalendarEventToGoogleInput(LOCAL_EVENT_BASE)

    // #then explicit nulls (not undefined) so Google's PATCH clears fields it used to have
    expect(input.attendees).toBeNull()
    expect(input.reminders).toBeNull()
    expect(input.visibility).toBeNull()
    expect(input.colorId).toBeNull()
    expect(input.conferenceData).toBeNull()
  })

  it('appends EXDATE:…Z lines to the recurrence array when timezone is UTC', () => {
    // #given a recurring event with two UTC exceptions
    const recurring: CalendarEvent = {
      ...LOCAL_EVENT_BASE,
      timezone: 'UTC',
      recurrenceRule: { rrule: 'FREQ=WEEKLY;INTERVAL=1' },
      recurrenceExceptions: ['2026-05-10T09:00:00.000Z', '2026-05-17T09:00:00.000Z']
    }

    // #when
    const input = mapCalendarEventToGoogleInput(recurring)

    // #then RRULE preserved + one EXDATE line per exception in canonical UTC form
    expect(input.recurrence).toEqual([
      'RRULE:FREQ=WEEKLY;INTERVAL=1',
      'EXDATE:20260510T090000Z',
      'EXDATE:20260517T090000Z'
    ])
  })

  it('appends EXDATE;TZID=… with the wall-time of the skipped occurrence in that zone', () => {
    // #given a recurring event pinned to America/New_York (EDT = UTC-4 in May)
    // and a UTC exception marking the 09:00 ET instance on 2026-05-10
    const recurring: CalendarEvent = {
      ...LOCAL_EVENT_BASE,
      timezone: 'America/New_York',
      recurrenceRule: { rrule: 'FREQ=WEEKLY;INTERVAL=1' },
      recurrenceExceptions: ['2026-05-10T13:00:00.000Z']
    }

    // #when
    const input = mapCalendarEventToGoogleInput(recurring)

    // #then the EXDATE timestamp reflects the zone's wall time (09:00), not UTC's 13:00.
    // Emitting 13:00 with TZID=America/New_York would tell Google to skip the wrong
    // occurrence (a 13:00 local instance that isn't on the series).
    expect(input.recurrence).toEqual([
      'RRULE:FREQ=WEEKLY;INTERVAL=1',
      'EXDATE;TZID=America/New_York:20260510T090000'
    ])
  })

  it('handles EXDATE across a standard → daylight-saving boundary in the target zone', () => {
    // #given a recurring event in America/New_York with exceptions
    // straddling the 2026-03-08 DST spring-forward.
    // 2026-03-06T14:00:00Z → 09:00 EST (UTC-5, before DST)
    // 2026-03-13T13:00:00Z → 09:00 EDT (UTC-4, after DST)
    const recurring: CalendarEvent = {
      ...LOCAL_EVENT_BASE,
      timezone: 'America/New_York',
      recurrenceRule: { rrule: 'FREQ=WEEKLY' },
      recurrenceExceptions: ['2026-03-06T14:00:00.000Z', '2026-03-13T13:00:00.000Z']
    }

    const input = mapCalendarEventToGoogleInput(recurring)

    expect(input.recurrence).toEqual([
      'RRULE:FREQ=WEEKLY',
      'EXDATE;TZID=America/New_York:20260306T090000',
      'EXDATE;TZID=America/New_York:20260313T090000'
    ])
  })

  it('emits only EXDATE lines when exceptions exist without an rrule', () => {
    // #given a one-off edit that collected exceptions via another path (edge case)
    const noRrule: CalendarEvent = {
      ...LOCAL_EVENT_BASE,
      timezone: 'UTC',
      recurrenceRule: null,
      recurrenceExceptions: ['2026-05-10T09:00:00.000Z']
    }

    const input = mapCalendarEventToGoogleInput(noRrule)

    expect(input.recurrence).toEqual(['EXDATE:20260510T090000Z'])
  })

  it('returns null recurrence when neither rrule nor exceptions are present', () => {
    const input = mapCalendarEventToGoogleInput(LOCAL_EVENT_BASE)

    expect(input.recurrence).toBeNull()
  })
})
