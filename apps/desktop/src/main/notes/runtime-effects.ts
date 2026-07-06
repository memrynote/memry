import { updateNoteMetadata } from '@memry/storage-data'
import { updateNoteCache } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { attachmentEvents } from '../sync/attachment-events'
import { getCrdtProvider } from '../sync/crdt-provider'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate,
  removePendingNoteSyncItems
} from '../sync/local-mutations'

export function syncNoteCreate(noteId: string, title: string, tags: string[]): void {
  enqueueLocalSyncCreate('note', noteId)
  getCrdtProvider()
    ?.initForNote(noteId, { title }, tags)
    .catch(() => {})
}

export function syncNoteUpdate(noteId: string, title?: string): void {
  enqueueLocalSyncUpdate('note', noteId)
  if (title) {
    getCrdtProvider()?.updateMeta(noteId, { title })
  }
}

export function syncNoteDelete(noteId: string): void {
  enqueueLocalSyncDelete('note', noteId)
}

export function emitNoteAttachmentSaved(noteId: string, diskPath: string): void {
  attachmentEvents.emitSaved({ noteId, diskPath })
}

export function setNoteLocalOnlyState(noteId: string, localOnly: boolean): void {
  updateNoteMetadata(getDatabase(), noteId, {
    localOnly,
    syncPolicy: localOnly ? 'local-only' : 'sync'
  })
  // localOnly is sidecar-only state — keep the index cache in step too
  updateNoteCache(getIndexDatabase(), noteId, { localOnly })

  if (localOnly) {
    removePendingNoteSyncItems(noteId)
  } else {
    enqueueLocalSyncUpdate('note', noteId)
  }
}
