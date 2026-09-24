import { describe, expect, it } from 'vitest'
import type { UpsertRemoteEventInput } from '../types'
import { expandCalendarEvents, parseICalendar } from './ical-events'
import {
  eventToICalendar,
  excludeOccurrence,
  icalToRemoteEvent,
  patchICalendar
} from './ical-write'

const WINDOW = { startAt: '2026-01-01T00:00:00.000Z', endAt: '2027-01-01T00:00:00.000Z' }

function memryEvent(overrides: Partial<UpsertRemoteEventInput> = {}): UpsertRemoteEventInput {
  return {
    sourceType: 'event',
    sourceId: 'event-1',
    title: 'Design review',
    description: 'Walk through the calendar providers',
    location: 'Room 4',
    startAt: '2026-06-10T13:00:00.000Z',
    endAt: '2026-06-10T14:00:00.000Z',
    isAllDay: false,
    timezone: 'Europe/Berlin',
    recurrence: null,
    attendees: null,
    reminders: null,
    visibility: null,
    colorId: null,
    ...overrides
  }
}

function roundTrip(event: UpsertRemoteEventInput) {
  const ics = eventToICalendar(event, { uid: 'uid-1', now: new Date('2026-06-01T00:00:00.000Z') })
  return {
    ics,
    instances: expandCalendarEvents(parseICalendar(ics), WINDOW),
    remote: icalToRemoteEvent(ics, {
      href: 'https://dav.example.com/cal/uid-1.ics',
      calendarId: 'https://dav.example.com/cal/',
      etag: '"e1"',
      remoteEventId: 'https://dav.example.com/cal/uid-1.ics'
    })
  }
}

describe('Memry event → iCalendar → parse (#1400)', () => {
  it('round-trips a timed event with its zone, text, class, colour, attendees and alarms', () => {
    const event = memryEvent({
      visibility: 'private',
      colorId: '11',
      attendees: [
        {
          email: 'kaan@example.com',
          displayName: 'Kaan',
          organizer: true,
          responseStatus: 'accepted'
        },
        { email: 'sevde@example.com', responseStatus: 'tentative', optional: true }
      ],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] }
    })
    const { ics, instances, remote } = roundTrip(event)

    expect(ics).toContain('DTSTART;TZID=Europe/Berlin:20260610T150000')
    expect(ics).toContain('BEGIN:VTIMEZONE')
    expect(ics).toContain('X-MEMRY-SOURCE-ID:event-1')
    expect(instances).toEqual([
      expect.objectContaining({
        title: 'Design review',
        description: 'Walk through the calendar providers',
        location: 'Room 4',
        startAt: event.startAt,
        endAt: event.endAt,
        isAllDay: false,
        timezone: 'Europe/Berlin'
      })
    ])
    expect(remote).toMatchObject({
      title: event.title,
      startAt: event.startAt,
      endAt: event.endAt,
      timezone: 'Europe/Berlin',
      visibility: 'private',
      colorId: '11',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] }
    })
    expect(remote.attendees).toEqual([
      expect.objectContaining({
        email: 'kaan@example.com',
        organizer: true,
        responseStatus: 'accepted'
      }),
      expect.objectContaining({
        email: 'sevde@example.com',
        optional: true,
        responseStatus: 'tentative'
      })
    ])
  })

  it('round-trips an all-day event as a DATE, end exclusive', () => {
    const { ics, instances, remote } = roundTrip(
      memryEvent({
        isAllDay: true,
        startAt: '2026-07-01T00:00:00.000Z',
        endAt: '2026-07-03T00:00:00.000Z',
        timezone: 'UTC'
      })
    )
    expect(ics).toContain('DTSTART;VALUE=DATE:20260701')
    expect(ics).toContain('DTEND;VALUE=DATE:20260703')
    expect(instances[0]).toMatchObject({
      isAllDay: true,
      startAt: '2026-07-01T00:00:00.000Z',
      endAt: '2026-07-03T00:00:00.000Z'
    })
    expect(remote).toMatchObject({ isAllDay: true, startAt: '2026-07-01T00:00:00.000Z' })
  })

  it('keeps a weekly series at 9:00 local across a daylight-saving change', () => {
    // US DST starts 2026-03-08: 9:00 EST is 14:00Z, 9:00 EDT is 13:00Z.
    const { ics, instances } = roundTrip(
      memryEvent({
        startAt: '2026-03-02T14:00:00.000Z',
        endAt: '2026-03-02T15:00:00.000Z',
        timezone: 'America/New_York',
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3', 'EXDATE;TZID=America/New_York:20260309T090000']
      })
    )
    expect(ics).toContain('RRULE:FREQ=WEEKLY;COUNT=3')
    expect(instances.map((instance) => instance.startAt)).toEqual([
      '2026-03-02T14:00:00.000Z',
      '2026-03-16T13:00:00.000Z'
    ])
  })
})

const FOREIGN = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Apple Inc.//macOS 15//EN',
  'BEGIN:VEVENT',
  'UID:apple-1',
  'DTSTAMP:20260101T000000Z',
  'DTSTART:20260610T090000Z',
  'DTEND:20260610T100000Z',
  'RRULE:FREQ=DAILY;COUNT=5',
  'SUMMARY:Standup',
  'SEQUENCE:4',
  'CATEGORIES:Work,Team',
  'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'X-CUSTOM-FIELD;X-PARAM=keep:opaque value',
  'BEGIN:VALARM',
  'ACTION:AUDIO',
  'TRIGGER:-PT5M',
  'X-WR-ALARMUID:alarm-1',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

describe('updates patch the stored object (#1400)', () => {
  it('keeps unknown properties, X- extensions and components another client wrote', () => {
    const patched = patchICalendar(
      FOREIGN,
      memryEvent({
        title: 'Standup (moved)',
        description: null,
        location: null,
        startAt: '2026-06-10T09:30:00.000Z',
        endAt: '2026-06-10T10:00:00.000Z',
        timezone: 'UTC'
      })
    )
    expect(patched).toContain('SUMMARY:Standup (moved)')
    expect(patched).toContain('DTSTART:20260610T093000Z')
    expect(patched).toContain('CATEGORIES:Work,Team')
    expect(patched).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC')
    expect(patched).toContain('X-CUSTOM-FIELD;X-PARAM=keep:opaque value')
    expect(patched).toContain('X-WR-ALARMUID:alarm-1')
    expect(patched).toContain('PRODID:-//Apple Inc.//macOS 15//EN')
    // Not Memry's series: its recurrence is left alone.
    expect(patched).toContain('RRULE:FREQ=DAILY;COUNT=5')
    // A meaningful change bumps SEQUENCE.
    expect(patched).toContain('SEQUENCE:5')
  })

  it('edits one occurrence as an override and leaves the series intact', () => {
    const recurrenceId = '2026-06-12T09:00:00.000Z'
    const patched = patchICalendar(
      FOREIGN,
      memryEvent({
        title: 'Standup (Friday)',
        startAt: '2026-06-12T11:00:00.000Z',
        endAt: '2026-06-12T11:30:00.000Z',
        timezone: 'UTC'
      }),
      { recurrenceId }
    )
    const instances = expandCalendarEvents(parseICalendar(patched), WINDOW, {
      keyFor: (_uid, rid) => rid ?? 'master'
    })
    expect(instances).toHaveLength(5)
    expect(instances.find((instance) => instance.remoteEventId === recurrenceId)).toMatchObject({
      title: 'Standup (Friday)',
      startAt: '2026-06-12T11:00:00.000Z'
    })
    expect(instances.filter((instance) => instance.title === 'Standup')).toHaveLength(4)
  })

  it('deleting one occurrence adds an EXDATE instead of deleting the series', () => {
    const excluded = excludeOccurrence(FOREIGN, '2026-06-11T09:00:00.000Z')
    const instances = expandCalendarEvents(parseICalendar(excluded), WINDOW)
    expect(instances.map((instance) => instance.startAt)).not.toContain('2026-06-11T09:00:00.000Z')
    expect(instances).toHaveLength(4)
    expect(excluded).toContain('X-CUSTOM-FIELD;X-PARAM=keep:opaque value')
  })

  it('writes EXDATE and RECURRENCE-ID with the series value type (RFC 5545 §3.8.4.4)', () => {
    const allDay = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:x',
      'BEGIN:VEVENT',
      'UID:all-day',
      'DTSTAMP:20260101T000000Z',
      'DTSTART;VALUE=DATE:20260701',
      'DTEND;VALUE=DATE:20260702',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Holiday',
      'END:VEVENT',
      'END:VCALENDAR',
      ''
    ].join('\r\n')
    const excluded = excludeOccurrence(allDay, '2026-07-02T00:00:00.000Z')
    expect(excluded).toContain('EXDATE;VALUE=DATE:20260702')
    expect(
      expandCalendarEvents(parseICalendar(excluded), WINDOW).map((instance) => instance.startAt)
    ).toEqual(['2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z'])
    const overridden = patchICalendar(
      allDay,
      memryEvent({
        title: 'Holiday (moved)',
        isAllDay: true,
        startAt: '2026-07-02T00:00:00.000Z',
        endAt: '2026-07-03T00:00:00.000Z',
        timezone: 'UTC'
      }),
      { recurrenceId: '2026-07-02T00:00:00.000Z' }
    )
    expect(overridden).toContain('RECURRENCE-ID;VALUE=DATE:20260702')

    const zoned = eventToICalendar(
      memryEvent({
        startAt: '2026-06-01T07:00:00.000Z',
        endAt: '2026-06-01T08:00:00.000Z',
        timezone: 'Europe/Berlin',
        recurrence: ['RRULE:FREQ=DAILY;COUNT=3']
      }),
      { uid: 'zoned' }
    )
    const zonedExcluded = excludeOccurrence(zoned, '2026-06-02T07:00:00.000Z')
    expect(zonedExcluded).toContain('EXDATE;TZID=Europe/Berlin:20260602T090000')
    expect(
      expandCalendarEvents(parseICalendar(zonedExcluded), WINDOW).map(
        (instance) => instance.startAt
      )
    ).toEqual(['2026-06-01T07:00:00.000Z', '2026-06-03T07:00:00.000Z'])
  })

  it('reads a promoted occurrence the series no longer produces as cancelled', () => {
    const excluded = excludeOccurrence(FOREIGN, '2026-06-11T09:00:00.000Z')
    const read = (raw: string, recurrenceId: string) =>
      icalToRemoteEvent(raw, {
        href: 'https://dav.example.com/cal/apple-1.ics',
        calendarId: 'https://dav.example.com/cal/',
        etag: '"e2"',
        remoteEventId: `https://dav.example.com/cal/apple-1.ics::${recurrenceId}`,
        recurrenceId
      }).status
    expect(read(excluded, '2026-06-11T09:00:00.000Z')).toBe('cancelled')
    expect(read(excluded, '2026-06-12T09:00:00.000Z')).toBe('confirmed')
    // Past the end of the COUNT.
    expect(read(FOREIGN, '2026-06-20T09:00:00.000Z')).toBe('cancelled')
  })

  it('owns the recurrence of objects it created, so removing a repeat removes the RRULE', () => {
    const created = eventToICalendar(memryEvent({ recurrence: ['RRULE:FREQ=WEEKLY'] }), {
      uid: 'memry-1'
    })
    const patched = patchICalendar(created, memryEvent({ recurrence: null }))
    expect(patched).not.toContain('RRULE')
  })
})
