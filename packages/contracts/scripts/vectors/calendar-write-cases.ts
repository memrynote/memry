/**
 * Inputs for `calendar-write.json` (spec 007 CL070): what the phone writes to
 * CalDAV and Google, checked against desktop's own writers.
 */

const NOW = '2026-09-26T08:00:00.000Z'

const base = {
  sourceType: 'event',
  sourceId: 'evt-1',
  description: null,
  location: null,
  recurrence: null
}

/** `UpsertRemoteEventInput`s for `eventToICalendar`. */
export const NEW_OBJECTS = [
  {
    name: 'timed in a zone, weekly with an alert and a colour',
    uid: 'memry-a',
    event: {
      ...base,
      title: '[agent] Planning; review, sync',
      description: 'Line one\nLine two',
      location: 'Kadıköy',
      startAt: '2026-10-05T07:00:00.000Z',
      endAt: '2026-10-05T08:30:00.000Z',
      isAllDay: false,
      timezone: 'Europe/Istanbul',
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4'],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
      colorId: '11'
    }
  },
  {
    name: 'timed in UTC',
    uid: 'memry-b',
    event: {
      ...base,
      title: 'UTC call',
      startAt: '2026-10-06T15:00:00.000Z',
      endAt: '2026-10-06T15:30:00.000Z',
      isAllDay: false,
      timezone: 'UTC'
    }
  },
  {
    name: 'timed in New York across the DST change',
    uid: 'memry-c',
    event: {
      ...base,
      title: 'NY standup',
      startAt: '2026-11-02T14:00:00.000Z',
      endAt: '2026-11-02T14:15:00.000Z',
      isAllDay: false,
      timezone: 'America/New_York',
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3']
    }
  }
]

const SERIES = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//agent//test//EN',
  'BEGIN:VEVENT',
  'UID:series-1',
  'DTSTAMP:20260901T000000Z',
  'DTSTART:20260928T070000Z',
  'DTEND:20260928T073000Z',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:Weekly',
  'LOCATION:Server room',
  'X-SERVER-THING:keep',
  'SEQUENCE:2',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

const ZONED_SERIES = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//agent//test//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Istanbul',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0300',
  'TZOFFSETTO:+0300',
  'END:STANDARD',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:zoned-1',
  'DTSTAMP:20260901T000000Z',
  'DTSTART;TZID=Europe/Istanbul:20260928T100000',
  'DTEND;TZID=Europe/Istanbul:20260928T103000',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'SUMMARY:Zoned weekly',
  'END:VEVENT',
  'END:VCALENDAR',
  ''
].join('\r\n')

/** `patchICalendar` over a stored object, whole or one occurrence. */
export const PATCHES = [
  {
    name: 'whole series renamed and moved',
    raw: SERIES,
    recurrenceId: null,
    event: {
      ...base,
      title: 'Weekly (moved)',
      startAt: '2026-09-28T08:00:00.000Z',
      endAt: '2026-09-28T08:30:00.000Z',
      isAllDay: false,
      timezone: 'UTC'
    }
  },
  {
    name: 'one occurrence of a UTC series gets an override',
    raw: SERIES,
    recurrenceId: '2026-10-05T07:00:00.000Z',
    event: {
      ...base,
      title: 'Weekly (just this one)',
      startAt: '2026-10-05T09:00:00.000Z',
      endAt: '2026-10-05T09:30:00.000Z',
      isAllDay: false,
      timezone: 'UTC'
    }
  },
  {
    name: 'one occurrence of a zoned series keeps the series zone',
    raw: ZONED_SERIES,
    recurrenceId: '2026-10-05T07:00:00.000Z',
    event: {
      ...base,
      title: 'Zoned (moved)',
      startAt: '2026-10-05T08:00:00.000Z',
      endAt: '2026-10-05T08:30:00.000Z',
      isAllDay: false,
      timezone: 'Europe/Istanbul'
    }
  }
]

/** `excludeOccurrence`. */
export const EXCLUSIONS = [
  { name: 'UTC series', raw: SERIES, recurrenceId: '2026-10-12T07:00:00.000Z' },
  { name: 'zoned series', raw: ZONED_SERIES, recurrenceId: '2026-10-05T07:00:00.000Z' }
]

/** `mapCalendarEventToGoogleInput`'s recurrence (`toGoogleRecurrenceWithExceptions`). */
export const RECURRENCES = [
  {
    name: 'rule only',
    rule: { rrule: 'FREQ=WEEKLY;BYDAY=TU' },
    exceptions: null,
    timezone: 'Europe/Istanbul'
  },
  {
    name: 'rule and exceptions in a zone',
    rule: { rrule: 'FREQ=DAILY' },
    exceptions: ['2026-10-06T07:00:00.000Z', '2026-10-08T07:00:00.000Z'],
    timezone: 'Europe/Istanbul'
  },
  {
    name: 'exceptions in UTC',
    rule: { rrule: 'FREQ=DAILY' },
    exceptions: ['2026-10-06T07:00:00.000Z'],
    timezone: 'UTC'
  },
  {
    name: 'exceptions across New York DST',
    rule: { rrule: 'FREQ=DAILY' },
    exceptions: ['2026-10-31T13:00:00.000Z', '2026-11-02T14:00:00.000Z'],
    timezone: 'America/New_York'
  },
  { name: 'nothing', rule: null, exceptions: null, timezone: 'UTC' }
]

/** `isAppVersionBelow(version, CALENDAR_MULTI_WRITER_MIN_APP_VERSION)`. */
export const VERSIONS = [
  '2026.925.0',
  '2026.925.1',
  '2026.924.9',
  '2026.1001.0',
  '2025.1231.3',
  '2027',
  '2026.925',
  '0.1.0',
  '2026.925.0-beta',
  'garbage',
  '',
  '2026..0',
  '2026.925.0.7',
  '2026.925.0.x'
]

export const WRITE_NOW = NOW
export const WRITE_ZONES = ['Europe/Istanbul', 'America/New_York']
