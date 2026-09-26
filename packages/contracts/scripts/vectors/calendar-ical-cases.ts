/**
 * Feeds for `calendar-ical.json` (spec 007 CL070). Each exercises one part of
 * desktop's iCalendar reader: zones (UTC, IANA TZID with and without a
 * VTIMEZONE, a Windows TZID with its VTIMEZONE, an undefined TZID, floating
 * with and without `X-WR-TIMEZONE`), all-day spans, series (weekly by day,
 * monthly nth weekday, yearly, COUNT, UNTIL, EXDATE, RDATE, moved and
 * cancelled overrides, an override moved in from past the window), DURATION,
 * status, a missing UID and a folded, escaped summary.
 */

const wrap = (body: string, head = ''): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//memry//vectors//EN', head, body, 'END:VCALENDAR']
    .filter((line) => line.length > 0)
    .join('\r\n') + '\r\n'

const NEW_YORK_TZ = [
  'BEGIN:VTIMEZONE',
  'TZID:America/New_York',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:-0500',
  'TZOFFSETTO:-0400',
  'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:-0400',
  'TZOFFSETTO:-0500',
  'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
  'END:STANDARD',
  'END:VTIMEZONE'
].join('\r\n')

const WINDOWS_TZ = [
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE'
].join('\r\n')

export interface IcalCase {
  name: string
  text: string
  window: { startAt: string; endAt: string }
}

const WINDOW = { startAt: '2026-01-01T00:00:00.000Z', endAt: '2026-12-31T00:00:00.000Z' }

export const ICAL_CASES: IcalCase[] = [
  {
    name: 'singles in every zone form',
    window: WINDOW,
    text: wrap(
      [
        NEW_YORK_TZ,
        WINDOWS_TZ,
        'BEGIN:VEVENT\r\nUID:utc\r\nDTSTAMP:20260101T000000Z\r\nSUMMARY:UTC call\r\nDTSTART:20260310T150000Z\r\nDTEND:20260310T153000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:ny\r\nLAST-MODIFIED:20260102T101500Z\r\nSUMMARY:NY lunch\r\nDTSTART;TZID=America/New_York:20260310T120000\r\nDTEND;TZID=America/New_York:20260310T130000\r\nLOCATION:Midtown\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:win\r\nSUMMARY:Berlin standup\r\nDTSTART;TZID=W. Europe Standard Time:20260701T091500\r\nDURATION:PT15M\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:iana-undefined\r\nSUMMARY:Tokyo sync\r\nDTSTART;TZID=Asia/Tokyo:20260415T090000\r\nDTEND;TZID=Asia/Tokyo:20260415T100000\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:unknown-tzid\r\nSUMMARY:Mystery zone\r\nDTSTART;TZID=Nowhere/Special:20260501T080000\r\nDTEND;TZID=Nowhere/Special:20260501T090000\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:floating\r\nSUMMARY:Floating\r\nDTSTART:20260601T070000\r\nDTEND:20260601T073000\r\nSTATUS:TENTATIVE\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:allday\r\nSUMMARY:Offsite\\, day one\r\nDTSTART;VALUE=DATE:20260320\r\nDTEND;VALUE=DATE:20260323\r\nDESCRIPTION:Line one\\nLine two\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:allday-single\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260501\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:cancelled\r\nSUMMARY:Gone\r\nDTSTART:20260402T100000Z\r\nSTATUS:CANCELLED\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nSUMMARY:No uid here\r\nDTSTART:20260403T100000Z\r\nDTEND:20260403T110000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:folded\r\nSUMMARY:A very long summary that the producer\r\n  folded across lines\r\nDTSTART:20260404T100000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:outside\r\nSUMMARY:Next year\r\nDTSTART:20270404T100000Z\r\nEND:VEVENT'
      ].join('\r\n'),
      'X-WR-CALNAME:Vectors\r\nREFRESH-INTERVAL;VALUE=DURATION:PT4H'
    )
  },
  {
    name: 'floating reads in the calendar zone',
    window: WINDOW,
    text: wrap(
      [
        'BEGIN:VEVENT\r\nUID:float-cal\r\nSUMMARY:Floating in LA\r\nDTSTART:20260310T090000\r\nDTEND:20260310T100000\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:weekly-float\r\nSUMMARY:Gym\r\nDTSTART:20260302T180000\r\nDTEND:20260302T190000\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=6\r\nEND:VEVENT'
      ].join('\r\n'),
      'X-WR-TIMEZONE:America/Los_Angeles\r\nX-PUBLISHED-TTL:PT1H'
    )
  },
  {
    name: 'series across DST with overrides and exdates',
    window: { startAt: '2026-02-20T00:00:00.000Z', endAt: '2026-04-10T00:00:00.000Z' },
    text: wrap(
      [
        NEW_YORK_TZ,
        'BEGIN:VEVENT\r\nUID:weekly\r\nSUMMARY:Standup\r\nDTSTART;TZID=America/New_York:20260105T093000\r\nDTEND;TZID=America/New_York:20260105T094500\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nEXDATE;TZID=America/New_York:20260304T093000\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=America/New_York:20260309T093000\r\nSUMMARY:Standup (moved)\r\nDTSTART;TZID=America/New_York:20260309T110000\r\nDTEND;TZID=America/New_York:20260309T113000\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=America/New_York:20260311T093000\r\nSUMMARY:Standup\r\nSTATUS:CANCELLED\r\nDTSTART;TZID=America/New_York:20260311T093000\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:weekly\r\nRECURRENCE-ID;TZID=America/New_York:20260622T093000\r\nSUMMARY:Standup (pulled forward)\r\nDTSTART;TZID=America/New_York:20260325T150000\r\nDTEND;TZID=America/New_York:20260325T151500\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:monthly\r\nSUMMARY:Review\r\nDTSTART:20260113T160000Z\r\nDURATION:PT1H\r\nRRULE:FREQ=MONTHLY;BYDAY=2TU;UNTIL=20260331T235959Z\r\nRDATE:20260320T160000Z\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:yearly-allday\r\nSUMMARY:Anniversary\r\nDTSTART;VALUE=DATE:20200301\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:daily-count\r\nSUMMARY:Pills\r\nDTSTART:20260226T080000Z\r\nRRULE:FREQ=DAILY;INTERVAL=2;COUNT=4\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:last-friday\r\nSUMMARY:Payday\r\nDTSTART;VALUE=DATE:20260130\r\nRRULE:FREQ=MONTHLY;BYDAY=-1FR\r\nEXDATE;VALUE=DATE:20260327\r\nEND:VEVENT',
        'BEGIN:VEVENT\r\nUID:orphan\r\nRECURRENCE-ID:20260305T120000Z\r\nSUMMARY:Orphan override\r\nDTSTART:20260305T130000Z\r\nDTEND:20260305T140000Z\r\nEND:VEVENT'
      ].join('\r\n')
    )
  }
]

/** The zones the vector passes as known IANA names (the phone's `TimeZone`). */
export const ICAL_KNOWN_ZONES = ['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']

/** The process zone floating times fall back to (the phone's own). */
export const ICAL_DEVICE_ZONE = 'Europe/Istanbul'

/** Links as people paste them, for `normalizeIcsUrl` + `icsSourceIdForUrl`. */
export const ICAL_URLS = [
  'webcal://Example.com/cal.ics',
  'webcals://calendar.example.org/feeds/abc.ics?token=XyZ',
  ' HTTPS://Example.com:443 ',
  'http://example.com:8080/a?b=c#frag',
  'https://user:pw@Example.com/private.ics',
  'https://example.com/path with space.ics',
  'ftp://example.com/x',
  'not a url',
  'https://'
]

/** Server addresses and users as people type them (`caldav-accounts.ts`). */
export const CALDAV_INPUTS = [
  { server: 'caldav.fastmail.com', username: 'Agent@Example.com' },
  { server: 'https://DAV.example.org/remote.php/dav?x=1#y', username: ' agent ' },
  { server: 'https://localhost:5232/agent', username: 'agent' },
  { server: 'http://192.168.1.10:8080/dav/', username: 'kaan' },
  { server: '  ', username: 'x' },
  { server: 'ftp://example.com', username: 'x' }
]
