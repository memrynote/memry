import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'

interface PropertyDefinitionSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: PropertyDefinitionSyncService | null = null

export function initPropertyDefinitionSyncService(
  deps: PropertyDefinitionSyncDeps
): PropertyDefinitionSyncService {
  instance = new PropertyDefinitionSyncService(deps)
  return instance
}

export function getPropertyDefinitionSyncService(): PropertyDefinitionSyncService | null {
  return instance
}

export function resetPropertyDefinitionSyncService(): void {
  instance = null
}

/**
 * The vault's property definitions, as a synced record type.
 *
 * The item id is the definition NAME — `property_definitions.name` is the
 * table's primary key, the same shape `tag_definition` uses.
 */
export class PropertyDefinitionSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string]>

  constructor(deps: PropertyDefinitionSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'property_definition',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (name) =>
        deps.db
          .select()
          .from(propertyDefinitions)
          .where(eq(propertyDefinitions.name, name))
          .get() as Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)

        deps.db
          .update(propertyDefinitions)
          .set({ clock: newClock })
          .where(eq(propertyDefinitions.name, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      serialize: (local) => local,
      buildDeletePayload: ({ extra, deviceId }) => withIncrementedClock(extra[0], deviceId)
    })
  }

  enqueueCreate(name: string): void {
    this.controller.enqueueCreate(name)
  }

  enqueueUpdate(name: string): void {
    this.controller.enqueueUpdate(name)
  }

  enqueueDelete(name: string, payload: string): void {
    this.controller.enqueueDelete(name, payload)
  }
}
