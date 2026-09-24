import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import { createLogger } from '../../lib/logger'
import { isIanaZone, toInstant } from './ical-time'

/**
 * VEVENT → concrete instances, shared by ICS feeds and CalDAV (#1399). There
 * is one parser: series expansion (RRULE, RDATE, EXDATE, RECURRENCE-ID
 * overrides), VTIMEZONE / undefined-TZID / floating handling, cancelled
 * instances dropped, and caps on runaway rules. Moved verbatim from
 * `ics/ics-feed.ts`; only the instance id became a parameter, because a
 * CalDAV object is keyed by its href, not its UID.
 */

const log = createLogger('Calendar:ICal')

// Pathological rules (FREQ=SECONDLY, a daily series from 1970) must not stall
// the main process. Steps bound the walk from DTSTART to the window; instances
// bound what one series may put on the calendar.
const MAX_RECURRENCE_STEPS = 50_000
const MAX_INSTANCES_PER_SERIES = 5_000

/** The text is not an iCalendar object at all. */
export class ICalParseError extends Error {
  constructor(message = 'not_a_calendar') {
    super(message)
    this.name = 'ICalParseError'
  }
}

export interface ICalEventInstance {
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

export interface ICalExpansionWindow {
  startAt: string
  endAt: string
}

/**
 * How an instance is identified. `recurrenceId` is the instance's original
 * start as an ISO instant, or null for a non-recurring event.
 */
export type ICalInstanceKey = (uid: string, recurrenceId: string | null) => string

export const uidInstanceKey: ICalInstanceKey = (uid, recurrenceId) =>
  recurrenceId ? `${uid}::${recurrenceId}` : uid

export function textProp(component: ICAL.Component, name: string): string | null {
  const value = component.getFirstPropertyValue(name)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function durationPropMs(component: ICAL.Component, name: string): number | null {
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

export function eventUid(component: ICAL.Component): string {
  const uid = textProp(component, 'uid')
  if (uid) return uid
  const fingerprint = `${component.getFirstPropertyValue('dtstart')?.toString() ?? ''}|${textProp(component, 'summary') ?? ''}`
  return `no-uid:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`
}

interface EventContext {
  uid: string
  unresolvedZone: string | null
  keyFor: ICalInstanceKey
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
): ICalEventInstance | null {
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

function overlapsWindow(instance: ICalEventInstance, window: ICalExpansionWindow): boolean {
  return instance.startAt < window.endAt && (instance.endAt ?? instance.startAt) >= window.startAt
}

function expandSeries(
  master: ICAL.Event,
  context: EventContext,
  window: ICalExpansionWindow
): ICalEventInstance[] {
  const instances: ICalEventInstance[] = []
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
      context.keyFor(context.uid, recurrenceId),
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

/**
 * The walk in `expandSeries` stops at the window's end, so an override whose
 * original date lies past the window never comes up, even when it moved the
 * instance into the window (a meeting next year pulled forward to next week).
 * Those overrides are placed on their own, keyed by their original date like
 * every other instance. Overrides the walk already reached are skipped.
 */
function overridesMovedIntoWindow(
  overrides: ICAL.Component[],
  expanded: ICalEventInstance[],
  context: EventContext,
  window: ICalExpansionWindow
): ICalEventInstance[] {
  const placed = new Set(expanded.map((instance) => instance.remoteEventId))
  const instances: ICalEventInstance[] = []
  for (const override of overrides) {
    const event = new ICAL.Event(override)
    if (!override.hasProperty('dtstart') || !event.recurrenceId) continue
    const recurrenceId = toInstant(event.recurrenceId, context.unresolvedZone)
    if (recurrenceId < window.endAt) continue
    const remoteEventId = context.keyFor(context.uid, recurrenceId)
    if (placed.has(remoteEventId)) continue
    const instance = toInstance(event, event.startDate, event.endDate, remoteEventId, context)
    if (instance && overlapsWindow(instance, window)) {
      placed.add(remoteEventId)
      instances.push(instance)
    }
  }
  return instances
}

/** Parse iCalendar text into its VCALENDAR component. */
export function parseICalendar(text: string): ICAL.Component {
  let root: ICAL.Component
  try {
    const parsed: unknown = ICAL.parse(text)
    const jCal = Array.isArray(parsed) && Array.isArray(parsed[0]) ? parsed[0] : parsed
    root = new ICAL.Component(jCal as unknown[])
  } catch {
    throw new ICalParseError()
  }
  if (root.name !== 'vcalendar') throw new ICalParseError()
  return root
}

/**
 * Concrete instances inside `window`: series are expanded (RRULE, RDATE,
 * EXDATE, RECURRENCE-ID overrides) and cancelled instances are dropped.
 */
export function expandCalendarEvents(
  root: ICAL.Component,
  window: ICalExpansionWindow,
  options: { calendarZone?: string | null; keyFor?: ICalInstanceKey } = {}
): ICalEventInstance[] {
  const calendarZone = options.calendarZone ?? textProp(root, 'x-wr-timezone')
  const keyFor = options.keyFor ?? uidInstanceKey

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

  const events: ICalEventInstance[] = []
  for (const [uid, { master, overrides }] of series) {
    if (master && !master.component.hasProperty('dtstart')) continue

    if (master?.isRecurring()) {
      for (const override of overrides) master.relateException(override)
      const context = {
        uid,
        unresolvedZone: unresolvedZoneFor(master.component, calendarZone),
        keyFor
      }
      const expanded = expandSeries(master, context, window)
      events.push(...expanded, ...overridesMovedIntoWindow(overrides, expanded, context, window))
      continue
    }

    // A single event, or overrides whose master the object left out: each one
    // is shown as the standalone instance it describes.
    const singles = master ? [master] : overrides.map((override) => new ICAL.Event(override))
    for (const event of singles) {
      if (!event.component.hasProperty('dtstart')) continue
      const context = {
        uid,
        unresolvedZone: unresolvedZoneFor(event.component, calendarZone),
        keyFor
      }
      const remoteEventId = event.isRecurrenceException()
        ? keyFor(uid, toInstant(event.recurrenceId, context.unresolvedZone))
        : keyFor(uid, null)
      const instance = toInstance(event, event.startDate, event.endDate, remoteEventId, context)
      if (instance && overlapsWindow(instance, window)) events.push(instance)
    }
  }

  return events
}
