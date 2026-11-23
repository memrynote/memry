import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import { updateNoteCache } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { clearAttachmentDownloadFailure } from '@memry/sync-client/attachment-download-state'
import { enqueueLocalSyncUpdate } from './local-mutations'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { clearCaseTwinForeignBytes, holdsCaseTwinForeignBytes } from '../vault/case-twin-bytes'
import { SupersededDownloadError } from './attachment-errors'

const log = createLogger('NoteAttachmentMetadata')

export function recordUploadedAttachment(noteId: string, attachmentId: string): void {
  const db = getDatabase()
  // The note's file holds bytes that are not its own, or a peer's replacement
  // is landing on it (#5560, #5580). Recorded on this note, the upload would
  // push over the bytes the note is waiting for. The landing keeps the
  // uploaded bytes as a conflict copy, a note of its own, when they are a
  // change since the mark.
  if (holdsCaseTwinForeignBytes(db, noteId)) {
    log.warn('An upload of a file awaiting its own bytes is kept off the note', {
      noteId,
      attachmentId
    })
    return
  }
  // Merge, don't replace: a note can embed several attachments and each upload
  // lands here separately — replacing the list dropped every id but the last.
  const existing = getNoteMetadataById(db, noteId)?.attachmentReferences ?? []
  const merged = existing.includes(attachmentId) ? existing : [...existing, attachmentId]
  // Data DB FIRST. It is the sync source of truth (`buildNotePushPayload` reads
  // `attachmentReferences` from it) while the index DB is a rebuildable cache.
  // These are two SQLite files with no shared transaction, so if one write has
  // to lose it must be the cache: an index-only write would show the image on
  // this device and never tell any peer it exists.
  const updated = updateNoteMetadata(db, noteId, {
    attachmentId,
    attachmentReferences: merged
  })
  updateNoteCache(getIndexDatabase(), noteId, { attachmentId })

  // The way back out of a recorded "the server does not have this" verdict: the
  // server demonstrably has it now, so any stale failure row must not keep this
  // device from materializing it.
  clearAttachmentDownloadFailure(db, noteId, attachmentId)

  if (!updated) {
    // No sync row for this note, so the reference is not in — and will never
    // reach — the push payload. Previously silent; the note kept syncing while
    // its images stayed on this machine.
    log.warn('Uploaded attachment has no note metadata row — reference will not sync', {
      noteId,
      attachmentId
    })
    return
  }

  // A successful upload only mutates this sidecar row, and nothing else on the
  // upload path enqueues a note push. Without this the new reference sat in the
  // local data DB until some unrelated later note edit happened to push the
  // note; until then every peer received a payload with no
  // `attachmentReferences` and so never emitted `download-needed` — notes
  // arrived with text but no images, and re-adding the image walked the same
  // dead path again.
  //
  // Backward compatibility: this enqueues an ordinary note UPDATE through the
  // existing note sync service. No new sync item type, no new IPC contract, no
  // change to the note payload shape — `attachmentReferences` is an optional
  // key `buildNotePushPayload` already emits (and omits when empty), and note
  // payloads are parsed with zod strip mode, so a peer on an older build that
  // predates the key ignores it and applies the rest of the update exactly as
  // it does today.
  enqueueLocalSyncUpdate('note', noteId)
}

/**
 * Binary note `noteId`'s attachment `attachmentId` landed on its file. The
 * file holds the note's own bytes only while the row still names that
 * attachment; a newer record keeps the file held until its own lands (#5580).
 */
export function recordDownloadedFileSize(
  noteId: string,
  attachmentId: string,
  fileSize: number
): void {
  const db = getDatabase()
  updateNoteCache(getIndexDatabase(), noteId, { fileSize })
  updateNoteMetadata(db, noteId, { fileSize })
  if (getNoteMetadataById(db, noteId)?.attachmentId === attachmentId) {
    clearCaseTwinForeignBytes(db, noteId)
  }
}

/**
 * Before attachment `attachmentId` lands on binary note `noteId`'s file:
 * throws when a newer record named another attachment while it downloaded,
 * so older bytes never land where the row names newer ones (#5580).
 */
export function assertOwnAttachmentLands(
  db: DrizzleDb,
  noteId: string,
  attachmentId: string
): void {
  const own = getNoteMetadataById(db, noteId)?.attachmentId
  if (own && own !== attachmentId) throw new SupersededDownloadError(noteId, attachmentId)
}
