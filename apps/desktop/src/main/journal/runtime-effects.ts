import { createLogger } from '../lib/logger'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { getCrdtProvider } from '../sync/crdt-provider'
import { feedThenRecordBaseline } from '../sync/writeback-baseline'
import type { getIndexDatabase } from '../database'
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

/** Loads the day's doc first, for the tombstone's body vector (chapter 05 §5.8, #3037). */
export async function enqueueJournalDelete(noteId: string, date: string): Promise<void> {
  await getCrdtProvider().withDocLoaded(noteId, () =>
    enqueueLocalSyncDelete('journal', noteId, date)
  )
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
 * Same as the notes update (#2646): the watcher ignores this write, so an open
 * editor bound to the entry's doc would keep the old body and write it back.
 * The baseline moves to `fileContent` once the doc holds it (#5304). The file
 * is already written, so a failed feed must not fail the save.
 */
export async function feedJournalBodyToCrdt(
  indexDb: ReturnType<typeof getIndexDatabase>,
  noteId: string,
  content: string,
  fileContent: string
): Promise<void> {
  try {
    await feedThenRecordBaseline(indexDb, noteId, fileContent, () =>
      feedExternalEditToCrdt(noteId, content)
    )
  } catch (err) {
    log.error('Could not feed the saved body to the journal CRDT doc', { noteId, error: err })
  }
}
