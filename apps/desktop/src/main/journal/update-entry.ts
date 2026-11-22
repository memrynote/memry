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
import type { HeaderTagEdit } from '@memry/contracts/notes-api'
import { getCanonicalJournalByDate } from '@memry/domain-notes'
import { broadcastToAllWindows } from '../lib/window-broadcast'
import { createLogger } from '../lib/logger'
import { getDatabase, getIndexDatabase } from '../database'
import {
  readJournalEntry,
  composeJournalEntryWrite,
  getJournalRelativePath,
  serializeJournalEntry
} from '../vault/journal'
import { maybeCreateSignificantSnapshot } from '../vault/notes'
import { syncJournalCache } from '../vault/journal-cache-sync'
import { baselineAfterWrite, landBodyEdit } from '../sync/writeback-baseline'
import { feedExternalEditToCrdt } from '../sync/crdt-external-feed'
import { applyInlineTagEdit } from '../tags/inline-tags'
import { applyHeaderTagEdit } from '../vault/frontmatter'
import { getCrdtProvider } from '../sync/crdt-provider'
import { takeWritebackTurn, writebackNow } from '../sync/crdt-writeback'
import { trackMainEvent } from '../telemetry/track'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { createJournalEntry, resolveJournalEntryId } from './create-entry'
import { enqueueJournalUpdate } from './runtime-effects'
import { getJournalEntryByDate, getNoteCacheByPath } from './store'

const logger = createLogger('Journal:Update')

/**
 * Frontmatter is written in the entry's write-back turn, so a pass never
 * writes back the frontmatter it read before it (#5472). A body update feeds
 * the doc first (`landBodyEdit`) outside the turn, since the feed can wait on
 * the store; the re-arm after a pass restores its body but not the tags or
 * properties written beside it, so those are written again in the turn
 * (#5479).
 */
export async function updateJournalEntry(input: UpdateEntryInput): Promise<JournalEntry> {
  const id = resolveJournalEntryId(input.date)
  if (input.content === undefined) {
    return takeWritebackTurn(id, async () => (await writeJournalUpdate(input)).entry)
  }
  const { entry, tagsBefore } = await writeJournalUpdate(input)
  const added = entry.tags.filter((tag) => !tagsBefore.includes(tag))
  const removed = tagsBefore.filter((tag) => !entry.tags.includes(tag))
  const tagEdit: HeaderTagEdit | undefined =
    added.length + removed.length > 0 ? { add: added, remove: removed } : undefined
  if (!tagEdit && input.properties === undefined) return entry
  await takeWritebackTurn(id, () =>
    rewriteJournalFrontmatter(input.date, tagEdit, input.properties)
  )
  return entry
}

/**
 * Writes the tag edit and `properties` over the entry's file body, when its
 * file lacks them. The edit, not the whole list, so a tags save queued ahead
 * of this turn keeps its tags.
 */
async function rewriteJournalFrontmatter(
  date: string,
  tagEdit: HeaderTagEdit | undefined,
  properties: Record<string, unknown> | undefined
): Promise<void> {
  const current = await readJournalEntry(date)
  if (!current) return
  const tags = tagEdit ? applyHeaderTagEdit(current.tags, tagEdit) : current.tags
  const { fileContent, previousFile } = await composeJournalEntryWrite(
    date,
    current.content,
    tags,
    current,
    properties ?? current.properties
  )
  if (fileContent !== previousFile) await writeJournalUpdate({ date, tags, properties })
}

/** Resolves the written entry and the tags the file held before. */
async function writeJournalUpdate(
  input: UpdateEntryInput
): Promise<{ entry: JournalEntry; tagsBefore: string[] }> {
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
    const entry = await createJournalEntry({
      date: input.date,
      content: input.content ?? '',
      tags: newTags,
      properties: input.properties
    })
    return { entry, tagsBefore: [] }
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

  const { entry, fileContent, frontmatter, previousFile, write } = await composeJournalEntryWrite(
    input.date,
    newContent,
    newTags,
    existing,
    newProperties
  )
  const cacheId = canonical?.id ?? cached?.id ?? entry.id

  // A new body goes to the doc before the file (`landBodyEdit`): an open
  // editor is bound to the entry's doc, and the watcher ignores this write, so
  // the next write-back would otherwise put the doc's older body back over it.
  // A metadata edit keeps the body the doc holds.
  const content = input.content
  const contentHash =
    content !== undefined
      ? await landBodyEdit(db, cacheId, fileContent, {
          notePath: journalPath,
          feed: () => feedExternalEditToCrdt(cacheId, content),
          write
        })
      : (await write(), baselineAfterWrite(db, cacheId, previousFile, fileContent))

  syncJournalCache(
    db,
    {
      id: cacheId,
      path: journalPath,
      fileContent,
      contentHash,
      frontmatter,
      parsedContent: entry.content,
      title: entry.date,
      createdAt: entry.createdAt,
      modifiedAt: entry.modifiedAt
    },
    { isNew: !cached }
  )
  enqueueJournalUpdate(cacheId, entry.date)

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

  return { entry: syncedEntry, tagsBefore: existing.tags }
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
