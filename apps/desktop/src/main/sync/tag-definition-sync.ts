import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface TagDefinitionSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TagDefinitionSyncService | null = null

export function initTagDefinitionSyncService(
  deps: TagDefinitionSyncDeps
): TagDefinitionSyncService {
  instance = new TagDefinitionSyncService(deps)
  return instance
}

export function getTagDefinitionSyncService(): TagDefinitionSyncService | null {
  return instance
}

export function resetTagDefinitionSyncService(): void {
  instance = null
}

export class TagDefinitionSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: TagDefinitionSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'tag_definition',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (name) =>
        deps.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, name)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(tagDefinitions)
          .set({ clock: newClock })
          .where(eq(tagDefinitions.name, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ itemId, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload) {
          return withIncrementedClock(snapshotPayload, deviceId)
        }

        return JSON.stringify({ name: itemId, color: '', clock: incrementClock({}, deviceId) })
      }
    })
  }

  enqueueCreate(name: string): void {
    this.controller.enqueueCreate(name)
  }

  enqueueUpdate(name: string): void {
    this.controller.enqueueUpdate(name)
  }

  enqueueDelete(name: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(name, snapshotPayload)
  }
}
