import { and, eq, inArray } from 'drizzle-orm'
import { syncPendingDeletes } from '@memry/db-schema/data-schema'
import { getNoteMetadataById } from '@memry/storage-data'
import { incrementClock } from '@memry/sync-core'
import type { SyncItemType } from '@memry/contracts/sync-api'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database/client'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'

const log = createLogger('PendingDeletes')

export interface PendingDelete {
  type: SyncItemType
  itemId: string
  payload: string
}

/**
 * The tombstone body for a note or a journal, captured before its row goes.
 *
 * Notes and journals are the only delete paths whose payload is derived from
 * the row rather than handed in by the caller: `ContentSyncService` loads
 * `note_metadata` inside `enqueueDelete`, which is why `deleteNoteCommand`
 * enqueues BEFORE it removes the note. Deferring that call to the next runtime
 * start would find nothing to load, so the body is built here instead, at the
 * moment the delete is raised.
 *
 * Same shape and same rules as `NoteSyncService.buildDeletePayload`: no
 * user-visible text, the clock bumped under the real device id (peers order the
 * delete by it), and skipped entirely for a local-only row or one the server has
 * never seen.
 */
export function buildContentDeletePayload(db: DataDb, itemId: string): string | null {
  const local = getNoteMetadataById(db, itemId)
  if (!local) return null
  // The "never leaves this device" switch — mirrors `shouldSkip` on the online
  // path, which a deferred delete would otherwise bypass.
  if (local.localOnly) return null
  // No clock means the server has never seen this note, so there is no peer
  // holding it and nothing to tombstone.
  if (!local.clock) return null

  const deviceId = getCurrentDeviceId(db)
  if (!deviceId) return null

  return JSON.stringify({
    clock: incrementClock(local.clock, deviceId),
    createdAt: local.createdAt,
    modifiedAt: local.modifiedAt
  })
}

/**
 * Remember that this device deleted an item, and what the delete still owes the
 * server.
 *
 * Upserts on (type, itemId): deleting the same item twice is one tombstone. The
 * payload is refreshed so the newest capture wins.
 *
 * RETENTION — the row is removed only by `checkManifestIntegrity`, when a
 * complete server manifest no longer lists that (type, id). That is the one
 * place this client observes that the server is rid of the item. Until then the
 * row also blocks the pull path from re-inserting the id (`ItemApplier.apply`)
 * and keeps it out of the manifest's local refs, because notes and tasks are
 * hard-deleted locally and nothing else records that the user deleted them.
 */
export function recordPendingDelete(
  db: DataDb,
  type: SyncItemType,
  itemId: string,
  payload: string
): void {
  db.insert(syncPendingDeletes)
    .values({ type, itemId, payload, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [syncPendingDeletes.type, syncPendingDeletes.itemId],
      set: { payload, createdAt: new Date() }
    })
    .run()

  log.debug('Recorded a delete raised while the sync runtime was down', { type, itemId })
}

export function listPendingDeletes(db: DrizzleDb): PendingDelete[] {
  return db
    .select({
      type: syncPendingDeletes.type,
      itemId: syncPendingDeletes.itemId,
      payload: syncPendingDeletes.payload
    })
    .from(syncPendingDeletes)
    .all()
    .map((row) => ({ ...row, type: row.type as SyncItemType }))
}

/**
 * Notes and journals share one tombstone family: the classification is derived
 * from the row, so a note deleted as `note` can be served back as `journal`.
 */
export function hasPendingDelete(db: DrizzleDb, type: SyncItemType, itemId: string): boolean {
  const types = type === 'note' || type === 'journal' ? ['note', 'journal'] : [type]
  const row = db
    .select({ itemId: syncPendingDeletes.itemId })
    .from(syncPendingDeletes)
    .where(and(inArray(syncPendingDeletes.type, types), eq(syncPendingDeletes.itemId, itemId)))
    .get()

  return row !== undefined
}

export function clearPendingDelete(db: DrizzleDb, type: SyncItemType, itemId: string): void {
  db.delete(syncPendingDeletes)
    .where(and(eq(syncPendingDeletes.type, type), eq(syncPendingDeletes.itemId, itemId)))
    .run()
}
