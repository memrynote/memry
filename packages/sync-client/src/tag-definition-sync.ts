import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import type { VectorClock } from '@memry/contracts/sync-api'
import { readVersionedObject } from '@memry/shared/versioned'
import { RecordSyncController, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'
import { recoverOfflineDocClock } from './offline-clock'
import { deleteFromLocalRow } from './delete-fallback'
import { nextLocalClock } from './tombstone-clocks'

interface TagDefinitionSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TagDefinitionSyncService | null = null

const JSON_TEXT_KEYS: Record<string, (value: unknown) => boolean> = {
  views: Array.isArray,
  schema: (value) => readVersionedObject(value) !== undefined
}

function parseJsonText(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/**
 * Normalise a raw `tag_definitions` row into something
 * `TagDefinitionSyncPayloadSchema` accepts.
 *
 * The push coordinator normally rebuilds this payload via
 * `tagDefinitionHandler.buildPushPayload`, so the frozen queue payload only
 * escapes on the fallback path — reached when the row is gone locally by flush
 * time, e.g. a remote delete hard-deletes it while a local update is still
 * queued. Normalising here makes both paths agree.
 *
 * A NULL column, a corrupt blob or a wrong shape drops the key rather than
 * sending `null`: a NULL column means this device does not know, `views: null`
 * would clear every peer, and an absent key is what an older sender produces,
 * so receivers on every build keep their own value.
 */
function normalizeTagPayload(local: Record<string, unknown>): Record<string, unknown> {
  const payload = { ...local }
  for (const [key, accepts] of Object.entries(JSON_TEXT_KEYS)) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    const parsed = parseJsonText(payload[key])
    if (accepts(parsed)) payload[key] = parsed
    else delete payload[key]
  }
  return payload
}

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
          Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId, operation }) => {
        const newClock = nextLocalClock(
          deps.db,
          'tag_definition',
          itemId,
          local.clock as VectorClock | null,
          deviceId,
          operation
        )

        deps.db
          .update(tagDefinitions)
          .set({ clock: newClock })
          .where(eq(tagDefinitions.name, itemId))
          .run()

        return { ...local, clock: newClock }
      },
      // #2897: edits queued with no device id tick `_offline`; rebind them
      // before the first push (chapter 06 §6.6).
      recoverPendingChange: (itemId, deviceId) =>
        recoverOfflineDocClock(
          deps.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, itemId)).get() as
            Record<string, unknown> | undefined,
          deviceId,
          (clock) =>
            deps.db
              .update(tagDefinitions)
              .set({ clock })
              .where(eq(tagDefinitions.name, itemId))
              .run()
        ),
      serialize: (local) => normalizeTagPayload(local),
      buildDeletePayload: ({ itemId, local, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload) {
          return withIncrementedClock(snapshotPayload, deviceId)
        }

        return deleteFromLocalRow('tag_definition', itemId, local, deviceId, normalizeTagPayload)
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
