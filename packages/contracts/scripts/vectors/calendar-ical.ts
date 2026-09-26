/**
 * Class: calendar-ical (`calendar-ical.json`, spec 007 CL070).
 *
 * Desktop's own iCalendar reader, imported for real: `parseIcsFeed`
 * (`apps/desktop/src/main/calendar/ics/ics-feed.ts`) over `ical.js`, the path
 * subscribed feeds and CalDAV share. Each case records what desktop answers
 * for a feed and a window, run with the process in `ICAL_DEVICE_ZONE` so
 * floating times land where a phone in that zone would put them.
 *
 * The phone's core has no zone database: the shell passes each IANA zone a
 * feed names as offset transitions. The vector writes those tables too
 * (`zones`, `deviceZone`), computed from `Intl` for the case's window.
 */
// A namespace import: desktop's sources are CommonJS to Node, and the ESM
// loader cannot see their named exports statically.
import * as icsFeed from '../../../../apps/desktop/src/main/calendar/ics/ics-feed.ts'
import { ICAL_CASES, ICAL_DEVICE_ZONE, ICAL_KNOWN_ZONES, ICAL_URLS } from './calendar-ical-cases.ts'

type Row = Record<string, unknown>
type IcsFeedModule = typeof icsFeed

// Loaded as CommonJS, the exports may sit under `default`.
const feedModule: IcsFeedModule =
  (icsFeed as IcsFeedModule & { default?: IcsFeedModule }).default ?? icsFeed

function offsetIn(zone: string, ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric'
  }).formatToParts(new Date(ms))
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  )
  return asUtc - Math.floor(ms / 1000) * 1000
}

/** `{ identifier, baseOffsetMs, transitions }` over [from, to), found hourly. */
function zoneTable(zone: string, fromMs: number, toMs: number): Row {
  const transitions: Array<{ atMs: number; offsetMs: number }> = []
  let previous = offsetIn(zone, fromMs)
  for (let t = fromMs; t < toMs; t += 3_600_000) {
    const next = offsetIn(zone, t + 3_600_000)
    if (next === previous) continue
    let lo = t
    let hi = t + 3_600_000
    while (hi - lo > 60_000) {
      const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000
      if (offsetIn(zone, mid) === previous) lo = mid
      else hi = mid
    }
    transitions.push({ atMs: hi, offsetMs: next })
    previous = next
  }
  return { identifier: zone, baseOffsetMs: offsetIn(zone, fromMs), transitions }
}

function withZone<T>(tz: string, run: () => T): T {
  const previous = process.env.TZ
  process.env.TZ = tz
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
}

export function buildCalendarIcal(): Record<string, unknown> {
  // Wide enough for every case's window plus a year each side (UNTIL and
  // overrides reach outside the window).
  const fromMs = Date.UTC(2019, 0, 1)
  const toMs = Date.UTC(2028, 0, 1)
  return withZone(ICAL_DEVICE_ZONE, () => ({
    description:
      "What desktop's `parseIcsFeed` answers for each feed and window, the process in `deviceZone`. `zones` are the IANA zones the phone resolves.",
    deviceZone: zoneTable(ICAL_DEVICE_ZONE, fromMs, toMs),
    zones: ICAL_KNOWN_ZONES.map((zone) => zoneTable(zone, fromMs, toMs)),
    urls: ICAL_URLS.map((input) => {
      const normalized = feedModule.normalizeIcsUrl(input)
      return {
        input,
        normalized,
        sourceId: normalized ? feedModule.icsSourceIdForUrl(normalized) : null
      }
    }),
    cases: ICAL_CASES.map((c) => {
      const feed = feedModule.parseIcsFeed(c.text, c.window)
      return {
        name: c.name,
        text: c.text,
        window: c.window,
        expected: {
          name: feed.name,
          timezone: feed.timezone,
          refreshIntervalMs: feed.refreshIntervalMs,
          events: feed.events
        }
      }
    })
  }))
}
