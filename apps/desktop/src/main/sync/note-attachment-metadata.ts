import { stat } from 'fs/promises'
import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import { updateNoteCache } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { clearAttachmentDownloadFailure } from '@memry/sync-client/attachment-download-state'
import { enqueueLocalSyncUpdate } from './local-mutations'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { isBinaryNoteRow } from '@memry/shared/file-types'
import { clearCaseTwinForeignBytes, holdsCaseTwinForeignBytes } from '../vault/case-twin-bytes'
import { hashFileOffThread } from '../vault/file-hash-bridge'
import { toAbsolutePath } from '../vault/notes-io'
import { SupersededDownloadError } from './attachment-errors'
import { readSyncedBinaryHash, recordSyncedBinaryHash } from './binary-synced-hash'

const log = createLogger('NoteAttachmentMetadata')

/** An inbox attachment reused onto the note, its bytes' checksum unknown. */
export function recordUploadedAttachment(noteId: string, attachmentId: string): void {
  recordOnNote(noteId, attachmentId)
}

/**
 * An upload of note `noteId`'s file, whose bytes hash to `sha256`, succeeded.
 * Resolves false when the upload is kept off the note: the file does not hold
 * its bytes, so nothing may record it as holding them.
 */
export async function recordUploadedFile(
  noteId: string,
  attachmentId: string,
  sha256: string
): Promise<boolean> {
  const note = getNoteMetadataById(getDatabase(), noteId)
  const binary = note !== undefined && isBinaryNoteRow(note)
  if (binary && !(await fileHoldsUpload(noteId, sha256))) {
    log.warn('An upload of bytes its file no longer holds is kept off the note', {
      noteId,
      attachmentId
    })
    return false
  }
  return recordOnNote(noteId, attachmentId, binary ? sha256 : undefined)
}

/**
 * Whether binary note `note`'s file still holds its uploaded bytes `sha256`.
 * Not when it holds other bytes now: a newer edit with its own upload, or a
 * peer's replacement that landed while this one uploaded, which kept these
 * bytes as a conflict copy, a note of its own (#5595). A landing inside the
 * hash renames its bytes over the file the hash reads, so the hash still
 * matches and the landing clears the mark: the mark is read before the hash,
 * and after it the file where the row names it, moved or not, must be the same
 * one, and the bytes last landed or uploaded the same (#5617): a landing
 * records its bytes, which shows it where the identity cannot, as on a
 * filesystem with no inode numbers. A change made during the hash keeps this
 * upload off too, and its own upload records it.
 */
async function fileHoldsUpload(noteId: string, sha256: string): Promise<boolean> {
  const db = getDatabase()
  if (holdsCaseTwinForeignBytes(db, noteId)) return false
  const synced = readSyncedBinaryHash(db, noteId)
  const before = await fileAtRowPath(db, noteId)
  if (!before) return false
  // Hashed off the main thread: a vault's first upload hashes every file (#5608).
  const onDisk = await hashFileOffThread(before.filePath)
  if (onDisk !== null && onDisk !== sha256) return false
  const after = await fileAtRowPath(db, noteId)
  return after?.identity === before.identity && readSyncedBinaryHash(db, noteId) === synced
}

/** Note `noteId`'s file where its row names it. Undefined once the row is gone. */
async function fileAtRowPath(
  db: DrizzleDb,
  noteId: string
): Promise<{ filePath: string; identity: string | null } | undefined> {
  for (;;) {
    const relativePath = getNoteMetadataById(db, noteId)?.path
    if (relativePath === undefined) return undefined
    const filePath = toAbsolutePath(relativePath)
    const identity = await fileIdentity(filePath)
    // A rename moves the file before the row: stat again where the row names it now.
    if (getNoteMetadataById(db, noteId)?.path === relativePath) return { filePath, identity }
  }
}

/** Changes with a write to the file or a rename over it. Null when nothing is there. */
async function fileIdentity(filePath: string): Promise<string | null> {
  try {
    const stats = await stat(filePath, { bigint: true })
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}`
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

/** `syncedHash`: the binary note's uploaded bytes' checksum. False when kept off the note. */
function recordOnNote(noteId: string, attachmentId: string, syncedHash?: string): boolean {
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
    return false
  }
  const note = getNoteMetadataById(db, noteId)
  // Merge, don't replace: a note can embed several attachments and each upload
  // lands here separately — replacing the list dropped every id but the last.
  const existing = note?.attachmentReferences ?? []
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
  if (syncedHash !== undefined && updated) recordSyncedBinaryHash(db, noteId, syncedHash)

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
    return true
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
  return true
}

/**
 * Binary note `noteId`'s attachment `attachmentId`, whose bytes hash to
 * `sha256`, landed on its file: bytes a server holds (#5598). The file holds
 * the note's own bytes only while the row still names that attachment; a
 * newer record keeps the file held until its own lands (#5580).
 */
export function recordDownloadedFileSize(
  noteId: string,
  attachmentId: string,
  fileSize: number,
  sha256: string
): void {
  const db = getDatabase()
  updateNoteCache(getIndexDatabase(), noteId, { fileSize })
  updateNoteMetadata(db, noteId, { fileSize })
  recordSyncedBinaryHash(db, noteId, sha256)
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
