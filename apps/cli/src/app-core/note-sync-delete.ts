import type { SyncItemType } from '@memry/contracts/sync-api'
import { syncPendingDeletes, type NoteMetadata } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/db-schema/drizzle-db'
import { deleteCanonicalNote } from '@memry/domain-notes'
import { isAttachmentStoreRow } from '@memry/shared/attachment-store'
import { getNoteMetadataById } from '@memry/storage-data'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { recordLocalDeleteClock } from '@memry/sync-client/tombstone-clocks'
import { incrementClock } from '@memry/sync-core'
import type { DataDb } from './database.ts'

/**
 * Desktop's `staysOnDevice` (apps/desktop/src/main/sync/content-sync-base.ts):
 * a local-only note, or a stray row in the attachment store (#5607), whose
 * delete would make a peer unlink the file another note embeds.
 */
function staysOnDevice(row: NoteMetadata): boolean {
  return row.localOnly || isAttachmentStoreRow(row)
}

/**
 * Desktop's `buildContentDeletePayload` (apps/desktop/src/main/sync/pending-deletes.ts):
 * the row's clock ticked under this device, and no user-visible text. Null when
 * there is nothing to tombstone: the note stays on this device, the server never
 * saw it (no clock), or no device is signed in.
 */
function contentDeletePayload(db: DrizzleDb, row: NoteMetadata): string | null {
  if (staysOnDevice(row) || !row.clock) return null
  const deviceId = getCurrentDeviceId(db)
  if (!deviceId) return null
  return JSON.stringify({
    clock: incrementClock(row.clock, deviceId),
    createdAt: row.createdAt,
    modifiedAt: row.modifiedAt
  })
}

/**
 * Drops a note's row and queues its sync delete for desktop (#5661).
 *
 * The row holds the clock a tombstone needs. Once it is gone, desktop's watcher,
 * which sees the unlink later, has nothing to build one from, and the note stays
 * on the server and on every other device. So this writes the pending delete and
 * tombstone clock desktop's `recordDeleteTombstone`
 * (apps/desktop/src/main/sync/local-mutations.ts) writes before it drops a row,
 * in the row delete's transaction. `flushPendingLocalDeletes` replays it at the
 * next sync runtime start.
 */
export function deleteNoteRowQueuingSyncDelete(db: DataDb, noteId: string): void {
  db.transaction((tx) => {
    const row = getNoteMetadataById(tx, noteId)
    const payload = row ? contentDeletePayload(tx, row) : null
    if (row && payload) {
      // The type desktop's watcher queues for the same unlink (vault/watcher.ts).
      const type: SyncItemType = row.journalDate ? 'journal' : 'note'
      tx.insert(syncPendingDeletes)
        .values({ type, itemId: noteId, payload, createdAt: new Date() })
        .onConflictDoUpdate({
          target: [syncPendingDeletes.type, syncPendingDeletes.itemId],
          set: { payload, createdAt: new Date() }
        })
        .run()
      recordLocalDeleteClock(tx, type, noteId, payload, 'final')
    }
    deleteCanonicalNote(tx, noteId)
  })
}
