import { and, eq, like, or } from 'drizzle-orm'
import {
  calendarExternalEvents,
  type CalendarExternalEvent,
  type NewCalendarExternalEvent
} from '@memry/db-schema/schema/calendar-external-events'
import type { CalendarSource } from '@memry/db-schema/schema/calendar-sources'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { increment } from '@memry/sync-client/vector-clock'
import type { DataDb } from '../../database'
import { createLogger } from '../../lib/logger'
import { emitCalendarChanged } from '../change-events'
import {
  ICalParseError,
  expandCalendarEvents,
  parseICalendar,
  type ICalEventInstance,
  type ICalExpansionWindow
} from '../ical/ical-events'
import {
  syncCalendarExternalEventCreate,
  syncCalendarExternalEventDelete,
  syncCalendarExternalEventUpdate
} from '../runtime-effects'
import type { CaldavObject } from './caldav-client'

const log = createLogger('Calendar:CaldavMirror')

/**
 * The CalDAV mirror (#1399). One CalDAV object (an `href`) holds a master
 * event and its overrides; its instances are keyed `<href>` for a single
 * event and `<href>::<recurrence-id>` inside a series, so a changed or
 * removed object replaces or removes exactly its own instances.
 *
 * The mirror is synced (`mirrorScope: 'synced'`), so every row gets a vector
 * clock and every change is enqueued, exactly like the Google mirror.
 */

/** What each mirrored row keeps of its object, for write-back (#1400). */
export interface CaldavRawPayload {
  href: string
  etag: string | null
  /** The whole object, on one row per object (its first instance). */
  ical?: string
}

export function instanceKeyFor(href: string): (uid: string, recurrenceId: string | null) => string {
  return (_uid, recurrenceId) => (recurrenceId ? `${href}::${recurrenceId}` : href)
}

/** `<href>` or `<href>::<recurrence-id>` → `<href>`. */
export function hrefOfRemoteEventId(remoteEventId: string): string {
  const separator = remoteEventId.indexOf('::')
  return separator === -1 ? remoteEventId : remoteEventId.slice(0, separator)
}

function externalEventId(sourceId: string, remoteEventId: string): string {
  return `calendar_external_event:${sourceId}:${remoteEventId}`
}

export function expandObject(
  object: CaldavObject,
  window: ICalExpansionWindow
): ICalEventInstance[] | null {
  try {
    return expandCalendarEvents(parseICalendar(object.data), window, {
      keyFor: instanceKeyFor(object.href)
    })
  } catch (error) {
    if (!(error instanceof ICalParseError)) {
      log.warn('Could not expand a CalDAV object', { error })
    }
    // A malformed object must not stop the rest of the calendar from syncing.
    return null
  }
}

export function listObjectRows(
  db: DataDb,
  sourceId: string,
  href: string
): CalendarExternalEvent[] {
  return db
    .select()
    .from(calendarExternalEvents)
    .where(
      and(
        eq(calendarExternalEvents.sourceId, sourceId),
        or(
          eq(calendarExternalEvents.remoteEventId, href),
          // `%` and `_` in an href widen the match; the exact filter below narrows it back.
          like(calendarExternalEvents.remoteEventId, `${href}::%`)
        )
      )
    )
    .all()
    .filter((row) => hrefOfRemoteEventId(row.remoteEventId) === href)
}

export function listSourceRows(db: DataDb, sourceId: string): CalendarExternalEvent[] {
  return db
    .select()
    .from(calendarExternalEvents)
    .where(eq(calendarExternalEvents.sourceId, sourceId))
    .all()
}

/** The ETag this device last stored for each object, from the mirror. */
export function knownObjectEtags(db: DataDb, sourceId: string): Map<string, string | null> {
  const etags = new Map<string, string | null>()
  for (const row of listSourceRows(db, sourceId)) {
    const href = hrefOfRemoteEventId(row.remoteEventId)
    if (!etags.has(href)) etags.set(href, row.remoteEtag ?? null)
  }
  return etags
}

function sameContent(row: CalendarExternalEvent, next: NewCalendarExternalEvent): boolean {
  return (
    !row.archivedAt &&
    row.title === next.title &&
    (row.description ?? null) === (next.description ?? null) &&
    (row.location ?? null) === (next.location ?? null) &&
    row.startAt === next.startAt &&
    (row.endAt ?? null) === (next.endAt ?? null) &&
    (row.timezone ?? null) === (next.timezone ?? null) &&
    row.isAllDay === next.isAllDay &&
    row.status === next.status &&
    (row.remoteEtag ?? null) === (next.remoteEtag ?? null) &&
    JSON.stringify(row.rawPayload ?? null) === JSON.stringify(next.rawPayload ?? null)
  )
}

function deleteRows(db: DataDb, rows: CalendarExternalEvent[]): number {
  for (const row of rows) {
    db.delete(calendarExternalEvents).where(eq(calendarExternalEvents.id, row.id)).run()
    syncCalendarExternalEventDelete(row.id, JSON.stringify(row))
    emitCalendarChanged({ entityType: 'calendar_external_event', id: row.id })
  }
  return rows.length
}

/**
 * Make one object's rows equal its instances: update what changed, add what
 * is new, remove what the object no longer has. Returns the number of rows
 * written or removed.
 */
export function replaceObjectInstances(
  db: DataDb,
  source: CalendarSource,
  object: CaldavObject,
  instances: ICalEventInstance[],
  nowIso: string
): number {
  const existing = new Map(listObjectRows(db, source.id, object.href).map((row) => [row.id, row]))
  const deviceId = getCurrentDeviceId(db)
  const ordered = [...instances].sort((left, right) => left.startAt.localeCompare(right.startAt))
  const seen = new Set<string>()
  let changed = 0

  ordered.forEach((instance, index) => {
    const id = externalEventId(source.id, instance.remoteEventId)
    if (seen.has(id)) return
    seen.add(id)
    const previous = existing.get(id)
    const rawPayload: CaldavRawPayload = {
      href: object.href,
      etag: object.etag,
      ...(index === 0 ? { ical: object.data } : {})
    }
    const row: NewCalendarExternalEvent = {
      id,
      sourceId: source.id,
      remoteEventId: instance.remoteEventId,
      remoteEtag: object.etag,
      remoteUpdatedAt: instance.remoteUpdatedAt,
      title: instance.title,
      description: instance.description,
      location: instance.location,
      startAt: instance.startAt,
      endAt: instance.endAt,
      timezone: instance.timezone,
      isAllDay: instance.isAllDay,
      status: instance.status,
      recurrenceRule: null,
      attendees: null,
      reminders: null,
      visibility: null,
      colorId: null,
      conferenceData: null,
      rawPayload: rawPayload as unknown as Record<string, unknown>,
      archivedAt: null,
      // Same first clock `seedUnclocked` would assign: a clock-less row fails
      // the whole push batch (#1215).
      clock: previous?.clock ?? (deviceId ? increment({}, deviceId) : undefined),
      createdAt: previous?.createdAt ?? nowIso,
      modifiedAt: nowIso
    }
    if (previous && sameContent(previous, row)) return

    db.insert(calendarExternalEvents)
      .values(row)
      .onConflictDoUpdate({ target: calendarExternalEvents.id, set: row })
      .run()
    if (previous) syncCalendarExternalEventUpdate(id)
    else syncCalendarExternalEventCreate(id)
    emitCalendarChanged({ entityType: 'calendar_external_event', id })
    changed += 1
  })

  const removed = [...existing.values()].filter((row) => !seen.has(row.id))
  return changed + deleteRows(db, removed)
}

/** An object deleted on the server: remove exactly its instances. */
export function removeObjectInstances(db: DataDb, sourceId: string, href: string): number {
  return deleteRows(db, listObjectRows(db, sourceId, href))
}

/**
 * After a full pull, drop rows of objects the server no longer returned.
 * Rows that ended before the window are history the time-range query
 * cannot see, so they stay, as they do for ICS.
 */
export function removeUnseenObjects(
  db: DataDb,
  sourceId: string,
  seenHrefs: Set<string>,
  window: ICalExpansionWindow
): number {
  const stale = listSourceRows(db, sourceId).filter(
    (row) =>
      !seenHrefs.has(hrefOfRemoteEventId(row.remoteEventId)) &&
      (row.endAt ?? row.startAt) >= window.startAt
  )
  return deleteRows(db, stale)
}
