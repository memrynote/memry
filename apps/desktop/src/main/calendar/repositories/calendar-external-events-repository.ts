import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import {
  calendarExternalEvents,
  type CalendarExternalEvent,
  type NewCalendarExternalEvent
} from '@memry/db-schema/schema/calendar-external-events'
import type { DataDb } from '../../database/types'

export function upsertCalendarExternalEvent(
  db: DataDb,
  event: NewCalendarExternalEvent
): CalendarExternalEvent {
  const existing = db
    .select()
    .from(calendarExternalEvents)
    .where(eq(calendarExternalEvents.id, event.id))
    .get()

  if (existing) {
    db.update(calendarExternalEvents)
      .set(event)
      .where(eq(calendarExternalEvents.id, event.id))
      .run()
  } else {
    db.insert(calendarExternalEvents).values(event).run()
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- get() on the row this function just wrote cannot be undefined
  return db
    .select()
    .from(calendarExternalEvents)
    .where(eq(calendarExternalEvents.id, event.id))
    .get() as CalendarExternalEvent
}

export function getCalendarExternalEventById(
  db: DataDb,
  id: string
): CalendarExternalEvent | undefined {
  return db.select().from(calendarExternalEvents).where(eq(calendarExternalEvents.id, id)).get()
}

/**
 * Mirrored events on visible calendars whose title contains `query`, nearest
 * to `now` first. A promoted mirror is archived, so its native event is the
 * only hit for it.
 */
export function searchCalendarExternalEventsByTitle(
  db: DataDb,
  options: { query: string; limit: number; now: string }
): CalendarExternalEvent[] {
  const needle = options.query.trim()
  if (!needle) return []
  return db
    .select({ event: calendarExternalEvents })
    .from(calendarExternalEvents)
    .innerJoin(calendarSources, eq(calendarSources.id, calendarExternalEvents.sourceId))
    .where(
      and(
        isNull(calendarExternalEvents.archivedAt),
        eq(calendarSources.isSelected, true),
        sql`ulower(${calendarExternalEvents.title}) LIKE ulower(${`%${needle}%`})`
      )
    )
    .orderBy(sql`abs(julianday(${calendarExternalEvents.startAt}) - julianday(${options.now}))`)
    .limit(options.limit)
    .all()
    .map((row) => row.event)
}

export function listCalendarExternalEventsBySource(
  db: DataDb,
  sourceId: string
): CalendarExternalEvent[] {
  return db
    .select()
    .from(calendarExternalEvents)
    .where(
      and(eq(calendarExternalEvents.sourceId, sourceId), isNull(calendarExternalEvents.archivedAt))
    )
    .orderBy(asc(calendarExternalEvents.startAt))
    .all()
}
