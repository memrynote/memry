import { eq, isNull } from 'drizzle-orm'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { utcNow } from '@memry/shared/utc'
import {
  CalendarEventSyncPayloadSchema,
  type CalendarEventSyncPayload
} from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { ApplyContext, ApplyResult, DrizzleDb, SyncItemHandler } from './types'

const log = createLogger('CalendarEventHandler')
const CALENDAR_CHANGED = 'calendar:changed'

export const calendarEventHandler: SyncItemHandler<CalendarEventSyncPayload> = {
  type: 'calendar_event',
  schema: CalendarEventSyncPayloadSchema,

  applyUpsert(ctx: ApplyContext, itemId: string, data: CalendarEventSyncPayload, clock: VectorClock): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = resolveClockConflict(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote calendar event update, local is newer', { itemId })
          return 'skipped'
        }

        tx.update(calendarEvents)
          .set({
            title: data.title ?? existing.title,
            description: data.description ?? existing.description,
            location: data.location ?? existing.location,
            startAt: data.startAt ?? existing.startAt,
            endAt: data.endAt ?? existing.endAt,
            timezone: data.timezone ?? existing.timezone,
            isAllDay: data.isAllDay ?? existing.isAllDay,
            recurrenceRule: data.recurrenceRule ?? existing.recurrenceRule ?? null,
            recurrenceExceptions: data.recurrenceExceptions ?? existing.recurrenceExceptions ?? null,
            archivedAt: data.archivedAt ?? existing.archivedAt,
            clock: resolution.mergedClock,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(calendarEvents.id, itemId))
          .run()

        ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_event', id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(calendarEvents)
        .values({
          id: itemId,
          title: data.title ?? 'Untitled event',
          description: data.description ?? null,
          location: data.location ?? null,
          startAt: data.startAt ?? now,
          endAt: data.endAt ?? null,
          timezone: data.timezone ?? 'UTC',
          isAllDay: data.isAllDay ?? false,
          recurrenceRule: data.recurrenceRule ?? null,
          recurrenceExceptions: data.recurrenceExceptions ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_event', id: itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote calendar event delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(calendarEvents).where(eq(calendarEvents.id, itemId)).run()
    ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_event', id: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  },

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(calendarEvents).where(eq(calendarEvents.id, itemId)).get()
    if (!row) return null
    const payload: CalendarEventSyncPayload = {
      title: row.title,
      description: row.description ?? null,
      location: row.location ?? null,
      startAt: row.startAt,
      endAt: row.endAt ?? null,
      timezone: row.timezone,
      isAllDay: row.isAllDay,
      recurrenceRule: (row.recurrenceRule as Record<string, unknown> | null) ?? null,
      recurrenceExceptions:
        (row.recurrenceExceptions as Array<Record<string, unknown>> | null) ?? null,
      archivedAt: row.archivedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(calendarEvents).where(isNull(calendarEvents.clock)).all()
    for (const item of items) {
      const nextClock = increment({}, deviceId)
      db.update(calendarEvents).set({ clock: nextClock }).where(eq(calendarEvents.id, item.id)).run()
      queue.enqueue({
        type: 'calendar_event',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock: nextClock }),
        priority: 0
      })
    }
    return items.length
  }
}
