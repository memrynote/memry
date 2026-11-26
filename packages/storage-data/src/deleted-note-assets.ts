import { eq } from 'drizzle-orm'
import { deletedAssetReleases, noteMetadata } from '@memry/db-schema/data-schema'
import type { DrizzleDb } from '@memry/db-schema/drizzle-db'
import { isAttachmentStoreRow } from '@memry/shared/attachment-store'

/**
 * Records a note this device deletes in `deleted_asset_releases`, so desktop
 * frees the note's attachments on the server once the grace period has passed
 * (#3015). Reads the attachment ids from the note's row, so it runs before the
 * row is removed: by desktop's delete paths and by the CLI's `notes delete`
 * (#5693). Writes nothing for a note with no attachments, or for a stray row
 * in the attachment store: its delete never syncs (#5607), so its record and
 * its blob stay on the server for the peers that still hold it.
 */
export function recordDeletedNoteAssets(db: DrizzleDb, noteId: string, now = Date.now()): void {
  const note = db
    .select({
      refs: noteMetadata.attachmentReferences,
      own: noteMetadata.attachmentId,
      path: noteMetadata.path,
      fileType: noteMetadata.fileType
    })
    .from(noteMetadata)
    .where(eq(noteMetadata.id, noteId))
    .get()
  if (note && isAttachmentStoreRow(note)) return
  const attachmentIds = [...new Set([...(note?.refs ?? []), ...(note?.own ? [note.own] : [])])]
  if (attachmentIds.length === 0) return
  db.insert(deletedAssetReleases)
    .values({ itemType: 'note', itemId: noteId, deletedAt: now, attachmentIds })
    .onConflictDoUpdate({
      target: [deletedAssetReleases.itemType, deletedAssetReleases.itemId],
      set: { deletedAt: now, attachmentIds }
    })
    .run()
}
