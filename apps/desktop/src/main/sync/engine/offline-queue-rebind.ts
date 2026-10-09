import { and, like, notInArray } from 'drizzle-orm'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import type { SyncItemType } from '@memry/contracts/sync-api'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { rebindOfflinePayloadClocks } from '@memry/sync-client/offline-clock'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { getSettingsSyncManager } from '@memry/sync-client/settings-sync'
import type { SyncAdapterRegistry } from '@memry/sync-core'

type Adapters = SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>

/**
 * Edits and deletes made while the session had no device id are queued with
 * `_offline` ticks (#2897), which must never reach the server (chapter 06
 * §6.6). The first push that can sign is the first point that knows the device
 * id, so it moves those ticks onto the device before it dequeues:
 *
 * - a create or update goes back through its service, whose
 *   `recoverPendingChange` rebinds the stored clock before the service ticks
 *   the device and re-queues over the same queue row. Rebinding only the
 *   payload would leave `_offline` in the row, and the pulled echo of the push
 *   would then read as a concurrent edit on every cycle;
 * - a delete has no row left, so its queued payload is rebound in place;
 * - settings rebind their own field clocks.
 *
 * Returns the number of queue rows rebound.
 */
export function rebindQueuedOfflineEdits(
  db: DrizzleDb,
  queue: SyncQueueManager,
  adapters: Adapters | undefined,
  deviceId: string
): number {
  getSettingsSyncManager()?.recoverOfflineClocks()

  const rows = db
    .select({
      type: syncQueue.type,
      itemId: syncQueue.itemId,
      operation: syncQueue.operation,
      payload: syncQueue.payload,
      priority: syncQueue.priority
    })
    .from(syncQueue)
    .where(
      and(
        // Settings rebind above. Notes and journals tick the real device or
        // nothing (`handleMissingDevice`), and a journal update needs its date.
        notInArray(syncQueue.type, ['settings', 'note', 'journal']),
        like(syncQueue.payload, '%"_offline"%')
      )
    )
    .all()

  let rebound = 0
  for (const row of rows) {
    if (row.operation === 'delete') {
      queue.enqueue({
        type: row.type as SyncItemType,
        itemId: row.itemId,
        operation: 'delete',
        payload: rebindOfflinePayloadClocks(row.payload, deviceId),
        priority: row.priority
      })
      rebound++
      continue
    }
    const local = adapters?.getLocal(row.type as SyncItemType)
    if (!local) continue
    // `[]`: calendar events read it as the changed fields, so no field ticks.
    local.enqueueUpdate(row.itemId, [])
    rebound++
  }
  return rebound
}
