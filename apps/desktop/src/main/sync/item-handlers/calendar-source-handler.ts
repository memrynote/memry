import { eq, isNull } from 'drizzle-orm'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { utcNow } from '@memry/shared/utc'
import {
  CalendarSourceSyncPayloadSchema,
  type CalendarSourceSyncPayload
} from '@memry/contracts/sync-payloads'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { ApplyContext, ApplyResult, DrizzleDb, SyncItemHandler } from './types'

const log = createLogger('CalendarSourceHandler')
const CALENDAR_CHANGED = 'calendar:changed'

export const calendarSourceHandler: SyncItemHandler<CalendarSourceSyncPayload> = {
  type: 'calendar_source',
  schema: CalendarSourceSyncPayloadSchema,

  applyUpsert(ctx: ApplyContext, itemId: string, data: CalendarSourceSyncPayload, clock: VectorClock): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(calendarSources).where(eq(calendarSources.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = utcNow()

      if (existing) {
        const resolution = resolveClockConflict(existing.clock as VectorClock | null, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote calendar source update, local is newer', { itemId })
          return 'skipped'
        }

        tx.update(calendarSources)
          .set({
            provider: data.provider ?? existing.provider,
            kind: data.kind ?? existing.kind,
            accountId: data.accountId ?? existing.accountId,
            remoteId: data.remoteId ?? existing.remoteId,
            title: data.title ?? existing.title,
            timezone: data.timezone ?? existing.timezone,
            color: data.color ?? existing.color,
            isPrimary: data.isPrimary ?? existing.isPrimary,
            isSelected: data.isSelected ?? existing.isSelected,
            isMemryManaged: data.isMemryManaged ?? existing.isMemryManaged,
            syncCursor: data.syncCursor ?? existing.syncCursor,
            syncStatus: data.syncStatus ?? existing.syncStatus,
            lastSyncedAt: data.lastSyncedAt ?? existing.lastSyncedAt,
            metadata: data.metadata ?? existing.metadata ?? null,
            archivedAt: data.archivedAt ?? existing.archivedAt,
            clock: resolution.mergedClock,
            modifiedAt: data.modifiedAt ?? now
          })
          .where(eq(calendarSources.id, itemId))
          .run()

        ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_source', id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(calendarSources)
        .values({
          id: itemId,
          provider: data.provider ?? 'google',
          kind: data.kind ?? 'calendar',
          accountId: data.accountId ?? null,
          remoteId: data.remoteId ?? itemId,
          title: data.title ?? 'Untitled calendar',
          timezone: data.timezone ?? null,
          color: data.color ?? null,
          isPrimary: data.isPrimary ?? false,
          isSelected: data.isSelected ?? false,
          isMemryManaged: data.isMemryManaged ?? false,
          syncCursor: data.syncCursor ?? null,
          syncStatus: data.syncStatus ?? 'idle',
          lastSyncedAt: data.lastSyncedAt ?? null,
          metadata: data.metadata ?? null,
          archivedAt: data.archivedAt ?? null,
          clock: remoteClock,
          createdAt: data.createdAt ?? now,
          modifiedAt: data.modifiedAt ?? now
        })
        .run()

      ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_source', id: itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(calendarSources).where(eq(calendarSources.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock as VectorClock | null, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote calendar source delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(calendarSources).where(eq(calendarSources.id, itemId)).run()
    ctx.emit(CALENDAR_CHANGED, { entityType: 'calendar_source', id: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(calendarSources).where(eq(calendarSources.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  },

  buildPushPayload(db: DrizzleDb, itemId: string): string | null {
    const row = db.select().from(calendarSources).where(eq(calendarSources.id, itemId)).get()
    if (!row) return null
    const payload: CalendarSourceSyncPayload = {
      provider: row.provider,
      kind: row.kind,
      accountId: row.accountId ?? null,
      remoteId: row.remoteId,
      title: row.title,
      timezone: row.timezone ?? null,
      color: row.color ?? null,
      isPrimary: row.isPrimary,
      isSelected: row.isSelected,
      isMemryManaged: row.isMemryManaged,
      syncCursor: row.syncCursor ?? null,
      syncStatus: row.syncStatus,
      lastSyncedAt: row.lastSyncedAt ?? null,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      archivedAt: row.archivedAt ?? null,
      clock: (row.clock as VectorClock) ?? undefined,
      createdAt: row.createdAt,
      modifiedAt: row.modifiedAt
    }
    return JSON.stringify(payload)
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(calendarSources).where(isNull(calendarSources.clock)).all()
    for (const item of items) {
      const nextClock = increment({}, deviceId)
      db.update(calendarSources).set({ clock: nextClock }).where(eq(calendarSources.id, item.id)).run()
      queue.enqueue({
        type: 'calendar_source',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock: nextClock }),
        priority: 0
      })
    }
    return items.length
  }
}
