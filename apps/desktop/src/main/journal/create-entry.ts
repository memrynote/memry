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
import { createLogger } from '../lib/logger'
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

const logger = createLogger('Journal:Create')

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
  return finishJournalEntryCreate(await writeJournalEntryCreate(input))
}

/** A written create and its sync enqueue, which `finishJournalEntryCreate` awaits. */
export interface WrittenJournalCreate {
  entry: JournalEntry
  queued: Promise<void>
}

/**
 * The create's file write and index cache row: file I/O and index writes
 * only, so a caller can run it in the entry's write-back turn. It holds the
 * write-back flush from before the write until the create is on the sync
 * queue, so a quit that starts during the write, in a turn or not, queues the
 * create while the sync runtime still runs. The caller then runs
 * `finishJournalEntryCreate` after the turn.
 */
export function writeJournalEntryCreate(
  input: CreateJournalEntryInput
): Promise<WrittenJournalCreate> {
  const written = writeJournalEntryFile(input)
  const queued = written.then(queueJournalCreate)
  holdFlushUntil(queued, `journal create ${input.date}`)
  return written.then((entry) => ({ entry, queued }))
}

async function writeJournalEntryFile(input: CreateJournalEntryInput): Promise<JournalEntry> {
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
  return cacheId === entry.id ? entry : { ...entry, id: cacheId }
}

/** Waits on the projection lane, never on the CRDT store. */
async function queueJournalCreate(entry: JournalEntry): Promise<void> {
  await flushProjectionEvents()
  enqueueJournalCreate(entry.id, entry.date)
}

/**
 * Waits for the sync enqueue, seeds the doc and tells the windows. The seed
 * waits on the CRDT store, so this never runs in a write-back turn: the quit
 * flush awaits every turn (#5475). It returns the entry as its file holds it
 * now, and the windows get the same: a tags save or a day merge that landed
 * since the create already wrote its tags, and neither the created event nor
 * the reply the creating window caches may put the older tags back. A re-read
 * that fails costs the event, not the create, which is written and queued:
 * the caller gets the entry it wrote.
 */
export async function finishJournalEntryCreate({
  entry,
  queued
}: WrittenJournalCreate): Promise<JournalEntry> {
  await queued
  await initializeJournalCrdt(entry.id, entry.date, entry.tags)
  let current: JournalEntry | null
  try {
    current = await readJournalEntry(entry.date)
  } catch (error) {
    logger.warn('Created journal entry could not be re-read; windows not told', {
      date: entry.date,
      error
    })
    return entry
  }
  if (!current) return entry
  const settled = { ...current, id: entry.id, createdAt: entry.createdAt }
  broadcastToAllWindows(JournalChannels.events.ENTRY_CREATED, { date: entry.date, entry: settled })
  return settled
}
