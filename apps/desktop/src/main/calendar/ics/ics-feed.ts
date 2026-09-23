import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import type { IcsFeedErrorCode } from '@memry/contracts/calendar-api'
import { createLogger } from '../../lib/logger'

const log = createLogger('Calendar:IcsFeed')

// Pathological rules (FREQ=SECONDLY, a daily series from 1970) must not stall
// the main process. Steps bound the walk from DTSTART to the window; instances
// bound what one series may put on the calendar.
const MAX_RECURRENCE_STEPS = 50_000
const MAX_INSTANCES_PER_SERIES = 5_000

export class IcsFeedError extends Error {
  constructor(
    readonly code: IcsFeedErrorCode,
    message?: string
  ) {
    super(message ?? code)
    this.name = 'IcsFeedError'
  }
}

export interface IcsEventInstance {
  remoteEventId: string
  title: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  isAllDay: boolean
  timezone: string | null
  status: 'confirmed' | 'tentative'
  remoteUpdatedAt: string | null
}

export interface IcsFeed {
  name: string | null
  timezone: string | null
  refreshIntervalMs: number | null
  events: IcsEventInstance[]
}

export interface IcsExpansionWindow {
  startAt: string
  endAt: string
}

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

function isIanaZone(zone: string): boolean {
  try {
    zoneFormatter(zone)
    return true
  } catch {
    return false
  }
}

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

function wallTimeToUtcMs(time: ICAL.Time, zone: string): number {
  const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second)
  const firstGuess = wall - zoneOffsetMs(wall, zone)
  const offset = zoneOffsetMs(firstGuess, zone)
  return wall - offset
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0')
}

/**
 * A DATE value is a calendar day, stored the way the Google mirror stores one:
 * UTC midnight of that day. A DATE-TIME is an instant. ical.js resolves a TZID
 * against the feed's own VTIMEZONE; a TZID the feed never defines (common for
 * hand-written and some server feeds) falls back to floating time, so it is
 * resolved here as an IANA zone instead of silently landing in the viewer's
 * zone.
 */
function toInstant(time: ICAL.Time, unresolvedZone: string | null): string {
  if (time.isDate) {
    return `${pad(time.year, 4)}-${pad(time.month)}-${pad(time.day)}T00:00:00.000Z`
  }
  const isFloating = !time.zone || time.zone.tzid === 'floating'
  if (isFloating && unresolvedZone) {
    return new Date(wallTimeToUtcMs(time, unresolvedZone)).toISOString()
  }
  return time.toJSDate().toISOString()
}

function textProp(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function durationPropMs(component: ICAL.Component, name: string): number | null {
  const value = component.getFirstPropertyValue(name)
  if (value instanceof ICAL.Duration) return value.toSeconds() * 1000
  if (typeof value !== 'string') return null
  try {
    return ICAL.Duration.fromString(value.trim()).toSeconds() * 1000
  } catch {
    return null
  }
}

function timeProp(component: ICAL.Component, name: string): ICAL.Time | null {
  const value = component.getFirstPropertyValue(name)
  return value instanceof ICAL.Time ? value : null
}

function eventUid(component: ICAL.Component): string {
  const uid = textProp(component, 'uid')
  if (uid) return uid
  const fingerprint = `${component.getFirstPropertyValue('dtstart')?.toString() ?? ''}|${textProp(component, 'summary') ?? ''}`
  return `no-uid:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`
}

interface EventContext {
  uid: string
  unresolvedZone: string | null
}

function unresolvedZoneFor(component: ICAL.Component, calendarZone: string | null): string | null {
  const tzid = component.getFirstProperty('dtstart')?.getParameter('tzid')
  const candidate = typeof tzid === 'string' ? tzid : calendarZone
  return candidate && isIanaZone(candidate) ? candidate : null
}

function toInstance(
  item: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time | null,
  remoteEventId: string,
  context: EventContext
): IcsEventInstance | null {
  const status = textProp(item.component, 'status')?.toUpperCase()
  if (status === 'CANCELLED') return null

  const updated =
    timeProp(item.component, 'last-modified') ?? timeProp(item.component, 'dtstamp') ?? null
  const startAt = toInstant(start, context.unresolvedZone)
  const endAt = end ? toInstant(end, context.unresolvedZone) : null
  const startTzid = start.zone?.tzid

  return {
    remoteEventId,
    title: textProp(item.component, 'summary') ?? 'Untitled event',
    description: textProp(item.component, 'description'),
    location: textProp(item.component, 'location'),
    startAt,
    endAt: endAt && endAt > startAt ? endAt : null,
    isAllDay: start.isDate,
    timezone: start.isDate
      ? null
      : startTzid && startTzid !== 'floating'
        ? startTzid
        : context.unresolvedZone,
    status: status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    remoteUpdatedAt: updated ? toInstant(updated, null) : null
  }
}

function overlapsWindow(instance: IcsEventInstance, window: IcsExpansionWindow): boolean {
  return instance.startAt < window.endAt && (instance.endAt ?? instance.startAt) >= window.startAt
}

function expandSeries(
  master: ICAL.Event,
  context: EventContext,
  window: IcsExpansionWindow
): IcsEventInstance[] {
  const instances: IcsEventInstance[] = []
  const iterator = master.iterator()
  let steps = 0

  for (let next = iterator.next(); next; next = iterator.next()) {
    steps += 1
    if (steps > MAX_RECURRENCE_STEPS) {
      log.warn('Recurrence expansion stopped at the step limit', { uid: context.uid, steps })
      break
    }
    const recurrenceId = toInstant(next, context.unresolvedZone)
    if (recurrenceId >= window.endAt) break

    const details = master.getOccurrenceDetails(next)
    const instance = toInstance(
      details.item,
      details.startDate,
      details.endDate,
      `${context.uid}::${recurrenceId}`,
      context
    )
    if (!instance || !overlapsWindow(instance, window)) continue

    instances.push(instance)
    if (instances.length >= MAX_INSTANCES_PER_SERIES) {
      log.warn('Recurrence expansion stopped at the instance limit', { uid: context.uid })
      break
    }
  }

  return instances
}

function parseRoot(text: string): ICAL.Component {
  let root: ICAL.Component
  try {
    const parsed: unknown = ICAL.parse(text)
    const jCal = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : parsed
    root = new ICAL.Component(jCal as unknown[])
  } catch {
    throw new IcsFeedError('not_a_calendar')
  }
  if (root.name !== 'vcalendar') throw new IcsFeedError('not_a_calendar')
  return root
}

/**
 * Concrete instances inside `window`: series are expanded (RRULE, RDATE,
 * EXDATE, RECURRENCE-ID overrides) and cancelled instances are dropped.
 */
export function parseIcsFeed(text: string, window: IcsExpansionWindow): IcsFeed {
  const root = parseRoot(text)
  const calendarZone = textProp(root, 'x-wr-timezone')

  const series = new Map<string, { master: ICAL.Event | null; overrides: ICAL.Component[] }>()
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const uid = eventUid(vevent)
    const entry = series.get(uid) ?? { master: null, overrides: [] }
    if (vevent.hasProperty('recurrence-id')) {
      entry.overrides.push(vevent)
    } else {
      entry.master = new ICAL.Event(vevent)
    }
    series.set(uid, entry)
  }

  const events: IcsEventInstance[] = []
  for (const [uid, { master, overrides }] of series) {
    if (master && !master.component.hasProperty('dtstart')) continue

    if (master?.isRecurring()) {
      for (const override of overrides) master.relateException(override)
      const context = { uid, unresolvedZone: unresolvedZoneFor(master.component, calendarZone) }
      events.push(...expandSeries(master, context, window))
      continue
    }

    // A single event, or overrides whose master the feed left out: each one
    // is shown as the standalone instance it describes.
    const singles = master ? [master] : overrides.map((override) => new ICAL.Event(override))
    for (const event of singles) {
      if (!event.component.hasProperty('dtstart')) continue
      const context = { uid, unresolvedZone: unresolvedZoneFor(event.component, calendarZone) }
      const recurrenceId = event.isRecurrenceException()
        ? `${uid}::${toInstant(event.recurrenceId, context.unresolvedZone)}`
        : uid
      const instance = toInstance(event, event.startDate, event.endDate, recurrenceId, context)
      if (instance && overlapsWindow(instance, window)) events.push(instance)
    }
  }

  return {
    name: textProp(root, 'x-wr-calname') ?? textProp(root, 'name'),
    timezone: calendarZone,
    refreshIntervalMs:
      durationPropMs(root, 'refresh-interval') ?? durationPropMs(root, 'x-published-ttl'),
    events
  }
}
