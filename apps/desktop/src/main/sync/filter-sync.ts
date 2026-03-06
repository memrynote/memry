import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { savedFilters } from '@memry/db-schema/schema/settings'
import type { VectorClock } from '@memry/contracts/sync-api'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { createLogger } from '../lib/logger'

type DrizzleDb = BetterSQLite3Database<typeof schema>

const log = createLogger('FilterSync')

interface FilterSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: FilterSyncService | null = null

export function initFilterSyncService(deps: FilterSyncDeps): FilterSyncService {
  instance = new FilterSyncService(deps)
  return instance
}

export function getFilterSyncService(): FilterSyncService | null {
  return instance
}

export function resetFilterSyncService(): void {
  instance = null
}

export class FilterSyncService {
  private queue: SyncQueueManager
  private db: DrizzleDb
  private getDeviceId: () => string | null

  constructor(deps: FilterSyncDeps) {
    this.queue = deps.queue
    this.db = deps.db
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(filterId: string): void {
    this.enqueue(filterId, 'create')
  }

  enqueueUpdate(filterId: string): void {
    this.enqueue(filterId, 'update')
  }

  enqueueDelete(filterId: string, snapshotPayload: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping filter sync enqueue for delete')
      return
    }

    try {
      const payload = this.withIncrementedClock(snapshotPayload, deviceId)
      this.queue.enqueue({
        type: 'filter',
        itemId: filterId,
        operation: 'delete',
        payload,
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue filter delete', err)
    }
  }

  private enqueue(filterId: string, operation: 'create' | 'update'): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID available, skipping filter sync enqueue')
      return
    }

    try {
      const filter = this.db.select().from(savedFilters).where(eq(savedFilters.id, filterId)).get()
      if (!filter) {
        log.warn('Filter not found for sync enqueue', { filterId })
        return
      }

      const existingClock = (filter.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      this.db
        .update(savedFilters)
        .set({ clock: newClock })
        .where(eq(savedFilters.id, filterId))
        .run()

      const payload = JSON.stringify({ ...filter, clock: newClock })

      this.queue.enqueue({
        type: 'filter',
        itemId: filterId,
        operation,
        payload,
        priority: 0
      })
    } catch (err) {
      log.error(`Failed to enqueue filter ${operation}`, err)
    }
  }

  private withIncrementedClock(payload: string, deviceId: string): string {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>
      const existingClock =
        parsed.clock && typeof parsed.clock === 'object' && !Array.isArray(parsed.clock)
          ? (parsed.clock as VectorClock)
          : {}
      const newClock = increment(existingClock, deviceId)
      return JSON.stringify({ ...parsed, clock: newClock })
    } catch {
      return payload
    }
  }
}
