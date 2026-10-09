import { and, eq, inArray, like, notInArray } from 'drizzle-orm'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import type { SyncItemType } from '@memry/contracts/sync-api'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { rebindOfflinePayloadClocks } from '@memry/sync-client/offline-clock'
import { coalesceSyncOperations } from '@memry/sync-client/queue'
import { getSettingsSyncManager } from '@memry/sync-client/settings-sync'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import { createLogger } from '../../lib/logger'

const log = createLogger('OfflineQueueRebind')

type Adapters = SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>

type QueuedRow = {
  id: string
  type: string
  itemId: string
  operation: string
  payload: string
}

/** Rows already reported as left queued, so a stuck row logs once per session. */
const reportedStuck = new Set<string>()

/**
 * Edits and deletes made while the session had no device id are queued with
 * `_offline` ticks (#2897), which must never reach the server (chapter 06
 * §6.6). The first push that can sign under a registered device moves those
 * ticks onto the device before it dequeues. Every row is fixed by its queue
 * id, whatever its `attempts`, because `SyncQueueManager.enqueue` only
 * coalesces into an `attempts = 0` row and a retried `_offline` row would
 * otherwise survive next to its rebound copy:
 *
 * - a delete has no row left, so its payload is rebound in place;
 * - a create or update goes back through its service, whose
 *   `recoverPendingChange` rebinds the stored clock before the service ticks
 *   the device and queues a fresh payload. The `_offline` rows for that item
 *   are then deleted in the same transaction, their operation folded into the
 *   fresh row. Rebinding only the payload would leave `_offline` in the row,
 *   and the pulled echo of the push would read as a concurrent edit;
 * - settings rebind their field clocks and re-queue their current state.
 *
 * When the service queues nothing fresh (its row is gone or `shouldSkip`
 * rejects it), nothing is left to push: the `_offline` create/update rows are
 * dropped and logged, so the queue drains (#2912). When the type has no local
 * adapter the rows stay queued, logged once per session, and the push holds
 * them back (`PushCoordinator.holdBackOfflineClocks`) so they never reach the
 * wire. Deletes are never dropped. The caller only runs this once the device
 * row matches the signing keys, so a row dropped here could not be rebound.
 *
 * Returns the number of queue rows rebound.
 */
export function rebindQueuedOfflineEdits(
  db: DrizzleDb,
  adapters: Adapters | undefined,
  deviceId: string
): number {
  const rows: QueuedRow[] = db
    .select({
      id: syncQueue.id,
      type: syncQueue.type,
      itemId: syncQueue.itemId,
      operation: syncQueue.operation,
      payload: syncQueue.payload
    })
    .from(syncQueue)
    .where(
      and(
        // Notes and journals tick the real device or nothing
        // (`handleMissingDevice`), and a journal update needs its date.
        notInArray(syncQueue.type, ['note', 'journal']),
        like(syncQueue.payload, '%"_offline"%')
      )
    )
    .all()

  let rebound = 0
  const edits = new Map<string, QueuedRow[]>()
  for (const row of rows) {
    if (row.operation === 'delete') {
      db.update(syncQueue)
        .set({ payload: rebindOfflinePayloadClocks(row.payload, deviceId) })
        .where(eq(syncQueue.id, row.id))
        .run()
      rebound++
      continue
    }
    const key = `${row.type}:${row.itemId}`
    edits.set(key, [...(edits.get(key) ?? []), row])
  }

  for (const [key, stale] of edits) {
    const { type, itemId } = stale[0]
    const create = stale.some((row) => row.operation === 'create')
    const requeue = requeueFor(type as SyncItemType, itemId, create, adapters)
    if (!requeue) {
      reportStuck(key, 'No local sync adapter for a queued offline edit')
      continue
    }
    rebound += db.transaction(() => {
      const itemRows = and(eq(syncQueue.type, type), eq(syncQueue.itemId, itemId))
      const staleIds = new Set(stale.map((row) => row.id))
      const before = new Set(
        db
          .select({ id: syncQueue.id })
          .from(syncQueue)
          .where(itemRows)
          .all()
          .map((row) => row.id)
      )
      requeue()
      // The requeue either coalesced into an `attempts = 0` stale row,
      // rewriting it, or inserted a new one. Any other row predates it.
      const fresh = db
        .select({ id: syncQueue.id, operation: syncQueue.operation, payload: syncQueue.payload })
        .from(syncQueue)
        .where(itemRows)
        .all()
        .find(
          (row) =>
            (staleIds.has(row.id) || !before.has(row.id)) && !row.payload.includes('"_offline"')
        )
      if (!fresh) {
        db.delete(syncQueue)
          .where(inArray(syncQueue.id, [...staleIds]))
          .run()
        log.warn('Dropped queued offline edit; its item is gone or no longer syncs', {
          item: key,
          rows: staleIds.size
        })
        return 0
      }
      const leftover = stale.filter((row) => row.id !== fresh.id)
      if (leftover.length === 0) return stale.length
      const operation = leftover.reduce(
        (op, row) => coalesceSyncOperations(row.operation, op),
        fresh.operation
      )
      db.update(syncQueue).set({ operation }).where(eq(syncQueue.id, fresh.id)).run()
      db.delete(syncQueue)
        .where(
          inArray(
            syncQueue.id,
            leftover.map((row) => row.id)
          )
        )
        .run()
      return stale.length
    })
  }
  return rebound
}

function requeueFor(
  type: SyncItemType,
  itemId: string,
  create: boolean,
  adapters: Adapters | undefined
): (() => void) | null {
  if (type === 'settings') {
    const settings = getSettingsSyncManager()
    return settings
      ? () => {
          settings.recoverOfflineClocks()
          settings.enqueueUpdate()
        }
      : null
  }
  const local = adapters?.getLocal(type)
  if (!local) return null
  // A create re-runs as one: append-only types (task activity) ignore updates.
  if (create) return () => local.enqueueCreate(itemId)
  // `[]`: calendar events read it as the changed fields, so no field ticks.
  return () => local.enqueueUpdate(itemId, [])
}

function reportStuck(key: string, message: string): void {
  if (reportedStuck.has(key)) return
  reportedStuck.add(key)
  log.warn(message, { item: key })
}
