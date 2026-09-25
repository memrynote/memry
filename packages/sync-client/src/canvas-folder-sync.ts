import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { canvasFolders } from '@memry/db-schema/data-schema'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, withIncrementedClock } from '@memry/sync-core'
import { recoverOfflineDocClock } from './offline-clock'
import type { SyncQueueManager } from './queue'
import { nextLocalClock } from './tombstone-clocks'

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
    const load = (folderId: string): Record<string, unknown> | undefined =>
      deps.db.select().from(canvasFolders).where(eq(canvasFolders.id, folderId)).get() as
        Record<string, unknown> | undefined
    const serialize = (local: Record<string, unknown>): Record<string, unknown> => ({
      id: local.id,
      vaultId: local.vaultId,
      path: local.path,
      icon: (local.icon as string | null) ?? null,
      clock: local.clock,
      deletedAt: (local.deletedAt as number | null) ?? null
    })

    this.controller = new RecordSyncController({
      type: 'canvas_folder',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load,
      applyLocalChange: ({ itemId, local, deviceId, operation }) => {
        const newClock = nextLocalClock(
          deps.db,
          'canvas_folder',
          itemId,
          local.clock as VectorClock | null,
          deviceId,
          operation
        )

        deps.db
          .update(canvasFolders)
          .set({ clock: newClock })
          .where(eq(canvasFolders.id, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize,
      recoverPendingChange: (folderId, deviceId) =>
        recoverOfflineDocClock(load(folderId), deviceId, (clock) =>
          deps.db.update(canvasFolders).set({ clock }).where(eq(canvasFolders.id, folderId)).run()
        ),
      serializeRecovered: serialize,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(folderId: string): void {
    this.controller.enqueueCreate(folderId)
  }

  enqueueUpdate(folderId: string): void {
    this.controller.enqueueUpdate(folderId)
  }

  enqueueRecoveredUpdate(folderId: string): void {
    this.controller.enqueueRecoveredUpdate(folderId)
  }

  enqueueDelete(folderId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(folderId, snapshotPayload)
  }
}
