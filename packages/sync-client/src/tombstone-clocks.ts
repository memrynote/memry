import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { syncTombstoneClocks } from '@memry/db-schema/schema/sync-tombstone-clocks'
import { syncPendingDeletes } from '@memry/db-schema/schema/sync-pending-deletes'
import {
  RECREATABLE_AFTER_PURGE_ITEM_TYPES,
  type SyncItemType,
  type VectorClock
} from '@memry/contracts/sync-api'
import { incrementClock, recreateBaseClock } from '@memry/sync-core'
import { getCurrentDeviceId } from './current-device-id'
import { merge } from './vector-clock'

/**
 * What this device knows about the deletes of a re-creatable id (#2409).
 *
 * A re-created deterministic id (a journal day, a tag name, a folder path, a
 * restored note) used to be minted with a fresh clock that its tombstone's
 * clock dominated, so the server refused it (protocol 05 §5.8) and, after the
 * purge, stored a regressed clock a stale device could overwrite. Every
 * delete this device makes or applies is recorded here, and every first clock
 * of a re-creatable type is minted through `nextLocalClock`, so the re-create
 * happens strictly after the delete.
 */

export type RecreatableItemType = (typeof RECREATABLE_AFTER_PURGE_ITEM_TYPES)[number]

const RECREATABLE_TYPES = new Set<string>(RECREATABLE_AFTER_PURGE_ITEM_TYPES)

/** Notes and journals share one tombstone family: a note deleted as `note` can come back as `journal`. */
const familyOf = (type: string): string => (type === 'journal' ? 'note' : type)

const familyTypes = (type: string): string[] =>
  familyOf(type) === 'note' ? ['note', 'journal'] : [type]

const isEmptyClock = (clock: VectorClock | null | undefined): boolean =>
  !clock || Object.keys(clock).length === 0

export function readTombstoneClock(
  db: DrizzleDb,
  type: string,
  itemId: string
): VectorClock | null {
  const row = db
    .select({ clock: syncTombstoneClocks.clock })
    .from(syncTombstoneClocks)
    .where(
      and(eq(syncTombstoneClocks.type, familyOf(type)), eq(syncTombstoneClocks.itemId, itemId))
    )
    .get()
  return row?.clock ?? null
}

/** Merge-upsert. No-op unless `type` is re-creatable and `clock` is non-empty. Idempotent. */
export function recordTombstoneClock(
  db: DrizzleDb,
  type: SyncItemType,
  itemId: string,
  clock: VectorClock | null | undefined
): void {
  if (!RECREATABLE_TYPES.has(type) || !clock || isEmptyClock(clock)) return
  const existing = readTombstoneClock(db, type, itemId)
  const merged = existing ? merge(existing, clock) : clock
  const updatedAt = new Date()
  db.insert(syncTombstoneClocks)
    .values({ type: familyOf(type), itemId, clock: merged, updatedAt })
    .onConflictDoUpdate({
      target: [syncTombstoneClocks.type, syncTombstoneClocks.itemId],
      set: { clock: merged, updatedAt }
    })
    .run()
}

/**
 * A local delete's clock. `final`: the payload already carries the ticked
 * delete clock (a note or journal body from `buildContentDeletePayload`).
 * `snapshot`: the caller's row snapshot, ticked once with the current device,
 * the same tick the sync service applies to it (`withIncrementedClock`).
 * Records nothing when there is no device id or the payload is unreadable.
 */
export function recordLocalDeleteClock(
  db: DrizzleDb,
  type: SyncItemType,
  itemId: string,
  payload: string,
  form: 'final' | 'snapshot'
): void {
  if (!RECREATABLE_TYPES.has(type)) return
  let clock: VectorClock | undefined
  try {
    const parsed = JSON.parse(payload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    clock = (parsed as { clock?: VectorClock }).clock
  } catch {
    return
  }
  if (form === 'snapshot') {
    const deviceId = getCurrentDeviceId(db)
    if (!deviceId) return
    clock = incrementClock(clock, deviceId)
  }
  recordTombstoneClock(db, type, itemId, clock)
}

/**
 * The mint for a re-creatable type: `increment(recreateBaseClock(current, T,
 * operation), deviceId)`. With no recorded tombstone the clock is exactly the
 * one `incrementClock(current, deviceId)` gives.
 *
 * When the tombstone is absorbed, this device's own pending delete of the id
 * is retired: the re-create supersedes it (the same reasoning as
 * `dropStaleDelete` in desktop's sync-intents). Kept, it would make the pull
 * refuse every remote edit of the live item and be replayed as a delete at the
 * next runtime start.
 */
export function nextLocalClock(
  db: DrizzleDb,
  type: RecreatableItemType,
  itemId: string,
  current: VectorClock | null | undefined,
  deviceId: string,
  operation: 'create' | 'update'
): VectorClock {
  const tombstone = readTombstoneClock(db, type, itemId)
  if (tombstone && (operation === 'create' || isEmptyClock(current))) {
    db.delete(syncPendingDeletes)
      .where(
        and(
          inArray(syncPendingDeletes.type, familyTypes(type)),
          eq(syncPendingDeletes.itemId, itemId)
        )
      )
      .run()
  }
  return incrementClock(recreateBaseClock(current, tombstone, operation), deviceId)
}
