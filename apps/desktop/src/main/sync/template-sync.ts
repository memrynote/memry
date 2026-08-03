import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import type * as schema from '@memry/db-schema/data-schema'
import { templates } from '@memry/db-schema/schema/templates'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

type DrizzleDb = BetterSQLite3Database<typeof schema>

interface TemplateSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TemplateSyncService | null = null

export function initTemplateSyncService(deps: TemplateSyncDeps): TemplateSyncService {
  instance = new TemplateSyncService(deps)
  return instance
}

export function getTemplateSyncService(): TemplateSyncService | null {
  return instance
}

export function resetTemplateSyncService(): void {
  instance = null
}

export class TemplateSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: TemplateSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'template',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (templateId) =>
        deps.db.select().from(templates).where(eq(templates.id, templateId)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db.update(templates).set({ clock: newClock }).where(eq(templates.id, itemId)).run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(templateId: string): void {
    this.controller.enqueueCreate(templateId)
  }

  enqueueUpdate(templateId: string): void {
    this.controller.enqueueUpdate(templateId)
  }

  enqueueDelete(templateId: string, snapshotPayload: string): void {
    this.controller.enqueueDelete(templateId, snapshotPayload)
  }
}
