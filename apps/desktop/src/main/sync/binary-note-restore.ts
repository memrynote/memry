import path from 'path'
import { open, type FileHandle } from 'fs/promises'
import { eq } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { getExtension } from '@memry/shared/file-types'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import {
  markDownloadRequested,
  releaseDownloadAttempt,
  shouldAttemptDownload
} from '@memry/sync-client/attachment-download-state'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { getDatabase, isDatabaseInitialized } from '../database'
import { createLogger } from '../lib/logger'
import { resolveVaultFileSync } from '../lib/paths'
import { getCurrentVaultPath } from '../store'
import { trackMainLog } from '../telemetry/diagnostics'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import { hasMediaSignature, mediaFileHoldsText } from './media-signature'

const log = createLogger('BinaryNoteRestore')

async function fileHoldsText(absolutePath: string): Promise<boolean> {
  const extension = getExtension(absolutePath)
  if (!hasMediaSignature(extension)) return false
  let file: FileHandle | null = null
  try {
    file = await open(absolutePath, 'r')
    const { size } = await file.stat()
    return await mediaFileHoldsText(file, extension, size)
  } catch {
    // Missing or unreadable: the normal download path owns a missing file.
    return false
  } finally {
    await file?.close()
  }
}

function readTextBlobs(db: DrizzleDb): Set<string> {
  const value = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, SYNC_STATE_KEYS.BINARY_NOTE_TEXT_BLOBS))
    .get()?.value
  if (!value) return new Set()
  let ids: unknown
  try {
    ids = JSON.parse(value)
  } catch (error) {
    // Forgetting the list only costs one more download of each text blob, which
    // the restore remembers again, while a throw here would stop every restore
    // scan for good. Removing the value reports it once, not at every start.
    log.warn('Binary note text-blob list is corrupt; starting it again', { error })
    trackMainLog('warn', { scope: 'BinaryNoteRestore', action: 'binary_note_text_blobs_corrupt' })
    try {
      db.delete(syncState).where(eq(syncState.key, SYNC_STATE_KEYS.BINARY_NOTE_TEXT_BLOBS)).run()
    } catch (removeError) {
      log.warn('Corrupt binary note text-blob list not removed', { error: removeError })
    }
    return new Set()
  }
  return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : [])
}

/**
 * The restore landed and the file still holds text: the server blob is text
 * too (an upload from a build without the upload guard, #5419). Downloading it
 * again changes nothing, so the attachment is never requested again. A new
 * upload mints a new attachment id, which this list does not hold.
 */
function rememberTextBlob(db: DrizzleDb, attachmentId: string): void {
  const ids = readTextBlobs(db)
  if (ids.has(attachmentId)) return
  ids.add(attachmentId)
  const value = JSON.stringify([...ids])
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key: SYNC_STATE_KEYS.BINARY_NOTE_TEXT_BLOBS, value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
  log.warn('Server blob is text; binary note file not restored again', {
    attachmentId,
    textBlobs: ids.size
  })
  trackMainLog('warn', {
    scope: 'BinaryNoteRestore',
    action: 'binary_note_text_blob',
    metrics: { itemCount: ids.size }
  })
}

async function checkRestoredFile(
  db: DrizzleDb,
  absolutePath: string,
  attachmentId: string
): Promise<void> {
  try {
    if (await fileHoldsText(absolutePath)) rememberTextBlob(db, attachmentId)
  } catch (error) {
    log.warn('Restored binary note file not checked', { attachmentId, error })
  }
}

export interface BinaryNoteRestoreDeps {
  db: DrizzleDb
  vaultPath: string
}

/**
 * Downloads the server blob back over every binary note file that holds text
 * (see `mediaFileHoldsText`). The request goes through the same
 * download-needed path a pull uses, so the DownloadQueue bounds concurrency,
 * the blob lands by atomic rename, and a failure is logged, reported and
 * persisted in `attachment_download_failures` for the re-driver to retry on its
 * backoff. Runs at each sync runtime start; a file that is still text then is
 * requested again, unless a restore already landed text (`rememberTextBlob`).
 */
export async function restoreOverwrittenBinaryNotesWith(
  deps: BinaryNoteRestoreDeps
): Promise<{ requested: number }> {
  let textBlobs: Set<string>
  let notes: Array<
    Pick<typeof noteMetadata.$inferSelect, 'id' | 'path' | 'attachmentId' | 'localOnly'>
  >
  try {
    textBlobs = readTextBlobs(deps.db)
    notes = deps.db
      .select({
        id: noteMetadata.id,
        path: noteMetadata.path,
        attachmentId: noteMetadata.attachmentId,
        localOnly: noteMetadata.localOnly
      })
      .from(noteMetadata)
      .all()
  } catch (error) {
    log.warn('Binary note restore state unreadable; files not checked', { error })
    return { requested: 0 }
  }

  let requested = 0
  for (const note of notes) {
    // The file type column can still say markdown here (#5412), so the
    // extension decides what the file should be.
    if (
      !note.attachmentId ||
      note.localOnly ||
      textBlobs.has(note.attachmentId) ||
      !hasMediaSignature(getExtension(note.path))
    )
      continue
    if (resolveVaultFileSync(deps.vaultPath, note.path).kind === 'outside') continue
    const absolutePath = path.join(deps.vaultPath, note.path)
    if (!(await fileHoldsText(absolutePath))) continue
    const attachmentId = note.attachmentId
    const claim = shouldAttemptDownload(deps.db, note.id, attachmentId)
      ? markDownloadRequested(note.id, attachmentId)
      : null
    if (!claim) continue

    log.warn('Binary note file holds text; downloading its attachment again', {
      noteId: note.id,
      attachmentId: note.attachmentId
    })
    const delivered = attachmentEvents.emitDownloadNeeded({
      noteId: note.id,
      attachmentId,
      diskPath: absolutePath,
      landed: () => void checkRestoredFile(deps.db, absolutePath, attachmentId),
      claim
    })
    if (!delivered) {
      // No downloader (runtime restarting): the rest would drop the same way,
      // and the next runtime start checks again.
      releaseDownloadAttempt(claim)
      break
    }
    requested++
  }

  if (requested > 0) log.warn('Requested binary note files back from the server', { requested })
  return { requested }
}

/** The sync runtime's entry point. Never throws. */
export async function restoreOverwrittenBinaryNotes(): Promise<void> {
  try {
    const vaultPath = getCurrentVaultPath()
    if (!vaultPath || !isDatabaseInitialized()) return
    await restoreOverwrittenBinaryNotesWith({ db: getDatabase(), vaultPath })
  } catch (error) {
    log.warn('Binary note file check failed', { error })
  }
}
