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

/**
 * Update properties for a journal entry.
 * Reads the existing entry, updates only the properties, and syncs to cache.
 *
 * @param date - Journal entry date (YYYY-MM-DD)
 * @param properties - Properties to set
 */
export async function updateJournalProperties(
  date: string,
  properties: Record<string, unknown>
): Promise<void> {
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
