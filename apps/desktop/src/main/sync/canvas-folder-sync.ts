import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { canvasFolders } from '@memry/db-schema/data-schema'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface CanvasFolderSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CanvasFolderSyncService | null = null

export function initCanvasFolderSyncService(deps: CanvasFolderSyncDeps): CanvasFolderSyncService {
  instance = new CanvasFolderSyncService(deps)
  return instance
}

export function getCanvasFolderSyncService(): CanvasFolderSyncService | null {
  return instance
}

export function resetCanvasFolderSyncService(): void {
  instance = null
}

/**
 * Local-mutation → sync-queue bridge for the `canvas_folder` record type.
 *
 * `load` is deliberately unfiltered: a delete needs the row it just tombstoned
 * to build its delete payload, and tombstones stay in the table.
 */
export class CanvasFolderSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: CanvasFolderSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'canvas_folder',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (folderId) =>
        deps.db.select().from(canvasFolders).where(eq(canvasFolders.id, folderId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(canvasFolders)
          .set({ clock: newClock })
          .where(eq(canvasFolders.id, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => ({
        id: local.id,
        vaultId: local.vaultId,
        path: local.path,
        icon: (local.icon as string | null) ?? null,
        clock: local.clock,
        deletedAt: (local.deletedAt as number | null) ?? null
      }),
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(folderId: string): void {
    this.controller.enqueueCreate(folderId)
  }

  enqueueUpdate(folderId: string): void {
    this.controller.enqueueUpdate(folderId)
  }

  enqueueDelete(folderId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(folderId, snapshotPayload)
  }
}
