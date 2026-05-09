import { createLogger } from '../lib/logger'
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
