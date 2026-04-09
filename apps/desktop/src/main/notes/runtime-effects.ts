import { updateNoteMetadata } from '@memry/storage-data'
import { getDatabase } from '../database'
import { attachmentEvents } from '../sync/attachment-events'
import { getCrdtProvider } from '../sync/crdt-provider'
import { getNoteSyncService } from '../sync/note-sync'

export function syncNoteCreate(noteId: string, title: string, tags: string[]): void {
  getNoteSyncService()?.enqueueCreate(noteId)
  getCrdtProvider()
    ?.initForNote(noteId, { title }, tags)
    .catch(() => {})
}

export function syncNoteUpdate(noteId: string, title?: string): void {
  getNoteSyncService()?.enqueueUpdate(noteId)
  if (title) {
    getCrdtProvider()?.updateMeta(noteId, { title })
  }
}

export function syncNoteDelete(noteId: string): void {
  getNoteSyncService()?.enqueueDelete(noteId)
}

export function emitNoteAttachmentSaved(noteId: string, diskPath: string): void {
  attachmentEvents.emitSaved({ noteId, diskPath })
}

export function setNoteLocalOnlyState(noteId: string, localOnly: boolean): void {
  updateNoteMetadata(getDatabase(), noteId, {
    localOnly,
    syncPolicy: localOnly ? 'local-only' : 'sync'
  })

  const syncService = getNoteSyncService()
  if (localOnly) {
    syncService?.removeQueueItems(noteId)
  } else {
    syncService?.enqueueUpdate(noteId)
  }
}
