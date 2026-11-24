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
import {
  writeJournalEntryWithContent,
  getJournalRelativePath,
  readJournalEntry
} from '../vault/journal'
import { syncJournalCache } from '../vault/journal-cache-sync'
import { baselineAfterWrite } from '../sync/writeback-baseline'
import { holdFlushUntil } from '../sync/crdt-writeback'
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
  return findStoredJournalEntry(date)?.id ?? generateJournalId(date)
}

/**
 * The stored row for `date`'s entry, canonical (data.db) first, then the index
 * cache. Its id and timestamps are the entry's real identity; the file alone
 * carries neither (a parsed file defaults both timestamps to "now").
 */
export function findStoredJournalEntry(
  date: string
): { id: string; createdAt: string; modifiedAt: string } | undefined {
  const db = getIndexDatabase()
  const canonical = getCanonicalJournalByDate(getDatabase(), date)
  if (canonical) return canonical
  return getJournalEntryByDate(db, date) ?? getNoteCacheByPath(db, getJournalRelativePath(date))
}

export async function createJournalEntry(input: CreateJournalEntryInput): Promise<JournalEntry> {
  const created = await writeJournalEntryCreate(input)
  await finishJournalEntryCreate(created)
  return created.entry
}

/** A written create and its sync enqueue, which `finishJournalEntryCreate` awaits. */
export interface WrittenJournalCreate {
  entry: JournalEntry
  queued: Promise<void>
}

/**
 * The create's file write and index cache row: file I/O and index writes
 * only, so a caller can run it in the entry's write-back turn. It starts the
 * sync enqueue and holds the write-back flush on it, so a quit right after the
 * create queues it while the sync runtime still runs. The caller then runs
 * `finishJournalEntryCreate` after the turn.
 */
export async function writeJournalEntryCreate(
  input: CreateJournalEntryInput
): Promise<WrittenJournalCreate> {
  const db = getIndexDatabase()
  const journalPath = getJournalRelativePath(input.date)
  // Read the cache row before the write, so `isNew` reflects whether the entry
  // existed beforehand rather than what the write just produced.
  const cached = getJournalEntryByDate(db, input.date) ?? getNoteCacheByPath(db, journalPath)
  const cacheId = resolveJournalEntryId(input.date)

  const { entry, fileContent, frontmatter, previousFile } = await writeJournalEntryWithContent(
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
      // The day file may already exist (an ipc create over it, a NotePlan
      // import, a journal-day merge); its baseline stays unless only the
      // frontmatter changed.
      contentHash: baselineAfterWrite(db, cacheId, previousFile, fileContent),
      frontmatter,
      parsedContent: entry.content,
      title: entry.date,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt
    },
    { isNew: !cached }
  )
  const created = cacheId === entry.id ? entry : { ...entry, id: cacheId }
  const queued = queueJournalCreate(created)
  holdFlushUntil(queued)
  return { entry: created, queued }
}

/** Waits on the projection lane, never on the CRDT store. */
async function queueJournalCreate(entry: JournalEntry): Promise<void> {
  await flushProjectionEvents()
  enqueueJournalCreate(entry.id, entry.date)
}

/**
 * Waits for the sync enqueue, seeds the doc and tells the windows. The seed
 * waits on the CRDT store, so this never runs in a write-back turn: the quit
 * flush awaits every turn (#5475). The windows get the entry as its file holds
 * it now: a tags save of the day that landed since the create already sent
 * its `ENTRY_UPDATED`, and the created event must not put the older tags back.
 */
export async function finishJournalEntryCreate({
  entry,
  queued
}: WrittenJournalCreate): Promise<void> {
  await queued
  await initializeJournalCrdt(entry.id, entry.date, entry.tags)
  const current = await readJournalEntry(entry.date)
  if (!current) return
  broadcastToAllWindows(JournalChannels.events.ENTRY_CREATED, {
    date: entry.date,
    entry: { ...current, id: entry.id, createdAt: entry.createdAt }
  })
}
