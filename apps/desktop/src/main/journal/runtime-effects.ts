import { createLogger } from '../lib/logger'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { getCrdtProvider } from '../sync/crdt-provider'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

const log = createLogger('JournalRuntimeEffects')

export function enqueueJournalCreate(noteId: string, date: string): void {
  enqueueLocalSyncCreate('journal', noteId, date)
}

export function enqueueJournalUpdate(noteId: string, date: string): void {
  enqueueLocalSyncUpdate('journal', noteId, date)
}

export function enqueueJournalDelete(noteId: string, date: string): void {
  enqueueLocalSyncDelete('journal', noteId, date)
}

export async function initializeJournalCrdt(
  noteId: string,
  date: string,
  tags: string[]
): Promise<void> {
  try {
    await getCrdtProvider().initForNote(noteId, { date }, tags)
  } catch (err) {
    log.error('initializeJournalCrdt failed', { noteId, error: err })
  }
}

/**
 * Same as the notes update (#2646): the cache already holds the new hash, so
 * the watcher never feeds this edit, and an open editor bound to the entry's
 * doc would keep the old body and write it back. The file is already written,
 * so a failed feed must not fail the save.
 */
export async function feedJournalBodyToCrdt(noteId: string, content: string): Promise<void> {
  try {
    await feedExternalEditToCrdt(noteId, content)
  } catch (err) {
    log.error('Could not feed the saved body to the journal CRDT doc', { noteId, error: err })
  }
}
