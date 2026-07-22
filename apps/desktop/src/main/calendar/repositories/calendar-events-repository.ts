import { and, asc, desc, eq, isNull, like, sql } from 'drizzle-orm'
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

  return db
    .select()
    .from(calendarEvents)
    .where(eq(calendarEvents.id, event.id))
    .get() as CalendarEvent
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

/**
 * Title search across every non-archived event, nearest to `now` first (#869).
 *
 * Two bounded queries rather than `ORDER BY abs(julianday(...))`: both sides
 * use the start_at index and neither depends on SQLite parsing all-day rows.
 * SQLite's LIKE is case-insensitive for ASCII, which is what the picker's old
 * client-side `toLowerCase().includes()` filter did.
 */
export function searchCalendarEventsByTitle(
  db: DataDb,
  options: { query: string; limit: number; now: string }
): CalendarEvent[] {
  const needle = options.query.trim()
  if (!needle) {
    return []
  }

  const matches = and(isNull(calendarEvents.archivedAt), like(calendarEvents.title, `%${needle}%`))

  const upcoming = db
    .select()
    .from(calendarEvents)
    .where(and(matches, sql`${calendarEvents.startAt} >= ${options.now}`))
    .orderBy(asc(calendarEvents.startAt))
    .limit(options.limit)
    .all()

  const past = db
    .select()
    .from(calendarEvents)
    .where(and(matches, sql`${calendarEvents.startAt} < ${options.now}`))
    .orderBy(desc(calendarEvents.startAt))
    .limit(options.limit)
    .all()

  const nowMs = Date.parse(options.now)
  const distance = (startAt: string): number => {
    const parsed = Date.parse(startAt)
    return Number.isNaN(parsed) ? Number.MAX_SAFE_INTEGER : Math.abs(parsed - nowMs)
  }

  return [...upcoming, ...past]
    .sort((a, b) => distance(a.startAt) - distance(b.startAt))
    .slice(0, options.limit)
}
