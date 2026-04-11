import { eq, isNull, asc } from 'drizzle-orm'
import {
  calendarEvents,
  type CalendarEvent,
  type NewCalendarEvent
} from '@memry/db-schema/schema/calendar-events'
import type { DataDb } from '../../database/types'

export function upsertCalendarEvent(db: DataDb, event: NewCalendarEvent): CalendarEvent {
  const existing = db.select().from(calendarEvents).where(eq(calendarEvents.id, event.id)).get()

  if (existing) {
    db.update(calendarEvents).set(event).where(eq(calendarEvents.id, event.id)).run()
  } else {
    db.insert(calendarEvents).values(event).run()
  }

  return db.select().from(calendarEvents).where(eq(calendarEvents.id, event.id)).get() as CalendarEvent
}

export function getCalendarEventById(db: DataDb, id: string): CalendarEvent | undefined {
  return db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).get()
}

export function listActiveCalendarEvents(db: DataDb): CalendarEvent[] {
  return db
    .select()
    .from(calendarEvents)
    .where(isNull(calendarEvents.archivedAt))
    .orderBy(asc(calendarEvents.startAt))
    .all()
}

export function archiveCalendarEvent(db: DataDb, id: string, archivedAt: string): boolean {
  const result = db
    .update(calendarEvents)
    .set({ archivedAt, modifiedAt: archivedAt })
    .where(eq(calendarEvents.id, id))
    .run()

  return result.changes > 0
}
