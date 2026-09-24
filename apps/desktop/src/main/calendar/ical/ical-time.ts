import ICAL from 'ical.js'

/**
 * Time handling shared by every iCalendar reader (ICS feeds, CalDAV).
 * Extracted from `ics/ics-feed.ts` (#1399) without behaviour changes.
 */

const zoneFormatters = new Map<string, Intl.DateTimeFormat>()

function zoneFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zoneFormatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    zoneFormatters.set(zone, formatter)
  }
  return formatter
}

export function isIanaZone(zone: string): boolean {
  try {
    zoneFormatter(zone)
    return true
  } catch {
    return false
  }
}

function zoneOffsetMs(utcMs: number, zone: string): number {
  const parts = zoneFormatter(zone).formatToParts(new Date(utcMs))
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  )
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** A wall-clock time in an IANA zone, as a UTC epoch. */
export function wallTimeToUtcMs(
  time: Pick<ICAL.Time, 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second'>,
  zone: string
): number {
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)
  const firstGuess = wall - zoneOffsetMs(wall, zone)
  const offset = zoneOffsetMs(firstGuess, zone)
  return wall - offset
}

/** The wall-clock fields of a UTC instant in an IANA zone. */
export function utcToWallTime(
  utcMs: number,
  zone: string
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = zoneFormatter(zone).formatToParts(new Date(utcMs))
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second')
  }
}

export function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * A DATE value is a calendar day, stored the way the Google mirror stores one:
 * UTC midnight of that day. A DATE-TIME is an instant. ical.js resolves a TZID
 * against the object's own VTIMEZONE; a TZID the object never defines (common
 * for hand-written and some server feeds) falls back to floating time, so it
 * is resolved here as an IANA zone instead of silently landing in the viewer's
 * zone.
 */
export function toInstant(time: ICAL.Time, unresolvedZone: string | null): string {
  if (time.isDate) {
    return `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}T00:00:00.000Z`
  }
  const isFloating = !time.zone || time.zone.tzid === 'floating'
  if (isFloating && unresolvedZone) {
    return new Date(wallTimeToUtcMs(time, unresolvedZone)).toISOString()
  }
  return time.toJSDate().toISOString()
}
