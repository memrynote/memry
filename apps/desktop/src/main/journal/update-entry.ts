/**
 * Update a journal entry, end to end, and append to one.
 *
 * Like create-entry.ts: the file write, index cache, sync queue, CRDT doc and
 * window broadcast belong together, so they live here and the IPC handler and
 * the sticky call this.
 *
 * @module journal/update-entry
 */

import { JournalChannels } from '@memry/contracts/ipc-channels'
import type { JournalEntry, UpdateEntryInput } from '@memry/contracts/journal-api'
import { getCanonicalJournalByDate } from '@memry/domain-notes'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { getDatabase, getIndexDatabase } from '../database'
import {
  readJournalEntry,
  writeJournalEntryWithContent,
  getJournalRelativePath,
  serializeJournalEntry
} from '../vault/journal'
import { maybeCreateSignificantSnapshot } from '../vault/notes'
import { syncJournalCache } from '../vault/journal-cache-sync'
import { applyInlineTagEdit } from '../tags/inline-tags'
import { getCrdtProvider } from '../sync/crdt-provider'
import { writebackNow } from '../sync/crdt-writeback'
import { trackMainEvent } from '../telemetry/track'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { createJournalEntry, resolveJournalEntryId } from './create-entry'
import { enqueueJournalUpdate, feedJournalBodyToCrdt } from './runtime-effects'
import { getJournalEntryByDate, getNoteCacheByPath } from './store'

const logger = createLogger('Journal:Update')

export async function updateJournalEntry(input: UpdateEntryInput): Promise<JournalEntry> {
  const db = getIndexDatabase()
  const dataDb = getDatabase()

  // Resolve the canonical journal identity from data.db.
  const journalPath = getJournalRelativePath(input.date)
  const cached = getJournalEntryByDate(db, input.date) ?? getNoteCacheByPath(db, journalPath)
  const canonical = getCanonicalJournalByDate(dataDb, input.date)

  const existing = await readJournalEntry(input.date)
  const givenTags = input.tags ?? existing?.tags ?? []
  const newTags = input.inlineTags
    ? applyInlineTagEdit(dataDb, givenTags, input.inlineTags)
    : givenTags
  if (!existing) {
    return createJournalEntry({
      date: input.date,
      content: input.content ?? '',
      tags: newTags,
      properties: input.properties
    })
  }

  const newContent = input.content ?? existing.content
  const newProperties = input.properties !== undefined ? input.properties : existing.properties

  // Snapshot before significant content changes (T111), under the canonical id
  // so snapshots stay attached across rebuilds.
  const entryId = canonical?.id ?? cached?.id ?? existing.id
  if (input.content !== undefined && input.content !== existing.content) {
    try {
      const snapshotFrontmatter: Parameters<typeof serializeJournalEntry>[0] = {
        date: existing.date,
        ...(existing.tags.length > 0 ? { tags: existing.tags } : {})
      }
      if (existing.properties && Object.keys(existing.properties).length > 0) {
        snapshotFrontmatter.properties = existing.properties
      }
      const currentFileContent = serializeJournalEntry(snapshotFrontmatter, existing.content)
      maybeCreateSignificantSnapshot(
        entryId,
        currentFileContent,
        existing.content,
        newContent,
        `Journal - ${input.date}`
      )
    } catch (err) {
      logger.error('Failed to create snapshot:', err)
    }
  }

  const { entry, fileContent, frontmatter } = await writeJournalEntryWithContent(
    input.date,
    newContent,
    newTags,
    existing,
    newProperties
  )
  const cacheId = canonical?.id ?? cached?.id ?? entry.id

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
  enqueueJournalUpdate(cacheId, entry.date)

  // An open editor is bound to the entry's doc (see feedJournalBodyToCrdt).
  if (input.content !== undefined) await feedJournalBodyToCrdt(cacheId, input.content)

  // The renderer caches whatever this returns (and whatever the event carries)
  // as the open entry, so both carry the cache id rather than `j<date>`.
  const syncedEntry = cacheId === entry.id ? entry : { ...entry, id: cacheId }

  broadcastToAllWindows(JournalChannels.events.ENTRY_UPDATED, {
    date: syncedEntry.date,
    entry: syncedEntry
  })

  if (shouldEmitThrottled(`journal_updated:${syncedEntry.date}`)) {
    trackMainEvent('journal_updated', {
      surface: 'journal',
      action: 'updated',
      objectType: 'journal',
      result: 'success'
    })
  }

  return syncedEntry
}

/**
 * Append `markdown` as a new paragraph at the end of `date`'s entry, creating
 * the entry when there is none.
 *
 * An editor open on the entry writes its doc to the file on a debounce, so
 * the file can trail the doc. Writing the doc out first keeps the append from
 * replacing the body with a file that misses the last keystrokes.
 */
export async function appendToJournalEntry(date: string, markdown: string): Promise<JournalEntry> {
  const text = markdown.trim()
  if (!text) throw new Error('Nothing to append')

  const doc = getCrdtProvider().getDoc(resolveJournalEntryId(date))
  if (doc) await writebackNow(resolveJournalEntryId(date), doc)

  const existing = await readJournalEntry(date)
  const head = existing?.content.replace(/\s+$/, '') ?? ''
  return updateJournalEntry({ date, content: head ? `${head}\n\n${text}` : text })
}
