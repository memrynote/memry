import { getCrdtProvider } from '../sync/crdt-provider'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from '../sync/local-mutations'

export function enqueueJournalCreate(noteId: string, date: string): void {
  enqueueLocalSyncCreate('journal', noteId, date)
}

export function enqueueJournalUpdate(noteId: string, date: string): void {
  enqueueLocalSyncUpdate('journal', noteId, date)
}

export function enqueueJournalDelete(noteId: string, date: string): void {
  enqueueLocalSyncDelete('journal', noteId, date)
}

export function initializeJournalCrdt(noteId: string, date: string, tags: string[]): void {
  getCrdtProvider()
    ?.initForNote(noteId, { date }, tags)
    .catch(() => {})
}
