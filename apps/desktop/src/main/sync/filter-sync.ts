import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { savedFilters } from '@memry/db-schema/schema/settings'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

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
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: FilterSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'filter',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (filterId) =>
        deps.db.select().from(savedFilters).where(eq(savedFilters.id, filterId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(savedFilters)
          .set({ clock: newClock })
          .where(eq(savedFilters.id, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(filterId: string): void {
    this.controller.enqueueCreate(filterId)
  }

  enqueueUpdate(filterId: string): void {
    this.controller.enqueueUpdate(filterId)
  }

  enqueueDelete(filterId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(filterId, snapshotPayload)
  }
}
