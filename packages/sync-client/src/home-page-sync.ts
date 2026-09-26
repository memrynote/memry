import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import { recoverOfflineDocClock } from './offline-clock'
import type { SyncQueueManager } from './queue'

interface HomePageSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: HomePageSyncService | null = null

export function initHomePageSyncService(deps: HomePageSyncDeps): HomePageSyncService {
  instance = new HomePageSyncService(deps)
  return instance
}

export function getHomePageSyncService(): HomePageSyncService | null {
  return instance
}

export function resetHomePageSyncService(): void {
  instance = null
}

export class HomePageSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: HomePageSyncDeps) {
    const load = (boardId: string): Record<string, unknown> | undefined =>
      deps.db.select().from(homePages).where(eq(homePages.id, boardId)).get() as
        Record<string, unknown> | undefined

    this.controller = new RecordSyncController({
      type: 'home_page',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(homePages).set({ clock: newClock }).where(eq(homePages.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      recoverPendingChange: (boardId, deviceId) =>
        recoverOfflineDocClock(load(boardId), deviceId, (clock) =>
          deps.db.update(homePages).set({ clock }).where(eq(homePages.id, boardId)).run()
        ),
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(boardId: string): void {
    this.controller.enqueueCreate(boardId)
  }

  enqueueUpdate(boardId: string): void {
    this.controller.enqueueUpdate(boardId)
  }

  enqueueRecoveredUpdate(boardId: string): void {
    this.controller.enqueueRecoveredUpdate(boardId)
  }

  enqueueDelete(boardId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(boardId, snapshotPayload)
  }
}
