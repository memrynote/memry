import { and, asc, eq, isNull } from 'drizzle-orm'
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

export function listCalendarExternalEventsBySource(
  db: DataDb,
  sourceId: string
): CalendarExternalEvent[] {
  return db
    .select()
    .from(calendarExternalEvents)
    .where(and(eq(calendarExternalEvents.sourceId, sourceId), isNull(calendarExternalEvents.archivedAt)))
    .orderBy(asc(calendarExternalEvents.startAt))
    .all()
}
