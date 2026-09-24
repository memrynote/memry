import { describe, expect, it } from 'vitest'
import { IcsFeedError, icsSourceIdForUrl, normalizeIcsUrl, parseIcsFeed } from './ics-feed'

const WINDOW = { startAt: '2026-01-01T00:00:00.000Z', endAt: '2027-01-01T00:00:00.000Z' }

const BERLIN_VTIMEZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
]

function calendar(lines: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', ...lines, 'END:VCALENDAR'].join(
    '\r\n'
  )
}

function errorCode(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (error) {
    return error instanceof IcsFeedError ? error.code : 'not-an-IcsFeedError'
  }
}

describe('normalizeIcsUrl', () => {
  it('turns webcal and webcals links into https and drops the fragment', () => {
    expect(
      normalizeIcsUrl(
        ' webcal://calendar.proton.me/api/calendar/v1/url/abc/calendar.ics?CacheKey=x '
      )
    ).toBe('https://calendar.proton.me/api/calendar/v1/url/abc/calendar.ics?CacheKey=x')
    expect(normalizeIcsUrl('WEBCALS://p01-caldav.icloud.com/published/2/abc#top')).toBe(
      'https://p01-caldav.icloud.com/published/2/abc'
    )
    expect(normalizeIcsUrl('http://nextcloud.local/remote.php/dav/public-calendars/x?export')).toBe(
      'http://nextcloud.local/remote.php/dav/public-calendars/x?export'
    )
  })

  it('rejects anything that is not an http(s) address', () => {
    expect(normalizeIcsUrl('ftp://example.com/feed.ics')).toBeNull()
    expect(normalizeIcsUrl('file:///Users/me/feed.ics')).toBeNull()
    expect(normalizeIcsUrl('my calendar')).toBeNull()
  })

  it('gives webcal and https spellings of one feed the same source id', () => {
    const fromWebcal = icsSourceIdForUrl(normalizeIcsUrl('webcal://example.com/feed.ics') ?? '')
    const fromHttps = icsSourceIdForUrl(normalizeIcsUrl('https://example.com/feed.ics') ?? '')
    expect(fromWebcal).toBe(fromHttps)
    expect(fromWebcal).toMatch(/^ics-calendar:[0-9a-f]{32}$/)
  })
})

describe('parseIcsFeed', () => {
  it('expands a weekly series across a DST change, honouring EXDATE, a moved and a cancelled instance', () => {
    const feed = parseIcsFeed(
      calendar([
        'X-WR-CALNAME:Team',
        'X-WR-TIMEZONE:Europe/Berlin',
        'REFRESH-INTERVAL;VALUE=DURATION:PT2H',
        ...BERLIN_VTIMEZONE,
        'BEGIN:VEVENT',
        'UID:standup@test',
        'DTSTAMP:20260301T000000Z',
        'DTSTART;TZID=Europe/Berlin:20260320T090000',
        'DTEND;TZID=Europe/Berlin:20260320T093000',
        'RRULE:FREQ=WEEKLY;COUNT=5',
        'EXDATE;TZID=Europe/Berlin:20260403T090000',
        'SUMMARY:Standup',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:standup@test',
        'DTSTAMP:20260301T000000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260410T090000',
        'DTSTART;TZID=Europe/Berlin:20260410T110000',
        'DTEND;TZID=Europe/Berlin:20260410T113000',
        'SUMMARY:Standup (moved)',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:standup@test',
        'DTSTAMP:20260301T000000Z',
        'RECURRENCE-ID;TZID=Europe/Berlin:20260417T090000',
        'DTSTART;TZID=Europe/Berlin:20260417T090000',
        'DTEND;TZID=Europe/Berlin:20260417T093000',
        'STATUS:CANCELLED',
        'SUMMARY:Standup',
        'END:VEVENT'
      ]),
      WINDOW
    )

    expect(feed.name).toBe('Team')
    expect(feed.timezone).toBe('Europe/Berlin')
    expect(feed.refreshIntervalMs).toBe(2 * 60 * 60 * 1000)
    expect(
      feed.events.map(({ remoteEventId, title, startAt, endAt, timezone }) => ({
        remoteEventId,
        title,
        startAt,
        endAt,
        timezone
      }))
    ).toEqual([
      {
        remoteEventId: 'standup@test::2026-03-20T08:00:00.000Z',
        title: 'Standup',
        startAt: '2026-03-20T08:00:00.000Z',
        endAt: '2026-03-20T08:30:00.000Z',
        timezone: 'Europe/Berlin'
      },
      {
        remoteEventId: 'standup@test::2026-03-27T08:00:00.000Z',
        title: 'Standup',
        startAt: '2026-03-27T08:00:00.000Z',
        endAt: '2026-03-27T08:30:00.000Z',
        timezone: 'Europe/Berlin'
      },
      {
        remoteEventId: 'standup@test::2026-04-10T07:00:00.000Z',
        title: 'Standup (moved)',
        startAt: '2026-04-10T09:00:00.000Z',
        endAt: '2026-04-10T09:30:00.000Z',
        timezone: 'Europe/Berlin'
      }
    ])
  })

  it('reads all-day events, tentative status, and a TZID the feed never defines', () => {
    const feed = parseIcsFeed(
      calendar([
        'BEGIN:VEVENT',
        'UID:holiday@test',
        'DTSTART;VALUE=DATE:20260501',
        'DTEND;VALUE=DATE:20260502',
        'SUMMARY:Holiday',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:ny@test',
        'DTSTART;TZID=America/New_York:20260715T100000',
        'DTEND;TZID=America/New_York:20260715T110000',
        'SUMMARY:NY call',
        'LOCATION:Zoom',
        'DESCRIPTION:Agenda\\nfirst item',
        'STATUS:TENTATIVE',
        'LAST-MODIFIED:20260601T120000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:old@test',
        'DTSTART:20200101T100000Z',
        'SUMMARY:Before the window',
        'END:VEVENT'
      ]),
      WINDOW
    )

    expect(feed.events).toEqual([
      {
        remoteEventId: 'holiday@test',
        title: 'Holiday',
        description: null,
        location: null,
        startAt: '2026-05-01T00:00:00.000Z',
        endAt: '2026-05-02T00:00:00.000Z',
        isAllDay: true,
        timezone: null,
        status: 'confirmed',
        remoteUpdatedAt: null
      },
      {
        remoteEventId: 'ny@test',
        title: 'NY call',
        description: 'Agenda\nfirst item',
        location: 'Zoom',
        startAt: '2026-07-15T14:00:00.000Z',
        endAt: '2026-07-15T15:00:00.000Z',
        isAllDay: false,
        timezone: 'America/New_York',
        status: 'tentative',
        remoteUpdatedAt: '2026-06-01T12:00:00.000Z'
      }
    ])
  })

  it('shows only the in-window instances of an open-ended daily series that began years ago', () => {
    const feed = parseIcsFeed(
      calendar([
        'BEGIN:VEVENT',
        'UID:daily@test',
        'DTSTART:20150101T060000Z',
        'DTEND:20150101T061500Z',
        'RRULE:FREQ=DAILY',
        'SUMMARY:Run',
        'END:VEVENT'
      ]),
      { startAt: '2026-03-01T00:00:00.000Z', endAt: '2026-03-04T00:00:00.000Z' }
    )

    expect(feed.events.map((event) => event.startAt)).toEqual([
      '2026-03-01T06:00:00.000Z',
      '2026-03-02T06:00:00.000Z',
      '2026-03-03T06:00:00.000Z'
    ])
  })

  it('shows an instance moved into the window from a date past its end', () => {
    const feed = parseIcsFeed(
      calendar([
        'BEGIN:VEVENT',
        'UID:review@test',
        'DTSTART:20261218T150000Z',
        'DTEND:20261218T160000Z',
        'RRULE:FREQ=WEEKLY',
        'SUMMARY:Review',
        'END:VEVENT',
        // Pulled forward from after the window into it: must appear.
        'BEGIN:VEVENT',
        'UID:review@test',
        'RECURRENCE-ID:20270115T150000Z',
        'DTSTART:20261230T100000Z',
        'DTEND:20261230T110000Z',
        'SUMMARY:Review (pulled forward)',
        'END:VEVENT',
        // Moved, but still after the window: must not.
        'BEGIN:VEVENT',
        'UID:review@test',
        'RECURRENCE-ID:20270122T150000Z',
        'DTSTART:20270120T150000Z',
        'DTEND:20270120T160000Z',
        'SUMMARY:Review (still later)',
        'END:VEVENT',
        // Pulled forward but cancelled: must not.
        'BEGIN:VEVENT',
        'UID:review@test',
        'RECURRENCE-ID:20270129T150000Z',
        'DTSTART:20261231T100000Z',
        'STATUS:CANCELLED',
        'SUMMARY:Review',
        'END:VEVENT'
      ]),
      WINDOW
    )

    expect(
      feed.events.map(({ remoteEventId, title, startAt }) => [remoteEventId, title, startAt])
    ).toEqual([
      ['review@test::2026-12-18T15:00:00.000Z', 'Review', '2026-12-18T15:00:00.000Z'],
      ['review@test::2026-12-25T15:00:00.000Z', 'Review', '2026-12-25T15:00:00.000Z'],
      [
        'review@test::2027-01-15T15:00:00.000Z',
        'Review (pulled forward)',
        '2026-12-30T10:00:00.000Z'
      ]
    ])
  })

  it('rejects a response that is not an iCalendar document', () => {
    expect(errorCode(() => parseIcsFeed('<!doctype html><html></html>', WINDOW))).toBe(
      'not_a_calendar'
    )
    expect(
      errorCode(() => parseIcsFeed('BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ada\r\nEND:VCARD', WINDOW))
    ).toBe('not_a_calendar')
  })
})
