import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import { updateNoteCache } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'

export function recordUploadedAttachment(noteId: string, attachmentId: string): void {
  const db = getDatabase()
  // Merge, don't replace: a note can embed several attachments and each upload
  // lands here separately — replacing the list dropped every id but the last.
  const existing = getNoteMetadataById(db, noteId)?.attachmentReferences ?? []
  const merged = existing.includes(attachmentId) ? existing : [...existing, attachmentId]
  updateNoteCache(getIndexDatabase(), noteId, { attachmentId })
  updateNoteMetadata(db, noteId, {
    attachmentId,
    attachmentReferences: merged
  })
}

export function recordDownloadedFileSize(noteId: string, fileSize: number): void {
  updateNoteCache(getIndexDatabase(), noteId, { fileSize })
  updateNoteMetadata(getDatabase(), noteId, { fileSize })
}
