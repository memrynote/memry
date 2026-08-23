import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'


interface BookmarkSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: BookmarkSyncService | null = null

export function initBookmarkSyncService(deps: BookmarkSyncDeps): BookmarkSyncService {
  instance = new BookmarkSyncService(deps)
  return instance
}

export function getBookmarkSyncService(): BookmarkSyncService | null {
  return instance
}

export function resetBookmarkSyncService(): void {
  instance = null
}

export class BookmarkSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: BookmarkSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'bookmark',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (bookmarkId) =>
        deps.db.select().from(bookmarks).where(eq(bookmarks.id, bookmarkId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(bookmarks).set({ clock: newClock }).where(eq(bookmarks.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(bookmarkId: string): void {
    this.controller.enqueueCreate(bookmarkId)
  }

  enqueueUpdate(bookmarkId: string): void {
    this.controller.enqueueUpdate(bookmarkId)
  }

  enqueueDelete(bookmarkId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(bookmarkId, snapshotPayload)
  }
}
