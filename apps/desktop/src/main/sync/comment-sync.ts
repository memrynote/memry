import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { comments } from '@memry/db-schema/schema/comments'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface CommentSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CommentSyncService | null = null

export function initCommentSyncService(deps: CommentSyncDeps): CommentSyncService {
  instance = new CommentSyncService(deps)
  return instance
}

export function getCommentSyncService(): CommentSyncService | null {
  return instance
}

export function resetCommentSyncService(): void {
  instance = null
}

export class CommentSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: CommentSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'comment',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (commentId) =>
        deps.db.select().from(comments).where(eq(comments.id, commentId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const nextClock = incrementClock(existingClock, deviceId)

        deps.db.update(comments).set({ clock: nextClock }).where(eq(comments.id, itemId)).run()

        return { ...local, clock: nextClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ itemId, local, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload) return withIncrementedClock(snapshotPayload, deviceId)
        if (local) return withIncrementedClock(JSON.stringify(local), deviceId)
        return JSON.stringify({ id: itemId, clock: incrementClock({}, deviceId) })
      }
    })
  }

  enqueueCreate(commentId: string): void {
    this.controller.enqueueCreate(commentId)
  }

  enqueueUpdate(commentId: string): void {
    this.controller.enqueueUpdate(commentId)
  }

  enqueueDelete(commentId: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(commentId, snapshotPayload)
  }
}
