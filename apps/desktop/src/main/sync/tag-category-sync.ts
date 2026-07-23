import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface TagCategorySyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TagCategorySyncService | null = null

export function initTagCategorySyncService(deps: TagCategorySyncDeps): TagCategorySyncService {
  instance = new TagCategorySyncService(deps)
  return instance
}

export function getTagCategorySyncService(): TagCategorySyncService | null {
  return instance
}

export function resetTagCategorySyncService(): void {
  instance = null
}

export class TagCategorySyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: TagCategorySyncDeps) {
    this.controller = new RecordSyncController({
      type: 'tag_category',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db.select().from(tagCategories).where(eq(tagCategories.id, id)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(tagCategories)
          .set({ clock: newClock })
          .where(eq(tagCategories.id, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ itemId, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload) {
          return withIncrementedClock(snapshotPayload, deviceId)
        }

        // Categories soft-delete: the fallback must satisfy
        // TagCategorySyncPayloadSchema (name + sortOrder required) and carry
        // deletedAt, or a receiving device would resurrect the category
        // instead of tombstoning it.
        return JSON.stringify({
          name: itemId,
          sortOrder: 0,
          deletedAt: utcNow(),
          clock: incrementClock({}, deviceId)
        })
      }
    })
  }

  enqueueCreate(id: string): void {
    this.controller.enqueueCreate(id)
  }

  enqueueUpdate(id: string): void {
    this.controller.enqueueUpdate(id)
  }

  enqueueDelete(id: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(id, snapshotPayload)
  }
}
