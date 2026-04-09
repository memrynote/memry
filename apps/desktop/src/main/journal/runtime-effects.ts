import { getCrdtProvider } from '../sync/crdt-provider'
import { getJournalSyncService } from '../sync/journal-sync'

export function enqueueJournalCreate(noteId: string, date: string): void {
  getJournalSyncService()?.enqueueCreate(noteId, date)
}

export function enqueueJournalUpdate(noteId: string, date: string): void {
  getJournalSyncService()?.enqueueUpdate(noteId, date)
}

export function enqueueJournalDelete(noteId: string, date: string): void {
  getJournalSyncService()?.enqueueDelete(noteId, date)
}

export function initializeJournalCrdt(noteId: string, date: string, tags: string[]): void {
  getCrdtProvider()
    ?.initForNote(noteId, { date }, tags)
    .catch(() => {})
}
