import ICAL from 'ical.js'
import type {
  CalendarAttendee,
  CalendarReminders,
  CalendarVisibility
} from '@memry/db-schema/schema/calendar-events'
import type { RemoteCalendarEvent, UpsertRemoteEventInput } from '../types'
import { isIanaZone, pad, toInstant, utcToWallTime } from './ical-time'
import { buildVTimezone } from './ical-timezone'
import { eventUid, parseICalendar, textProp } from './ical-events'

/**
 * Memry event → iCalendar, for providers that store iCalendar objects
 * (CalDAV, #1400).
 *
 * Updates patch the stored object instead of regenerating it: only the
 * properties Memry owns are rewritten, and every other property, component
 * and `X-` extension other clients rely on survives. Memry marks objects it
 * created with `X-MEMRY-SOURCE-ID`; only on those does it own the recurrence
 * rules, so editing a copy of someone else's series never strips its RRULE.
 */

const PRODID = '-//memrynote//Calendar//EN'
const MEMRY_SOURCE = 'x-memry-source-id'
const MEMRY_SOURCE_TYPE = 'x-memry-source-type'

// RFC 7986 COLOR takes a CSS3 colour name. The nearest name per event colour;
// reading maps only these exact names back.
const COLOR_NAME_BY_ID: Record<string, string> = {
  '11': 'tomato',
  '4': 'lightcoral',
  '6': 'darkorange',
  '5': 'gold',
  '2': 'mediumseagreen',
  '10': 'seagreen',
  '7': 'deepskyblue',
  '9': 'royalblue',
  '1': 'mediumpurple',
  '3': 'darkviolet',
  '8': 'gray'
}
const COLOR_ID_BY_NAME = new Map(Object.entries(COLOR_NAME_BY_ID).map(([id, name]) => [name, id]))

const CLASS_BY_VISIBILITY: Record<string, string | null> = {
  default: null,
  public: 'PUBLIC',
  private: 'PRIVATE',
  confidential: 'CONFIDENTIAL'
}

function isUtcZone(zone: string | null | undefined): boolean {
  return !zone || zone === 'UTC' || zone === 'Etc/UTC' || !isIanaZone(zone)
}

function utcStamp(iso: string): string {
  return `${iso.replace(/\.\d+/, '').replace(/[-:]/g, '').replace(/Z$/, '')}Z`
}

function zonedStamp(iso: string, zone: string): string {
  const wall = utcToWallTime(new Date(iso).getTime(), zone)
  return `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`
}

function dateStamp(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '')
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate.slice(0, 10)}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

/** The DTSTART / DTEND lines for an event, in the event's own zone. */
function timeLines(event: UpsertRemoteEventInput): string[] {
  if (event.isAllDay) {
    const start = event.startAt
    const end =
      event.endAt && event.endAt.slice(0, 10) > start.slice(0, 10) ? event.endAt : addDays(start, 1)
    return [`DTSTART;VALUE=DATE:${dateStamp(start)}`, `DTEND;VALUE=DATE:${dateStamp(end)}`]
  }
  if (isUtcZone(event.timezone)) {
    return [
      `DTSTART:${utcStamp(event.startAt)}`,
      ...(event.endAt ? [`DTEND:${utcStamp(event.endAt)}`] : [])
    ]
  }
  return [
    `DTSTART;TZID=${event.timezone}:${zonedStamp(event.startAt, event.timezone)}`,
    ...(event.endAt
      ? [`DTEND;TZID=${event.timezone}:${zonedStamp(event.endAt, event.timezone)}`]
      : [])
  ]
}

function escapeParam(value: string): string {
  return /[;:,"]/.test(value) ? `"${value.replace(/"/g, "'")}"` : value
}

function attendeeLines(attendees: CalendarAttendee[]): string[] {
  const partstat: Record<string, string> = {
    accepted: 'ACCEPTED',
    declined: 'DECLINED',
    tentative: 'TENTATIVE',
    needsAction: 'NEEDS-ACTION'
  }
  return attendees.flatMap((attendee) => {
    const params = [
      ...(attendee.displayName ? [`CN=${escapeParam(attendee.displayName)}`] : []),
      ...(attendee.responseStatus
        ? [`PARTSTAT=${partstat[attendee.responseStatus] ?? 'NEEDS-ACTION'}`]
        : []),
      `ROLE=${attendee.optional ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT'}`
    ]
    const line = `ATTENDEE;${params.join(';')}:mailto:${attendee.email}`
    return attendee.organizer
      ? [
          `ORGANIZER${attendee.displayName ? `;CN=${escapeParam(attendee.displayName)}` : ''}:mailto:${attendee.email}`,
          line
        ]
      : [line]
  })
}

function alarmComponents(reminders: CalendarReminders): ICAL.Component[] {
  return reminders.overrides.map((override) =>
    ICAL.Component.fromString(
      [
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        'DESCRIPTION:Reminder',
        `TRIGGER:-PT${Math.max(0, Math.round(override.minutes))}M`,
        'END:VALARM'
      ].join('\r\n')
    )
  )
}

function setLines(component: ICAL.Component, names: string[], lines: string[]): void {
  for (const name of names) component.removeAllProperties(name)
  for (const line of lines) component.addProperty(ICAL.Property.fromString(line))
}

function setText(component: ICAL.Component, name: string, value: string | null): void {
  if (value === null || value === '') component.removeAllProperties(name)
  else component.updatePropertyWithValue(name, value)
}

function ensureTimezone(root: ICAL.Component, event: UpsertRemoteEventInput): void {
  if (event.isAllDay || isUtcZone(event.timezone)) return
  const defined = root
    .getAllSubcomponents('vtimezone')
    .some((zone) => textProp(zone, 'tzid') === event.timezone)
  if (defined) return
  const year = new Date(event.startAt).getUTCFullYear()
  const vtimezone = buildVTimezone(event.timezone, { fromYear: year - 1, toYear: year + 10 })
  if (vtimezone) root.addSubcomponent(ICAL.Component.fromString(vtimezone))
}

function stamp(now: Date): string {
  return utcStamp(now.toISOString())
}

/** Rewrite the properties Memry owns on one VEVENT; returns whether the change is "meaningful" (RFC 5545 SEQUENCE). */
function applyOwnedFields(
  vevent: ICAL.Component,
  event: UpsertRemoteEventInput,
  options: { ownsRecurrence: boolean; isOverride: boolean; now: Date }
): boolean {
  const meaningfulBefore = [
    'dtstart',
    'dtend',
    'duration',
    'rrule',
    'exdate',
    'summary',
    'location'
  ]
    .map((name) =>
      vevent
        .getAllProperties(name)
        .map((property) => property.toICALString())
        .join('|')
    )
    .join('||')

  setText(vevent, 'summary', event.title)
  setText(vevent, 'description', event.description)
  setText(vevent, 'location', event.location)
  setLines(vevent, ['dtstart', 'dtend', 'duration'], timeLines(event))

  if (!options.isOverride && (options.ownsRecurrence || event.recurrence?.length)) {
    const lines = (event.recurrence ?? []).filter((line) => /^(RRULE|EXDATE|RDATE)[:;]/i.test(line))
    setLines(vevent, ['rrule', 'exdate', 'rdate'], lines)
  }

  if (event.attendees && event.attendees.length > 0) {
    setLines(vevent, ['attendee', 'organizer'], attendeeLines(event.attendees))
  }

  if (event.reminders && !event.reminders.useDefault) {
    vevent.removeAllSubcomponents('valarm')
    for (const alarm of alarmComponents(event.reminders)) vevent.addSubcomponent(alarm)
  }

  if (event.visibility) {
    const classValue = CLASS_BY_VISIBILITY[event.visibility]
    setText(vevent, 'class', classValue ?? null)
  }

  if (event.colorId && COLOR_NAME_BY_ID[event.colorId]) {
    vevent.updatePropertyWithValue('color', COLOR_NAME_BY_ID[event.colorId])
  } else if (event.colorId === null) {
    const current = textProp(vevent, 'color')?.toLowerCase()
    if (current && COLOR_ID_BY_NAME.has(current)) vevent.removeAllProperties('color')
  }

  const meaningfulAfter = ['dtstart', 'dtend', 'duration', 'rrule', 'exdate', 'summary', 'location']
    .map((name) =>
      vevent
        .getAllProperties(name)
        .map((property) => property.toICALString())
        .join('|')
    )
    .join('||')
  const meaningful = meaningfulBefore !== meaningfulAfter
  if (meaningful) {
    const sequence = Number(vevent.getFirstPropertyValue('sequence') ?? 0)
    vevent.updatePropertyWithValue('sequence', Number.isFinite(sequence) ? sequence + 1 : 1)
  }
  setLines(
    vevent,
    ['dtstamp', 'last-modified'],
    [`DTSTAMP:${stamp(options.now)}`, `LAST-MODIFIED:${stamp(options.now)}`]
  )
  return meaningful
}

/** A new iCalendar object for a Memry item. */
export function eventToICalendar(
  event: UpsertRemoteEventInput,
  options: { uid: string; now?: Date }
): string {
  const now = options.now ?? new Date()
  const root = ICAL.Component.fromString(
    ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'END:VCALENDAR'].join('\r\n')
  )
  const vevent = ICAL.Component.fromString(
    [
      'BEGIN:VEVENT',
      `UID:${options.uid}`,
      `DTSTAMP:${stamp(now)}`,
      `CREATED:${stamp(now)}`,
      'SEQUENCE:0',
      'END:VEVENT'
    ].join('\r\n')
  )
  vevent.updatePropertyWithValue(MEMRY_SOURCE, event.sourceId)
  vevent.updatePropertyWithValue(MEMRY_SOURCE_TYPE, event.sourceType)
  applyOwnedFields(vevent, event, { ownsRecurrence: true, isOverride: false, now })
  vevent.updatePropertyWithValue('sequence', 0)
  ensureTimezone(root, event)
  root.addSubcomponent(vevent)
  return root.toString()
}

function recurrenceIdMatches(component: ICAL.Component, recurrenceId: string): boolean {
  const value = component.getFirstPropertyValue('recurrence-id')
  if (!(value instanceof ICAL.Time)) return false
  return toInstant(value, null) === recurrenceId
}

function masterOf(root: ICAL.Component): ICAL.Component | null {
  return (
    root.getAllSubcomponents('vevent').find((vevent) => !vevent.hasProperty('recurrence-id')) ??
    null
  )
}

/**
 * An EXDATE or RECURRENCE-ID line for one occurrence of `master`. RFC 5545
 * requires the same value type as DTSTART, and clients match occurrences by
 * it: a DATE for an all-day series, the series' TZID for a zoned one (when
 * the object carries that VTIMEZONE and it is a zone we can compute), UTC
 * otherwise.
 */
function occurrenceLine(
  name: 'EXDATE' | 'RECURRENCE-ID',
  root: ICAL.Component,
  master: ICAL.Component,
  recurrenceId: string
): string {
  const start = master.getFirstPropertyValue('dtstart')
  if (start instanceof ICAL.Time && start.isDate) {
    return `${name};VALUE=DATE:${dateStamp(recurrenceId)}`
  }
  const tzid = start instanceof ICAL.Time ? start.zone?.tzid : undefined
  const hasZone =
    tzid &&
    !isUtcZone(tzid) &&
    root
      .getAllSubcomponents('vtimezone')
      .some((zone) => zone.getFirstPropertyValue('tzid') === tzid)
  if (tzid && hasZone) return `${name};TZID=${tzid}:${zonedStamp(recurrenceId, tzid)}`
  return `${name}:${utcStamp(recurrenceId)}`
}

/**
 * Whether the series still produces this occurrence. Another client deleting
 * one occurrence adds an EXDATE (or shortens the RRULE); the occurrence is then
 * gone even though the object is not.
 */
function seriesHasOccurrence(master: ICAL.Component, recurrenceId: string): boolean {
  const event = new ICAL.Event(master)
  if (!event.isRecurring()) return toInstant(event.startDate, null) === recurrenceId
  const iterator = event.iterator()
  for (let step = 0; step < 50_000; step += 1) {
    const next = iterator.next()
    if (!next) return false
    const instant = toInstant(next, null)
    if (instant === recurrenceId) return true
    if (instant > recurrenceId) return false
  }
  // Too far out to tell: keep the occurrence rather than delete a Memry item.
  return true
}

/**
 * Patch a stored object with a Memry item's fields. With `recurrenceId`, the
 * change applies to one occurrence: its override is patched, or created from
 * the master when the object has none yet.
 */
export function patchICalendar(
  raw: string,
  event: UpsertRemoteEventInput,
  options: { recurrenceId?: string | null; now?: Date } = {}
): string {
  const now = options.now ?? new Date()
  const root = parseICalendar(raw)
  const master = masterOf(root)
  let target = master
  if (options.recurrenceId) {
    target =
      root
        .getAllSubcomponents('vevent')
        .find((vevent) => recurrenceIdMatches(vevent, options.recurrenceId as string)) ?? null
    if (!target) {
      if (!master) throw new Error('Cannot add an occurrence to an object without a master event')
      // A deep copy: ICAL.Component wraps the jCal array it is given, so
      // sharing it would edit the master too.
      target = new ICAL.Component(structuredClone(master.toJSON()) as unknown[])
      for (const name of ['rrule', 'exdate', 'rdate']) target.removeAllProperties(name)
      target.removeAllSubcomponents('valarm')
      target.addProperty(
        ICAL.Property.fromString(
          occurrenceLine('RECURRENCE-ID', root, master, options.recurrenceId)
        )
      )
      root.addSubcomponent(target)
    }
  }
  if (!target) throw new Error('The calendar object has no event to update')

  const ownsRecurrence = (master ?? target).hasProperty(MEMRY_SOURCE)
  applyOwnedFields(target, event, {
    ownsRecurrence,
    isOverride: Boolean(options.recurrenceId),
    now
  })
  ensureTimezone(root, event)
  return root.toString()
}

/** Remove one occurrence from a series: EXDATE on the master, override dropped. */
export function excludeOccurrence(
  raw: string,
  recurrenceId: string,
  now: Date = new Date()
): string {
  const root = parseICalendar(raw)
  const master = masterOf(root)
  if (!master) throw new Error('The calendar object has no series to exclude from')
  for (const override of root.getAllSubcomponents('vevent')) {
    if (recurrenceIdMatches(override, recurrenceId)) root.removeSubcomponent(override)
  }
  master.addProperty(ICAL.Property.fromString(occurrenceLine('EXDATE', root, master, recurrenceId)))
  const sequence = Number(master.getFirstPropertyValue('sequence') ?? 0)
  master.updatePropertyWithValue('sequence', Number.isFinite(sequence) ? sequence + 1 : 1)
  master.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(now, true))
  return root.toString()
}

function parseAttendees(vevent: ICAL.Component): CalendarAttendee[] | null {
  const organizer =
    textProp(vevent, 'organizer')
      ?.replace(/^mailto:/i, '')
      .toLowerCase() ?? null
  const statuses: Record<string, CalendarAttendee['responseStatus']> = {
    ACCEPTED: 'accepted',
    DECLINED: 'declined',
    TENTATIVE: 'tentative',
    'NEEDS-ACTION': 'needsAction'
  }
  const attendees = vevent.getAllProperties('attendee').flatMap((property) => {
    const value = property.getFirstValue()
    if (typeof value !== 'string') return []
    const email = value.replace(/^mailto:/i, '')
    const cn = property.getParameter('cn')
    const partstat = property.getParameter('partstat')
    const role = property.getParameter('role')
    return [
      {
        email,
        displayName: typeof cn === 'string' ? cn : null,
        responseStatus:
          typeof partstat === 'string' ? (statuses[partstat.toUpperCase()] ?? null) : null,
        optional: role === 'OPT-PARTICIPANT' ? true : null,
        organizer: organizer ? email.toLowerCase() === organizer : null,
        self: null
      } satisfies CalendarAttendee
    ]
  })
  return attendees.length > 0 ? attendees : null
}

function parseReminders(vevent: ICAL.Component): CalendarReminders | null {
  const overrides = vevent.getAllSubcomponents('valarm').flatMap((alarm) => {
    const trigger = alarm.getFirstPropertyValue('trigger')
    if (!(trigger instanceof ICAL.Duration)) return []
    return [
      { method: 'popup' as const, minutes: Math.max(0, Math.round(-trigger.toSeconds() / 60)) }
    ]
  })
  return overrides.length > 0 ? { useDefault: false, overrides } : null
}

function parseVisibility(vevent: ICAL.Component): CalendarVisibility | null {
  const value = textProp(vevent, 'class')?.toUpperCase()
  if (value === 'PUBLIC') return 'public'
  if (value === 'PRIVATE') return 'private'
  if (value === 'CONFIDENTIAL') return 'confidential'
  return null
}

/**
 * One event of a stored object in the shape the write engine reads: the
 * master, or with `recurrenceId` the occurrence (its override when there is
 * one). Used for write-back and conflict merges.
 */
export function icalToRemoteEvent(
  raw: string,
  input: {
    href: string
    calendarId: string
    etag: string | null
    remoteEventId: string
    recurrenceId?: string | null
  }
): RemoteCalendarEvent {
  const root = parseICalendar(raw)
  const master = masterOf(root)
  const override = input.recurrenceId
    ? root
        .getAllSubcomponents('vevent')
        .find((vevent) => recurrenceIdMatches(vevent, input.recurrenceId as string))
    : undefined
  const vevent = override ?? master ?? root.getFirstSubcomponent('vevent')
  if (!vevent) throw new Error('The calendar object has no event')

  const event = new ICAL.Event(vevent)
  let start = event.startDate
  let end: ICAL.Time | null = event.endDate ?? null
  if (input.recurrenceId && !override && master) {
    // An occurrence without an override keeps the master's time of day and length.
    const length = end ? end.subtractDate(start) : null
    const occurrence = ICAL.Time.fromJSDate(new Date(input.recurrenceId), true)
    if (start.zone && start.zone.tzid !== 'UTC') occurrence.zone = start.zone
    start = start.isDate ? ICAL.Time.fromDateString(input.recurrenceId.slice(0, 10)) : occurrence
    if (length) {
      end = start.clone()
      end.addDuration(length)
    }
  }
  const tzid = start.zone?.tzid
  const startAt = toInstant(start, null)
  const endAt = end ? toInstant(end, null) : null
  const occurrenceGone = Boolean(
    input.recurrenceId && !override && master && !seriesHasOccurrence(master, input.recurrenceId)
  )
  const status = occurrenceGone ? 'CANCELLED' : textProp(vevent, 'status')?.toUpperCase()
  const updated =
    vevent.getFirstPropertyValue('last-modified') ?? vevent.getFirstPropertyValue('dtstamp')
  const colorName = textProp(vevent, 'color')?.toLowerCase()

  return {
    id: input.remoteEventId,
    calendarId: input.calendarId,
    title: textProp(vevent, 'summary') ?? 'Untitled event',
    description: textProp(vevent, 'description'),
    location: textProp(vevent, 'location'),
    startAt,
    endAt: endAt && endAt > startAt ? endAt : null,
    isAllDay: start.isDate,
    timezone: start.isDate || !tzid || tzid === 'floating' || tzid === 'Z' ? 'UTC' : tzid,
    status:
      status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
    etag: input.etag,
    updatedAt: updated instanceof ICAL.Time ? toInstant(updated, null) : null,
    attendees: parseAttendees(vevent),
    reminders: parseReminders(vevent),
    visibility: parseVisibility(vevent),
    colorId: colorName ? (COLOR_ID_BY_NAME.get(colorName) ?? null) : null,
    conferenceData: null,
    recurringEventId: input.recurrenceId ? input.href : null,
    originalStartTime: input.recurrenceId ?? null,
    raw: { href: input.href, ical: raw, uid: eventUid(vevent) }
  }
}
