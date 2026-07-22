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
import { createDesktopTasksDomain } from '../tasks/domain'
import { createTasksPublisher } from '../tasks/publisher'
import { generateId } from '../lib/id'

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

/**
 * After a note is deleted, drop any project links pointing at it and clear any
 * project's home note that referenced it — re-enqueuing those projects for sync
 * (the project payload carries links + homeNoteId). Prevents orphan link rows
 * and dangling home_note_id (spec §4 "Cleanup rules").
 */
export async function cleanupProjectLinksForDeletedNote(noteId: string): Promise<void> {
  const domain = createDesktopTasksDomain(getDatabase(), createTasksPublisher(), generateId)
  await domain.cleanupProjectLinksForDeletedNote(noteId)
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
