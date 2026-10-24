import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { stickyDrafts } from '@memry/db-schema/schema/sticky-drafts'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import { clockFromColumn } from '@memry/sync-client/vector-clock'
import { recoverOfflineDocClock } from './offline-clock'
import type { SyncQueueManager } from './queue'

interface StickyDraftSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: StickyDraftSyncService | null = null

export function initStickyDraftSyncService(deps: StickyDraftSyncDeps): StickyDraftSyncService {
  instance = new StickyDraftSyncService(deps)
  return instance
}

export function getStickyDraftSyncService(): StickyDraftSyncService | null {
  return instance
}

export function resetStickyDraftSyncService(): void {
  instance = null
}

export class StickyDraftSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: StickyDraftSyncDeps) {
    const load = (draftId: string): Record<string, unknown> | undefined =>
      deps.db.select().from(stickyDrafts).where(eq(stickyDrafts.id, draftId)).get()

    this.controller = new RecordSyncController({
      type: 'sticky_draft',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = clockFromColumn(local.clock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(stickyDrafts)
          .set({ clock: newClock })
          .where(eq(stickyDrafts.id, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      recoverPendingChange: (draftId, deviceId) =>
        recoverOfflineDocClock(load(draftId), deviceId, (clock) =>
          deps.db.update(stickyDrafts).set({ clock }).where(eq(stickyDrafts.id, draftId)).run()
        ),
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(draftId: string): void {
    this.controller.enqueueCreate(draftId)
  }

  enqueueUpdate(draftId: string): void {
    this.controller.enqueueUpdate(draftId)
  }

  enqueueRecoveredUpdate(draftId: string): void {
    this.controller.enqueueRecoveredUpdate(draftId)
  }

  enqueueDelete(draftId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(draftId, snapshotPayload)
  }
}
