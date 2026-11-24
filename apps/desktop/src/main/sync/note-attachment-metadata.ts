import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import { updateNoteCache } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { clearAttachmentDownloadFailure } from '@memry/sync-client/attachment-download-state'
import { getCurrentDeviceId } from '@memry/sync-client/current-device-id'
import { enqueueLocalSyncUpdate } from './local-mutations'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { isBinaryNoteRow } from '@memry/shared/file-types'
import {
  clearCaseTwinForeignBytes,
  hashFile,
  holdsCaseTwinForeignBytes
} from '../vault/case-twin-bytes'
import { toAbsolutePath } from '../vault/notes-io'
import { SupersededDownloadError } from './attachment-errors'
import { recordLandedBinaryHash, recordUploadedBinaryHash } from './binary-synced-hash'

const log = createLogger('NoteAttachmentMetadata')

/** `sha256`: the uploaded bytes' checksum, unknown for an inbox attachment reused onto the note. */
export function recordUploadedAttachment(
  noteId: string,
  attachmentId: string,
  sha256?: string
): void {
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
  const note = getNoteMetadataById(db, noteId)
  const binary = sha256 !== undefined && note !== undefined && isBinaryNoteRow(note)
  if (binary) {
    // The binary note's file holds other bytes now: a newer edit with its own
    // upload, or a peer's replacement that landed while this one uploaded,
    // which kept these bytes as a conflict copy, a note of its own (#5595).
    const onDisk = hashFile(toAbsolutePath(note.path))
    if (onDisk !== null && onDisk !== sha256) {
      log.warn('An upload of bytes its file no longer holds is kept off the note', {
        noteId,
        attachmentId
      })
      return
    }
  }
  // Merge, don't replace: a note can embed several attachments and each upload
  // lands here separately — replacing the list dropped every id but the last.
  const existing = note?.attachmentReferences ?? []
  const merged = existing.includes(attachmentId) ? existing : [...existing, attachmentId]
  // The bytes reach a peer only in a push of this device's queued from here
  // on, below: its tick on this device is past the row's.
  const deviceId = getCurrentDeviceId(db)
  const push = deviceId ? { deviceId, tick: (note?.clock?.[deviceId] ?? 0) + 1 } : null
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
  if (binary && updated) recordUploadedBinaryHash(db, noteId, sha256, push)

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
 * Binary note `noteId`'s attachment `attachmentId`, whose bytes hash to
 * `sha256`, landed on its file: bytes a server holds (#5598). The file holds
 * the note's own bytes only while the row still names that attachment; a
 * newer record keeps the file held until its own lands (#5580). A row dropped
 * while the bytes landed gets nothing recorded: its marks went with it
 * (REVIEW-5662).
 */
export function recordDownloadedFileSize(
  noteId: string,
  attachmentId: string,
  fileSize: number,
  sha256: string
): void {
  const db = getDatabase()
  const note = getNoteMetadataById(db, noteId)
  if (!note) return
  updateNoteCache(getIndexDatabase(), noteId, { fileSize })
  updateNoteMetadata(db, noteId, { fileSize })
  recordLandedBinaryHash(db, noteId, sha256)
  if (note.attachmentId === attachmentId) clearCaseTwinForeignBytes(db, noteId)
}

/**
 * Before attachment `attachmentId` lands on binary note `noteId`'s file:
 * throws when a newer record named another attachment while it downloaded,
 * so older bytes never land where the row names newer ones (#5580), and when
 * the note's row is gone, so a deleted note's file never comes back as a new
 * note (REVIEW-5662).
 */
export function assertOwnAttachmentLands(
  db: DrizzleDb,
  noteId: string,
  attachmentId: string
): void {
  const note = getNoteMetadataById(db, noteId)
  if (!note || (note.attachmentId && note.attachmentId !== attachmentId)) {
    throw new SupersededDownloadError(noteId, attachmentId)
  }
}
