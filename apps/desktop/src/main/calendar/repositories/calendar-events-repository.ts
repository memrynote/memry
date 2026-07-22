import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
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
 *
 * Matching goes through `ulower()` (registered in database/sqlite-functions.ts),
 * not bare `LIKE`. SQLite's LIKE folds case for ASCII only, so a plain
 * `LIKE '%ödeme%'` would miss "Ödeme Toplantısı", `münchen` would miss
 * "MÜNCHEN Trip", and `лекция` would miss "ЛЕКЦИЯ". `ulower()` is JavaScript's
 * `toLowerCase`, which folds the full Unicode range — the same folding the
 * picker's old client-side `toLowerCase().includes()` filter did. One gap
 * carries over unchanged: `toLowerCase` maps the Turkish dotted İ to `i` plus
 * a combining dot above rather than plain `i`, so `istanbul` will not match
 * "İstanbul" — matching the old filter's behavior exactly, not a regression.
 *
 * The cost is a full scan of non-archived rows for the match predicate: the
 * function is opaque to any index on title. That index does not exist and LIKE
 * with a leading wildcard could not have used it anyway, so nothing regresses.
 */
export function searchCalendarEventsByTitle(
  db: DataDb,
  options: { query: string; limit: number; now: string }
): CalendarEvent[] {
  const needle = options.query.trim()
  if (!needle) {
    return []
  }

  const matches = and(
    isNull(calendarEvents.archivedAt),
    sql`ulower(${calendarEvents.title}) LIKE ulower(${`%${needle}%`})`
  )

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
