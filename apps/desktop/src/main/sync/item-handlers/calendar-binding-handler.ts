import { eq, isNull } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { utcNow } from '@memry/shared/utc'
import {
  CalendarBindingSyncPayloadSchema,
  type CalendarBindingSyncPayload
} from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from './base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('CalendarBindingHandler')
const CALENDAR_CHANGED = 'calendar:changed'

class CalendarBindingHandler extends BaseItemHandler<CalendarBindingSyncPayload> {
  readonly type = 'calendar_binding' as const
  readonly schema = CalendarBindingSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: CalendarBindingSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx
        .select()
        .from(calendarBindings)
        .where(eq(calendarBindings.id, itemId))
        .get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = this.resolveClock(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote calendar binding update, local is newer', { itemId })
          return 'skipped'
        }

        tx.update(calendarBindings)
          .set({
            sourceType: data.sourceType ?? existing.sourceType,
            sourceId: data.sourceId ?? existing.sourceId,
            provider: data.provider ?? existing.provider,
            remoteCalendarId: data.remoteCalendarId ?? existing.remoteCalendarId,
            remoteEventId: data.remoteEventId ?? existing.remoteEventId,
            ownershipMode: data.ownershipMode ?? existing.ownershipMode,
            writebackMode: data.writebackMode ?? existing.writebackMode,
            remoteVersion: data.remoteVersion ?? existing.remoteVersion,
            lastLocalSnapshot: data.lastLocalSnapshot ?? existing.lastLocalSnapshot ?? null,
            archivedAt: data.archivedAt ?? existing.archivedAt,
            clock: resolution.mergedClock,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(calendarBindings.id, itemId))
          .run()

        ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_binding', id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(calendarBindings)
        .values({
          id: itemId,
          sourceType: data.sourceType ?? 'event',
          sourceId: data.sourceId ?? itemId,
          provider: data.provider ?? 'google',
          remoteCalendarId: data.remoteCalendarId ?? 'primary',
          remoteEventId: data.remoteEventId ?? itemId,
          ownershipMode: data.ownershipMode ?? 'memry_managed',
          writebackMode: data.writebackMode ?? 'broad',
          remoteVersion: data.remoteVersion ?? null,
          lastLocalSnapshot: data.lastLocalSnapshot ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_binding', id: itemId })
      return 'applied'
    })
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.id, itemId))
      .get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveClock(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote calendar binding delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(calendarBindings).where(eq(calendarBindings.id, itemId)).run()
    ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_binding', id: itemId })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(calendarBindings).where(eq(calendarBindings.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  }

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(calendarBindings).where(eq(calendarBindings.id, itemId)).get()
    if (!row) return null
    const payload: CalendarBindingSyncPayload = {
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      provider: row.provider,
      remoteCalendarId: row.remoteCalendarId,
      remoteEventId: row.remoteEventId,
      ownershipMode: row.ownershipMode,
      writebackMode: row.writebackMode,
      remoteVersion: row.remoteVersion ?? null,
      lastLocalSnapshot: (row.lastLocalSnapshot as Record<string, unknown> | null) ?? null,
      archivedAt: row.archivedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(calendarBindings).where(isNull(calendarBindings.clock)).all()
    for (const item of items) {
      const nextClock = increment({}, deviceId)
      db.update(calendarBindings)
        .set({ clock: nextClock })
        .where(eq(calendarBindings.id, item.id))
        .run()
      queue.enqueue({
        type: 'calendar_binding',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock: nextClock }),
        priority: 0
      })
    }
    return items.length
  }
}

export const calendarBindingHandler = new CalendarBindingHandler()
