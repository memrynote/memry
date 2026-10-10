/**
 * Journal entry property writes.
 *
 * @module journal/properties
 */

import { getDatabase, getIndexDatabase } from '../database'
import {
  readJournalEntry,
  writeJournalEntryWithContent,
  getJournalRelativePath
} from '../vault/journal'
import { getCanonicalJournalByDate } from '@memry/domain-notes'
import { getJournalEntryByDate } from '../notes/store'
import { syncJournalCache } from '../vault/journal-cache-sync'
import { queueNoteWrite } from '../vault/note-write'

/**
 * Property writes of one journal entry run one at a time, so a patch reads
 * the file after every earlier write instead of overwriting it.
 */
const queueJournalWrite = <T>(date: string, write: () => Promise<T>): Promise<T> =>
  queueNoteWrite(`journal:${date}`, write)

/** Replaces a journal entry's properties with `properties`. */
export function updateJournalProperties(
  date: string,
  properties: Record<string, unknown>
): Promise<void> {
  return queueJournalWrite(date, () => writeProperties(date, properties))
}

/** Sets only the given keys on the record the file holds; a null value removes its key. */
export function patchJournalProperties(
  date: string,
  values: Record<string, unknown>
): Promise<void> {
  return queueJournalWrite(date, async () => {
    const record = (await readJournalEntry(date))?.properties ?? {}
    for (const [name, value] of Object.entries(values)) {
      if (value === null) delete record[name]
      else record[name] = value
    }
    await writeProperties(date, record)
  })
}

async function writeProperties(date: string, properties: Record<string, unknown>): Promise<void> {
  const existing = await readJournalEntry(date)
  if (!existing) {
    throw new Error(`Journal entry not found: ${date}`)
  }

  // Write entry with updated properties (preserving content and tags)
  const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
    date,
    existing.content,
    existing.tags,
    existing,
    properties
  )

  // Sync to cache
  const db = getIndexDatabase()
  const journalPath = getJournalRelativePath(date)
  const canonical = getCanonicalJournalByDate(getDatabase(), date)
  const cached = getJournalEntryByDate(db, date)
  const noteId = canonical?.id ?? cached?.id ?? entry.id

  syncJournalCache(
    db,
    {
      id: noteId,
      path: journalPath,
      fileContent,
      frontmatter,
      parsedContent: entry.content,
      title: entry.date,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt
    },
    { isNew: false }
  )
}
