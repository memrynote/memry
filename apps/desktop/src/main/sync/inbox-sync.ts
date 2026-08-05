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

/** Single reading of the "never leaves this device" flag for a loaded row. */
function isLocalOnly(local: Record<string, unknown>): boolean {
  return Boolean(local.localOnly)
}

/**
 * Same flag, read off a serialized snapshot instead of a live row — the only
 * option on the delete path, where the row is already gone. Column name is
 * `local_only` in SQL but the snapshot is a stringified Drizzle row, so the
 * mapped `localOnly` property is what lands in the JSON.
 */
function isLocalOnlySnapshot(snapshot: string): boolean {
  try {
    const parsed = JSON.parse(snapshot) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
    return Boolean((parsed as { localOnly?: unknown }).localOnly)
  } catch {
    // An unparseable snapshot tells us nothing about localOnly. Fall through to
    // the normal tombstone rather than swallowing a legitimate delete — older
    // builds wrote this payload too, and dropping their deletes would strand
    // the item on every other device.
    return false
  }
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
      shouldSkip: isLocalOnly,
      buildDeletePayload: ({ extra, deviceId }) => {
        // Second home for the localOnly guard, and inbox genuinely needs it.
        // RecordSyncController.enqueueDelete applies `shouldSkip` to the row it
        // loads, but handleDeletePermanent (inbox/crud.ts) snapshots the row,
        // DELETES it, and only then enqueues — so by the time the controller
        // runs, `load` returns undefined and its guard cannot fire on this path.
        //
        // The snapshot we are handed is the row's last known state, which makes
        // it the only thing left that still knows whether the user marked this
        // item as never leaving the device.
        if (isLocalOnlySnapshot(extra[0])) return null

        return withIncrementedClock(extra[0], deviceId)
      }
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
