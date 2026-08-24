import { updateNoteMetadata } from '@memry/storage-data'
import type { MarkdownSizeClass } from '@memry/shared/markdown-class'
import { updateNoteCache } from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { attachmentEvents } from '@memry/sync-client/attachment-events'
import { getCrdtProvider } from '../sync/crdt-provider'
import { clearPendingCrdtNotes, recordPendingCrdtNotes } from '../sync/crdt-pending-notes'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate,
  removePendingNoteSyncItems
} from '../sync/local-mutations'
import { createDesktopTasksDomain } from '../tasks/domain'
import { createTasksPublisher } from '../tasks/publisher'
import { generateId } from '../lib/id'
import { createLogger } from '../lib/logger'
import { trackMainError } from '../telemetry/diagnostics'

const logger = createLogger('NoteRuntimeEffects')

export interface SyncNoteCreateOptions {
  /**
   * Defaults to note class, which is every caller that does not classify.
   *
   * A large-file-class file gets neither a CRDT doc nor a sync item. No doc,
   * because seeding one runs the BlockNote markdown parse over the whole file
   * on the main process, which is the freeze. No sync item, because the body
   * lives only in that doc — a receiving device would draw a sidebar row it
   * could never open, which is worse than drawing nothing.
   */
  sizeClass?: MarkdownSizeClass
}

export function syncNoteCreate(
  noteId: string,
  title: string,
  tags: string[],
  options?: SyncNoteCreateOptions
): void {
  if (options?.sizeClass === 'large-file') return

  enqueueLocalSyncCreate('note', noteId)

  getCrdtProvider()
    ?.initForNote(noteId, { title }, tags)
    .catch((error) => {
      // A swallowed init means the note's body never enters CRDT sync.
      logger.error('CRDT init failed for new note', { noteId, error })
      trackMainError('notes', 'crdt_init_for_note', error)
    })
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

/**
 * Flip a note between "syncs" and "never leaves this device".
 *
 * Both feeds have to be told, and they are told differently. The record feed is
 * pull-based — `buildNotePushPayload` and `seedUnclockedNotes` re-read
 * `localOnly` every time they run — so it only needs its queue cleaned up here.
 * The CRDT body feed is push-based: `onDocUpdate` fires per keystroke and reads
 * a flag the provider cached when it opened the doc, so that flag has to be
 * corrected in place or the note keeps pushing its body until it is closed and
 * reopened.
 *
 * The two branches are deliberately symmetric about the durable pending-CRDT
 * store, because turning the flag off is where a body could otherwise go
 * missing for good. Nothing else pushes an existing note's body: the push
 * coordinator's snapshot is gated on `operation === 'create'` and this raises an
 * `update`, `buildSnapshotPayload` sends `content: null` for an update, and the
 * vault sweep only pulls. So a note whose body stopped going up while it was
 * local-only would sync its metadata again and leave its body frozen at the
 * state the server last saw — divergence, and worse than the leak this closes.
 * Recording it hands the whole doc to `drainPendingCrdtNotes`, which pulls and
 * merges the server's state before pushing, and keeps the id until that push
 * actually lands.
 */
export function setNoteLocalOnlyState(noteId: string, localOnly: boolean): void {
  updateNoteMetadata(getDatabase(), noteId, {
    localOnly,
    syncPolicy: localOnly ? 'local-only' : 'sync'
  })
  // localOnly is sidecar-only state — keep the index cache in step too
  updateNoteCache(getIndexDatabase(), noteId, { localOnly })

  // After both writes, so a doc opened concurrently resolves the same value.
  getCrdtProvider()?.setNoteLocalOnly(noteId, localOnly)

  if (localOnly) {
    removePendingNoteSyncItems(noteId)
    // The CRDT-side twin of the line above: a backlog owed to the server is not
    // owed any more. Nothing is lost by dropping it — the updates themselves
    // stay in the local store, and clearing the flag re-records the note, whose
    // replay pushes full doc state and therefore supersedes them anyway.
    clearPendingCrdtNotes([noteId])
  } else {
    enqueueLocalSyncUpdate('note', noteId)
    recordPendingCrdtNotes([noteId])
  }
}
