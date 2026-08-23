import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { homePages } from '@memry/db-schema/schema/home-pages'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
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
    this.controller = new RecordSyncController({
      type: 'home_page',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (boardId) =>
        deps.db.select().from(homePages).where(eq(homePages.id, boardId)).get() as
          Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(homePages).set({ clock: newClock }).where(eq(homePages.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(boardId: string): void {
    this.controller.enqueueCreate(boardId)
  }

  enqueueUpdate(boardId: string): void {
    this.controller.enqueueUpdate(boardId)
  }

  enqueueDelete(boardId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(boardId, snapshotPayload)
  }
}
