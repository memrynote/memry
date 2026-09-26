import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  bookmarks,
  calendarBindings,
  calendarExternalEvents,
  calendarSources,
  noteMetadata,
  syncPendingDeletes
} from '@memry/db-schema/data-schema'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { getNoteMetadataById } from '@memry/storage-data'
import { incrementClock } from '@memry/sync-core'
import { RECREATABLE_AFTER_PURGE_ITEM_TYPES, type SyncItemType } from '@memry/contracts/sync-api'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { readTombstoneClock, type RecreatableItemType } from '@memry/sync-client/tombstone-clocks'
import { compare } from '@memry/sync-client/vector-clock'
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

const liveNote = (db: DrizzleDb, itemId: string): boolean =>
  db.select().from(noteMetadata).where(eq(noteMetadata.id, itemId)).get() !== undefined

/**
 * This device knows the note or journal is deleted: it has no row, or it
 * recorded a tombstone (#2409) that the row's clock does not follow. A row
 * minted past the tombstone is a re-create and stays live. The server keeps
 * a deleted note's CRDT state and accepts bodies for it, so offering one of
 * these as a create puts the deleted body back on every device.
 */
export function isNoteKnownDeleted(db: DrizzleDb, noteId: string): boolean {
  const row = db
    .select({ clock: noteMetadata.clock })
    .from(noteMetadata)
    .where(eq(noteMetadata.id, noteId))
    .get()
  if (!row) return true
  const tombstone = readTombstoneClock(db, 'note', noteId)
  return tombstone !== null && (!row.clock || compare(row.clock, tombstone) !== 'after')
}

const LIVE_LOCAL_ROW: Record<RecreatableItemType, (db: DrizzleDb, itemId: string) => boolean> = {
  note: liveNote,
  journal: liveNote,
  tag_definition: (db, id) =>
    db.select().from(tagDefinitions).where(eq(tagDefinitions.name, id)).get() !== undefined,
  property_definition: (db, id) =>
    db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, id)).get() !==
    undefined,
  folder_config: (db, id) =>
    db.select().from(folderConfigs).where(eq(folderConfigs.path, id)).get() !== undefined,
  // A local canvas folder delete keeps the row with `deletedAt` set.
  canvas_folder: (db, id) =>
    db
      .select()
      .from(canvasFolders)
      .where(and(eq(canvasFolders.id, id), isNull(canvasFolders.deletedAt)))
      .get() !== undefined,
  bookmark: (db, id) => db.select().from(bookmarks).where(eq(bookmarks.id, id)).get() !== undefined,
  calendar_source: (db, id) =>
    db.select().from(calendarSources).where(eq(calendarSources.id, id)).get() !== undefined,
  calendar_external_event: (db, id) =>
    db.select().from(calendarExternalEvents).where(eq(calendarExternalEvents.id, id)).get() !==
    undefined,
  calendar_binding: (db, id) =>
    db.select().from(calendarBindings).where(eq(calendarBindings.id, id)).get() !== undefined
}

const isRecreatable = (type: SyncItemType): type is RecreatableItemType =>
  (RECREATABLE_AFTER_PURGE_ITEM_TYPES as readonly SyncItemType[]).includes(type)

/**
 * #2423: the id of a pending delete is live on this device again, so the delete
 * is stale and replaying it would remove the live item on every device. Every
 * local delete of these types removes the row (a canvas folder is tombstoned
 * instead), and the pull refuses to re-insert an id with a pending delete, so a
 * live row means the id was re-created after the delete, or the local delete
 * never completed. Either way the row is what the user has. The same rule as a
 * stale delete intent (`dropStaleDelete` in sync-intents).
 *
 * Only re-creatable types: their ids are deterministic, and their live rows are
 * never soft-deleted ones. Other types keep a soft-deleted row under a random
 * id, which says nothing about a re-create.
 */
export function isSupersededByLiveRow(db: DrizzleDb, type: SyncItemType, itemId: string): boolean {
  return isRecreatable(type) && LIVE_LOCAL_ROW[type](db, itemId)
}

export function clearPendingDelete(db: DrizzleDb, type: SyncItemType, itemId: string): void {
  db.delete(syncPendingDeletes)
    .where(and(eq(syncPendingDeletes.type, type), eq(syncPendingDeletes.itemId, itemId)))
    .run()
}
