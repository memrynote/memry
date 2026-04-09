import { updateNoteMetadata } from '@memry/storage-data'
import { updateNoteCache } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'

export function recordUploadedAttachment(noteId: string, attachmentId: string): void {
  updateNoteCache(getIndexDatabase(), noteId, { attachmentId })
  updateNoteMetadata(getDatabase(), noteId, {
    attachmentId,
    attachmentReferences: [attachmentId]
  })
}

export function recordDownloadedFileSize(noteId: string, fileSize: number): void {
  updateNoteCache(getIndexDatabase(), noteId, { fileSize })
  updateNoteMetadata(getDatabase(), noteId, { fileSize })
}
