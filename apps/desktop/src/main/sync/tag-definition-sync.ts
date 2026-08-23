import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'


interface TagDefinitionSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: TagDefinitionSyncService | null = null

/**
 * Normalise a raw `tag_definitions` row into something
 * `TagDefinitionSyncPayloadSchema` accepts.
 *
 * `tag_definitions.views` is a TEXT column holding a JSON array, but the
 * contract expects `array | null | undefined`. Shipping the row verbatim put a
 * *string* on the wire, so `safeParse` failed on the receiving device and the
 * whole tag definition — colour included — was dropped.
 *
 * The push coordinator normally rebuilds this payload via
 * `tagDefinitionHandler.buildPushPayload` (which calls `readTagViews`), so the
 * frozen queue payload only escapes on the fallback path — reached when the row
 * is gone locally by flush time, e.g. a remote delete hard-deletes it while a
 * local update is still queued. Normalising here makes both paths agree.
 *
 * Backward compatibility:
 * - Key presence is preserved exactly as the row provides it, so this never
 *   turns an absent `views` into an explicit clear.
 * - A corrupt or non-array blob drops the key rather than sending `null`, so the
 *   receiver's `hasOwnProperty` guard keeps its local views instead of clearing
 *   them. An absent key is also what an older sender produces, so receivers on
 *   every build already handle it.
 */
function normalizeTagPayload(local: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(local, 'views')) return local

  const raw = local.views
  // `null` is an explicit clear and an array is already schema-shaped.
  if (raw === null || Array.isArray(raw)) return local

  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return { ...local, views: parsed }
    } catch {
      // Corrupt blob: fall through and drop the key. Mirrors `readTagViews`,
      // which treats unreadable JSON as "no saved views" rather than throwing.
    }
  }

  const { views: _unreadable, ...rest } = local
  return rest
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
      serialize: (local) => normalizeTagPayload(local),
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
