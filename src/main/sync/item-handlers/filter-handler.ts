import { eq, isNull } from 'drizzle-orm'
import { savedFilters } from '@shared/db/schema/settings'
import { FilterSyncPayloadSchema, type FilterSyncPayload } from '@shared/contracts/sync-payloads'
import { SavedFiltersChannels } from '@shared/ipc-channels'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('FilterHandler')

export const filterHandler: SyncItemHandler<FilterSyncPayload> = {
  type: 'filter',
  schema: FilterSyncPayloadSchema,

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: FilterSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    return ctx.db.transaction((tx): ApplyResult => {
      const existing = tx.select().from(savedFilters).where(eq(savedFilters.id, itemId)).get()
      const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
      const now = new Date().toISOString()

      if (existing) {
        const resolution = resolveClockConflict(existing.clock, remoteClock)
        if (resolution.action === 'skip') {
          log.info('Skipping remote filter update, local is newer', { itemId })
          return 'skipped'
        }
        if (resolution.action === 'merge') {
          log.warn('Concurrent filter edit, using last-write-wins', { itemId })
        }

        tx.update(savedFilters)
          .set({
            name: data.name ?? existing.name,
            config: data.config ?? existing.config,
            position: data.position ?? existing.position,
            clock: resolution.mergedClock,
            syncedAt: now
          })
          .where(eq(savedFilters.id, itemId))
          .run()

        ctx.emit(SavedFiltersChannels.events.UPDATED, { id: itemId })
        return resolution.action === 'merge' ? 'conflict' : 'applied'
      }

      tx.insert(savedFilters)
        .values({
          id: itemId,
          name: data.name ?? 'Untitled Filter',
          config: data.config ?? {},
          position: data.position ?? 0,
          clock: remoteClock,
          syncedAt: now,
          createdAt: data.createdAt ?? now
        })
        .run()

      ctx.emit(SavedFiltersChannels.events.CREATED, { id: itemId })
      return 'applied'
    })
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = ctx.db.select().from(savedFilters).where(eq(savedFilters.id, itemId)).get()
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote filter delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    ctx.db.delete(savedFilters).where(eq(savedFilters.id, itemId)).run()
    ctx.emit(SavedFiltersChannels.events.DELETED, { id: itemId })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    return db.select().from(savedFilters).where(eq(savedFilters.id, itemId)).get() as
      | Record<string, unknown>
      | undefined
  },

  buildPushPayload(db: DrizzleDb, itemId: string, _deviceId: string, _operation: string): string | null {
    const filter = db.select().from(savedFilters).where(eq(savedFilters.id, itemId)).get()
    if (!filter) return null
    return JSON.stringify(filter)
  },

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db.select().from(savedFilters).where(isNull(savedFilters.clock)).all()
    for (const item of items) {
      const clock = increment({}, deviceId)
      db.update(savedFilters).set({ clock }).where(eq(savedFilters.id, item.id)).run()
      queue.enqueue({
        type: 'filter',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({ ...item, clock }),
        priority: 0
      })
    }
    return items.length
  }
}
