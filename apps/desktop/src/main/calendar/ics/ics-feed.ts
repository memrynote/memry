import { createHash } from 'node:crypto'
import type { IcsFeedErrorCode } from '@memry/contracts/calendar-api'
import {
  ICalParseError,
  durationPropMs,
  expandCalendarEvents,
  parseICalendar,
  textProp,
  type ICalEventInstance,
  type ICalExpansionWindow
} from '../ical/ical-events'

export class IcsFeedError extends Error {
  constructor(
    readonly code: IcsFeedErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'IcsFeedError'
  }
}

/** One concrete event instance from a feed. The parser lives in `../ical/` (#1399). */
export type IcsEventInstance = ICalEventInstance

export interface IcsFeed {
  name: string | null
  timezone: string | null
  refreshIntervalMs: number | null
  events: IcsEventInstance[]
}

export type IcsExpansionWindow = ICalExpansionWindow

/**
 * Accepts what calendar apps hand out as a "public" or "secret" address:
 * `webcal://` and `webcals://` are plain HTTPS with a scheme that tells the OS
 * to open a calendar app. Returns null for anything that is not an http(s)
 * address once the scheme is normalised.
 */
export function normalizeIcsUrl(input: string): string | null {
  const trimmed = input.trim()
  const rewritten = trimmed.replace(/^webcals?:\/\//i, 'https://')
  let url: URL
  try {
    url = new URL(rewritten)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!url.hostname) return null
  url.hash = ''
  return url.toString()
}

/** Same URL, same source row, on every device: subscribing twice converges. */
export function icsSourceIdForUrl(normalizedUrl: string): string {
  const digest = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 32)
  return `ics-calendar:${digest}`
}

/**
 * Concrete instances inside `window`: series are expanded (RRULE, RDATE,
 * EXDATE, RECURRENCE-ID overrides) and cancelled instances are dropped.
 */
export function parseIcsFeed(text: string, window: IcsExpansionWindow): IcsFeed {
  let root: ReturnType<typeof parseICalendar>
  try {
    root = parseICalendar(text)
  } catch (error) {
    if (error instanceof ICalParseError) throw new IcsFeedError('not_a_calendar')
    throw error
  }
  const calendarZone = textProp(root, 'x-wr-timezone')

  return {
    name: textProp(root, 'x-wr-calname') ?? textProp(root, 'name'),
    timezone: calendarZone,
    refreshIntervalMs:
      durationPropMs(root, 'refresh-interval') ?? durationPropMs(root, 'x-published-ttl'),
    events: expandCalendarEvents(root, window, { calendarZone })
  }
}
