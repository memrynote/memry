/**
 * Create a journal entry, end to end.
 *
 * Writing a journal entry is more than a file write: the index cache has to
 * learn about it, projections have to flush, the sync queue and the CRDT doc
 * have to be seeded, and open windows have to be told. That sequence used to
 * live inline inside the IPC handlers, which made it unreachable from
 * anywhere else — importers included. It lives here now, and the handlers
 * call it.
 *
 * @module journal/create-entry
 */

import { JournalChannels } from '@memry/contracts/ipc-channels'
import { generateJournalId, type JournalEntry } from '@memry/contracts/journal-api'
import { getCanonicalJournalByDate } from '@memry/domain-notes'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { getDatabase, getIndexDatabase } from '../database'
import { writeJournalEntryWithContent, getJournalRelativePath } from '../vault/journal'
import { syncJournalCache } from '../vault/journal-cache-sync'
import { flushProjectionEvents } from '../projections'
import { enqueueJournalCreate, initializeJournalCrdt } from './runtime-effects'
import { getJournalEntryByDate, getNoteCacheByPath } from './store'

export interface CreateJournalEntryInput {
  /** ISO `YYYY-MM-DD`. */
  date: string
  content: string
  tags?: string[]
  properties?: Record<string, unknown>
}

/**
 * The id a journal entry for `date` has (or will have): the canonical row in
 * data.db wins, then the index cache, then the deterministic id derived from
 * the date. Exported so a caller that needs the id *before* the entry exists —
 * an importer creating tasks with `sourceNoteId` — gets the same one the
 * create path will settle on.
 */
export function resolveJournalEntryId(date: string): string {
  const db = getIndexDatabase()
  const dataDb = getDatabase()
  const journalPath = getJournalRelativePath(date)
  const cached = getJournalEntryByDate(db, date) ?? getNoteCacheByPath(db, journalPath)
  const canonical = getCanonicalJournalByDate(dataDb, date)
  return canonical?.id ?? cached?.id ?? generateJournalId(date)
}

export async function createJournalEntry(input: CreateJournalEntryInput): Promise<JournalEntry> {
  const db = getIndexDatabase()
  const journalPath = getJournalRelativePath(input.date)
  // Read the cache row before the write, so `isNew` reflects whether the entry
  // existed beforehand rather than what the write just produced.
  const cached = getJournalEntryByDate(db, input.date) ?? getNoteCacheByPath(db, journalPath)
  const cacheId = resolveJournalEntryId(input.date)

  const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
    input.date,
    input.content,
    input.tags,
    null,
    input.properties
  )

  syncJournalCache(
    db,
    {
      id: cacheId,
      path: journalPath,
      fileContent,
      frontmatter,
      parsedContent: entry.content,
      title: entry.date,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt
    },
    { isNew: !cached }
  )
  await flushProjectionEvents()

  const syncedEntry = cacheId === entry.id ? entry : { ...entry, id: cacheId }
  enqueueJournalCreate(cacheId, syncedEntry.date)
  await initializeJournalCrdt(cacheId, syncedEntry.date, syncedEntry.tags)

  broadcastToAllWindows(JournalChannels.events.ENTRY_CREATED, {
    date: syncedEntry.date,
    entry: syncedEntry
  })

  return syncedEntry
}
