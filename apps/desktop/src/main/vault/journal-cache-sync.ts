import { deleteNoteFromCache, syncNoteToCache } from './note-sync'

type JournalCacheDb = Parameters<typeof syncNoteToCache>[0]
type JournalCacheInput = Parameters<typeof syncNoteToCache>[1]
type JournalCacheOptions = Parameters<typeof syncNoteToCache>[2]

export function syncJournalCache(
  db: JournalCacheDb,
  note: JournalCacheInput,
  options: JournalCacheOptions
): void {
  syncNoteToCache(db, note, options)
}

export function deleteJournalCache(
  db: Parameters<typeof deleteNoteFromCache>[0],
  noteId: string
): void {
  deleteNoteFromCache(db, noteId)
}
