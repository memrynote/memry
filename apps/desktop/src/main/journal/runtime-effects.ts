import { createLogger } from '../lib/logger'
import { getCrdtProvider } from '../sync/crdt-provider'
import { getDatabase } from '../database'
import { deleteDocLocally } from '../sync/local-doc-delete'
import { forgetOwedJournalDayMerge } from '../sync/journal-day-merge-key'
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

/**
 * Raises the day's tombstone and purges its doc (`deleteDocLocally`). A held
 * day's owed merge goes first: a crash after it leaves the day deleted here,
 * never merged back (§1.9.1).
 */
export async function enqueueJournalDelete(noteId: string, date: string): Promise<void> {
  await deleteDocLocally(noteId, () => {
    forgetOwedJournalDayMerge(getDatabase(), noteId)
    enqueueLocalSyncDelete('journal', noteId, date)
  })
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
