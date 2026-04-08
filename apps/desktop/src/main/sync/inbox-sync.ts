import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface InboxSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: InboxSyncService | null = null

export function initInboxSyncService(deps: InboxSyncDeps): InboxSyncService {
  instance = new InboxSyncService(deps)
  return instance
}

export function getInboxSyncService(): InboxSyncService | null {
  return instance
}

export function resetInboxSyncService(): void {
  instance = null
}

export class InboxSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: InboxSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'inbox',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (itemId) =>
        deps.db.select().from(inboxItems).where(eq(inboxItems.id, itemId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(inboxItems).set({ clock: newClock }).where(eq(inboxItems.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      shouldSkip: (local) => Boolean(local.localOnly),
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(itemId: string): void {
    this.controller.enqueueCreate(itemId)
  }

  enqueueUpdate(itemId: string): void {
    this.controller.enqueueUpdate(itemId)
  }

  enqueueDelete(itemId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(itemId, snapshotPayload)
  }
}
