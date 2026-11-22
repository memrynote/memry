import path from 'path'
import { open, type FileHandle } from 'fs/promises'
import { noteMetadata } from '@memry/db-schema/data-schema'
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
 * requested again.
 */
export async function restoreOverwrittenBinaryNotesWith(
  deps: BinaryNoteRestoreDeps
): Promise<{ requested: number }> {
  let notes: Array<
    Pick<typeof noteMetadata.$inferSelect, 'id' | 'path' | 'attachmentId' | 'localOnly'>
  >
  try {
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
    log.warn('Note metadata unreadable; binary note files not checked', { error })
    return { requested: 0 }
  }

  let requested = 0
  for (const note of notes) {
    // The file type column can still say markdown here (#5412), so the
    // extension decides what the file should be.
    if (!note.attachmentId || note.localOnly || !hasMediaSignature(getExtension(note.path)))
      continue
    if (resolveVaultFileSync(deps.vaultPath, note.path).kind === 'outside') continue
    const absolutePath = path.join(deps.vaultPath, note.path)
    if (!(await fileHoldsText(absolutePath))) continue
    if (!shouldAttemptDownload(deps.db, note.id, note.attachmentId)) continue

    log.warn('Binary note file holds text; downloading its attachment again', {
      noteId: note.id,
      attachmentId: note.attachmentId
    })
    markDownloadRequested(note.id, note.attachmentId)
    const delivered = attachmentEvents.emitDownloadNeeded({
      noteId: note.id,
      attachmentId: note.attachmentId,
      diskPath: absolutePath
    })
    if (!delivered) {
      // No downloader (runtime restarting): the rest would drop the same way,
      // and the next runtime start checks again.
      releaseDownloadAttempt(note.id, note.attachmentId)
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
