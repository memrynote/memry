import fs from 'node:fs'
import path from 'node:path'
import { getNoteMetadataById } from '@memry/storage-data'
import type { NoteFileDownload } from '@memry/sync-client/attachment-events'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { getNoteAttachmentsDir } from '../vault/attachments'
import { recordedFileOf } from './attachment-files'

/**
 * The files a note names that this device does not hold (#5616): a binary
 * note's own file, and each embedded attachment with no recorded file on disk.
 * Read from local state only, so opening a note that misses nothing sends no
 * request. An embed never recorded here (a note from before the record, #2651)
 * is listed too: the downloader skips a file already on disk at its size.
 */
export function owedNoteDownloads(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string
): NoteFileDownload[] {
  const note = getNoteMetadataById(db, noteId)
  if (!note || note.localOnly) return []

  const owed: NoteFileDownload[] = []
  if (note.attachmentId) {
    const diskPath = path.join(vaultPath, note.path)
    if (!fs.existsSync(diskPath)) {
      owed.push({
        noteId,
        attachmentId: note.attachmentId,
        diskPath,
        ...(note.fileSize ? { sizeHint: note.fileSize } : {})
      })
    }
  }
  for (const attachmentId of note.attachmentReferences ?? []) {
    if (recordedFileOf(db, vaultPath, noteId, attachmentId)) continue
    owed.push({
      noteId,
      attachmentId,
      diskPath: getNoteAttachmentsDir(vaultPath, noteId),
      intoDir: true
    })
  }
  return owed
}
