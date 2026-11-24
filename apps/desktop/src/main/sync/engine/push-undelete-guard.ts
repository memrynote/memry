import type { SyncItemType, VectorClock } from '@memry/contracts/sync-api'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { readTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import { clockFromColumn, compare } from '@memry/sync-client/vector-clock'
import type { SyncAdapterRegistry } from '@memry/sync-core'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { createLogger } from '../../lib/logger'
import { getHandler } from '../item-handlers'

const log = createLogger('PushUndeleteGuard')

type Adapters = SyncAdapterRegistry<DrizzleDb, (channel: string, data: unknown) => void>

/**
 * Types whose pulled delete soft-deletes the row and persists the delete's
 * merged clock on its `clock` column (`applyDelete` in tag-category-handler.ts
 * and canvas-handler.ts), with local deletes queued as `delete`. Agent rows
 * also carry `deletedAt` but keep their clock elsewhere, and canvas folders
 * read as missing once deleted, so neither is listed.
 */
const SOFT_DELETE_TOMBSTONE_TYPES = new Set<string>(['tag_category', 'canvas'])

interface QueuedRow {
  id: string
  type: string
  itemId: string
  operation: string
  payload: string
}

function payloadClock(payload: string): VectorClock | undefined {
  try {
    const parsed: unknown = JSON.parse(payload)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const clock = (parsed as { clock?: unknown }).clock
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a queued payload's clock is a VectorClock written by this build or an older one
    return typeof clock === 'object' && clock !== null ? (clock as VectorClock) : undefined
  } catch {
    // An unparseable frozen payload carries no clock, so it cannot dominate.
    return undefined
  }
}

/**
 * The item's local row through the same lookups the push uses (registry
 * adapter, then handler): undefined when it is missing, null when the type
 * cannot look one up. Settings live in config.json, so their `fetchLocal`
 * answers undefined for a present singleton: that is "cannot look up", never
 * "missing". Every other registered handler's `fetchLocal` reads its table.
 */
export function fetchLocalRow(
  db: DrizzleDb,
  adapters: Adapters | undefined,
  type: SyncItemType,
  itemId: string
): Record<string, unknown> | undefined | null {
  if (type === 'settings') return null
  const adapter = adapters?.getRemote(type)
  if (adapter?.fetchLocal) return adapter.fetchLocal(db, itemId)
  const handler = getHandler(type)
  return handler ? handler.fetchLocal(db, itemId) : null
}

/**
 * Why a queued edit would undelete its item, or null to send it. Mirrors
 * core's push-time retire (`crates/memry-core/src/sync/push.rs` `build`, no
 * live row): an older build applied a pulled delete and kept the edit queued.
 * With the delete never re-delivered, the push would send the edit, which the
 * server stores over its tombstone (#5428). The delete is the recorded
 * tombstone clock (re-creatable types) or, for a soft-deleted row of
 * SOFT_DELETE_TOMBSTONE_TYPES, the row itself. Local deletes queue a `delete`,
 * which replaces a queued edit, so such a row under a queued edit is a pulled
 * delete.
 * An edit whose clock happens after the delete is a re-create (§5.8) and is
 * still sent. For a soft-deleted row no shipped apply path reaches that case:
 * `applyDelete`, and tag_category's `applyUpsert` of a payload with
 * `deletedAt`, both keep a clock at or after the queued edit's. It covers a
 * row written otherwise. A missing row with no recorded tombstone is left as
 * before.
 */
function undeletesTombstone(
  db: DrizzleDb,
  adapters: Adapters | undefined,
  item: QueuedRow
): string | null {
  if (item.operation === 'delete') return null
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- queue item type is a text column written from SyncItemType
  const row = fetchLocalRow(db, adapters, item.type as SyncItemType, item.itemId)
  if (row === null) return null
  const softDeleted = SOFT_DELETE_TOMBSTONE_TYPES.has(item.type) && row?.deletedAt != null
  if (row && !softDeleted) return null
  const tombstone =
    readTombstoneClock(db, item.type, item.itemId) ??
    (softDeleted ? clockFromColumn(row?.clock) : null)
  if (!tombstone && !softDeleted) return null
  const clock = payloadClock(item.payload)
  if (clock && tombstone && compare(clock, tombstone) === 'after') return null
  return softDeleted ? 'its local row is soft-deleted' : 'it has no local row'
}

/**
 * Removes from the queue, and from `items`, every edit that would undelete its
 * item. A failed check sends the edit as before (logged).
 */
export function retireUndeletes<T extends QueuedRow>(
  db: DrizzleDb,
  adapters: Adapters | undefined,
  queue: Pick<SyncQueueManager, 'removeById'>,
  items: T[]
): T[] {
  return items.filter((item) => {
    let reason: string | null
    try {
      reason = undeletesTombstone(db, adapters, item)
    } catch (err) {
      log.warn('Push: undelete check failed; sending the edit as before', {
        item: `${item.type}:${item.itemId}`,
        error: err
      })
      return true
    }
    if (!reason) return true
    log.warn('Push: retired a queued edit of a deleted item', {
      item: `${item.type}:${item.itemId}`,
      reason
    })
    queue.removeById(item.id)
    return false
  })
}
