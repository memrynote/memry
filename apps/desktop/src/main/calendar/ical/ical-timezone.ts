import { isIanaZone, pad, utcToWallTime } from './ical-time'

/**
 * A VTIMEZONE for an IANA zone, built from the runtime's own time zone data
 * (#1400). iCalendar objects that carry a TZID should define it, so a client
 * without the IANA database still places every instance of a series right,
 * including across daylight-saving changes.
 *
 * The component lists each UTC-offset change in the covered years as its own
 * STANDARD or DAYLIGHT observance, found by sampling the offset weekly and
 * narrowing each change to the minute. A zone without changes gets one
 * STANDARD observance.
 */

const MINUTE_MS = 60 * 1000
const WEEK_MS = 7 * 24 * 60 * MINUTE_MS

function offsetMinutes(utcMs: number, zone: string): number {
  const wall = utcToWallTime(utcMs, zone)
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / MINUTE_MS)
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  return `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`
}

function formatLocal(utcMs: number, offset: number): string {
  const local = new Date(utcMs + offset * MINUTE_MS)
  return `${pad(local.getUTCFullYear(), 4)}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`
}

/** The first instant (to the minute) in (from, to] whose offset differs from `from`'s. */
function findTransition(zone: string, from: number, to: number): number {
  const before = offsetMinutes(from, zone)
  let low = from
  let high = to
  while (high - low > MINUTE_MS) {
    const middle = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS
    if (offsetMinutes(middle, zone) === before) low = middle
    else high = middle
  }
  return high
}

export function buildVTimezone(
  zone: string,
  range: { fromYear: number; toYear: number }
): string | null {
  if (!isIanaZone(zone) || zone === 'UTC' || zone === 'Etc/UTC') return null
  const start = Date.UTC(range.fromYear, 0, 1)
  const end = Date.UTC(range.toYear + 1, 0, 1)

  const transitions: Array<{ at: number; from: number; to: number }> = []
  let previousOffset = offsetMinutes(start, zone)
  for (let cursor = start; cursor < end; cursor += WEEK_MS) {
    const next = Math.min(cursor + WEEK_MS, end)
    const nextOffset = offsetMinutes(next, zone)
    if (nextOffset !== previousOffset) {
      const at = findTransition(zone, cursor, next)
      transitions.push({ at, from: previousOffset, to: offsetMinutes(at, zone) })
      previousOffset = nextOffset
    }
  }

  // The offset in force at the start of the range, so a time before the first
  // change still resolves.
  const initial = formatOffset(offsetMinutes(start, zone))
  const lines = [
    'BEGIN:VTIMEZONE',
    `TZID:${zone}`,
    'BEGIN:STANDARD',
    `DTSTART:${range.fromYear}0101T000000`,
    `TZOFFSETFROM:${initial}`,
    `TZOFFSETTO:${initial}`,
    'END:STANDARD'
  ]
  for (const transition of transitions) {
    const kind = transition.to > transition.from ? 'DAYLIGHT' : 'STANDARD'
    lines.push(
      `BEGIN:${kind}`,
      // DTSTART is the local time just before the change, in the old offset.
      `DTSTART:${formatLocal(transition.at, transition.from)}`,
      `TZOFFSETFROM:${formatOffset(transition.from)}`,
      `TZOFFSETTO:${formatOffset(transition.to)}`,
      `END:${kind}`
    )
  }
  lines.push('END:VTIMEZONE')
  return lines.join('\r\n')
}
