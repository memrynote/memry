import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface FolderConfigSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: FolderConfigSyncService | null = null

export function initFolderConfigSyncService(deps: FolderConfigSyncDeps): FolderConfigSyncService {
  instance = new FolderConfigSyncService(deps)
  return instance
}

export function getFolderConfigSyncService(): FolderConfigSyncService | null {
  return instance
}

export function resetFolderConfigSyncService(): void {
  instance = null
}

export class FolderConfigSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: FolderConfigSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'folder_config',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (path) =>
        deps.db.select().from(folderConfigs).where(eq(folderConfigs.path, path)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(folderConfigs)
          .set({ clock: newClock })
          .where(eq(folderConfigs.path, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ itemId, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload) {
          return withIncrementedClock(snapshotPayload, deviceId)
        }

        return JSON.stringify({ path: itemId, icon: null, clock: incrementClock({}, deviceId) })
      }
    })
  }

  enqueueCreate(path: string): void {
    this.controller.enqueueCreate(path)
  }

  enqueueUpdate(path: string): void {
    this.controller.enqueueUpdate(path)
  }

  enqueueDelete(path: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(path, snapshotPayload)
  }
}
