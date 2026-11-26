import fs from 'node:fs'
import path from 'node:path'
import { getNoteMetadataById } from '@memry/storage-data'
import type { NoteFileDownload } from '@memry/sync-client/attachment-events'
import type { DrizzleDb } from '@memry/sync-client/item-handlers/types'
import { readVaultFileSync } from '../lib/paths'
import { createLogger } from '../lib/logger'
import { getNoteAttachmentsDir } from '../vault/attachments'
import {
  existingFiles,
  isRecordedAttachment,
  recordedFileOf,
  referencedVaultFiles
} from './attachment-files'

const logger = createLogger('OwedNoteDownloads')

/**
 * Whether the note's body embeds a vault file and every one it embeds is on
 * disk. A body that embeds none says nothing about the note's references.
 */
function bodyEmbedsOnDisk(vaultPath: string, note: { id: string; path: string }): boolean {
  if (!note.path.endsWith('.md')) return false
  let markdown: string | null
  try {
    markdown = readVaultFileSync(vaultPath, note.path)
  } catch (err) {
    logger.warn('Could not read the note body; its unrecorded embeds count as owed', {
      noteId: note.id,
      err
    })
    return false
  }
  if (markdown === null) return false
  const files = referencedVaultFiles(markdown, vaultPath, note.path, note.id)
  return files.length > 0 && existingFiles(files).length === files.length
}

/**
 * The files a note names that this device does not hold (#5616): a binary
 * note's own file, and each embedded attachment with no recorded file on disk.
 * Read from local state only, so opening a note that misses nothing sends no
 * request. An embed no record names (a note from before the record, #2651) is
 * listed while sync runs: the downloader checks it against the file on disk,
 * and its record keeps the next open local. While sync is off nothing can
 * download and the list only decides the alert, so such an embed is listed
 * only while a file the body embeds is missing.
 */
export function owedNoteDownloads(
  db: DrizzleDb,
  vaultPath: string,
  noteId: string,
  syncRunning: boolean
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
  let embedsOnDisk: boolean | undefined
  for (const attachmentId of note.attachmentReferences ?? []) {
    if (recordedFileOf(db, vaultPath, noteId, attachmentId)) continue
    if (!syncRunning && !isRecordedAttachment(db, noteId, attachmentId)) {
      embedsOnDisk ??= bodyEmbedsOnDisk(vaultPath, note)
      if (embedsOnDisk) continue
    }
    owed.push({
      noteId,
      attachmentId,
      diskPath: getNoteAttachmentsDir(vaultPath, noteId),
      intoDir: true
    })
  }
  return owed
}
