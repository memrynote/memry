import { and, eq, ne } from 'drizzle-orm'
import {
  OFFLINE_CLOCK_DEVICE_ID,
  RECREATABLE_AFTER_PURGE_ITEM_TYPES,
  type SyncItemType,
  type VectorClock
} from '@memry/contracts/sync-api'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { getHandler, type DrizzleDb } from '../item-handlers'
import type { PurgedTombstone } from './pull-envelope'

const RECREATABLE_TYPES = new Set<string>(RECREATABLE_AFTER_PURGE_ITEM_TYPES)

/**
 * Why a purged tombstone the envelope admitted is still not applied to this
 * device's row (#2302). The entry is unsigned and served for a delete that may
 * be far older than the local row, so each reason keeps local data:
 * - `local_clockless`: the local row has no clock. The handler's clock guard
 *   would be skipped and the delete would be unconditional (a restored vault
 *   folder, a tag minted by `getOrCreateTag`, a note created offline).
 * - `local_pending_write`: a recreatable item has a queued create or update.
 *   The server accepts that create over the marker, so deleting it here would
 *   lose the write the server is about to take.
 * - `local_newer`: a recreatable item was created or modified after the delete
 *   happened, which is a re-create or a restore, not a stale copy.
 * - `unknown_device`: the tombstone's clock names a device that appears
 *   neither in the local row's clock nor among this account's known devices.
 */
export type LocalTombstoneRefusal =
  'local_clockless' | 'local_pending_write' | 'local_newer' | 'unknown_device'

/** Ids of this account's devices cached locally, or null when the cache is empty (not checkable). */
export function readKnownDeviceIds(db: DrizzleDb): ReadonlySet<string> | null {
  const ids = db
    .select({ id: syncDevices.id })
    .from(syncDevices)
    .all()
    .map((row) => row.id)
  return ids.length > 0 ? new Set(ids) : null
}

const toClock = (value: unknown): VectorClock | null => {
  if (typeof value === 'string') {
    try {
      return toClock(JSON.parse(value))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' ? (value as VectorClock) : null
}

/** Epoch seconds from an ISO string, a Date, or epoch seconds/ms; null when unreadable. */
const toEpochSeconds = (value: unknown): number | null => {
  if (value instanceof Date) return value.getTime() / 1000
  if (typeof value === 'number') return value > 1e12 ? value / 1000 : value
  if (typeof value === 'string') {
    const ms = Date.parse(value)
    return Number.isNaN(ms) ? null : ms / 1000
  }
  return null
}

const hasPendingWrite = (db: DrizzleDb, type: string, itemId: string): boolean =>
  db
    .select({ id: syncQueue.id })
    .from(syncQueue)
    .where(
      and(eq(syncQueue.type, type), eq(syncQueue.itemId, itemId), ne(syncQueue.operation, 'delete'))
    )
    .get() !== undefined

/**
 * The local reason not to apply `tombstone`, or null to apply it through the
 * handler's clock-guarded delete. A missing local row is null: the delete is
 * then a no-op.
 */
export function localTombstoneRefusal(
  db: DrizzleDb,
  tombstone: PurgedTombstone,
  knownDevices: ReadonlySet<string> | null
): LocalTombstoneRefusal | null {
  const local = getHandler(tombstone.type as SyncItemType)?.fetchLocal(db, tombstone.id)
  if (!local) return null

  const localClock = toClock(local.clock)
  if (!localClock || Object.keys(localClock).length === 0) return 'local_clockless'

  if (RECREATABLE_TYPES.has(tombstone.type)) {
    if (hasPendingWrite(db, tombstone.type, tombstone.id)) return 'local_pending_write'
    const touched = [local.createdAt, local.modifiedAt, local.updatedAt]
      .map(toEpochSeconds)
      .filter((seconds): seconds is number => seconds !== null)
    if (touched.some((seconds) => seconds > tombstone.deletedAt)) return 'local_newer'
  }

  if (knownDevices) {
    const unknown = Object.keys(tombstone.clock).some(
      (deviceId) =>
        deviceId !== OFFLINE_CLOCK_DEVICE_ID &&
        !(deviceId in localClock) &&
        !knownDevices.has(deviceId)
    )
    if (unknown) return 'unknown_device'
  }
  return null
}
