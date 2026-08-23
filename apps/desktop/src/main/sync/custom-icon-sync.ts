import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { customIcons } from '@memry/db-schema/schema/custom-icons'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'


interface CustomIconSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CustomIconSyncService | null = null

export function initCustomIconSyncService(deps: CustomIconSyncDeps): CustomIconSyncService {
  instance = new CustomIconSyncService(deps)
  return instance
}

export function getCustomIconSyncService(): CustomIconSyncService | null {
  return instance
}

export function resetCustomIconSyncService(): void {
  instance = null
}

export class CustomIconSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: CustomIconSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'custom_icon',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (iconId) =>
        deps.db.select().from(customIcons).where(eq(customIcons.id, iconId)).get() as
          Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(customIcons).set({ clock: newClock }).where(eq(customIcons.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(iconId: string): void {
    this.controller.enqueueCreate(iconId)
  }

  enqueueUpdate(iconId: string): void {
    this.controller.enqueueUpdate(iconId)
  }

  enqueueDelete(iconId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(iconId, snapshotPayload)
  }
}
