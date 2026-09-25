import fs from 'fs'
import { and, isNotNull, isNull } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { JournalSyncPayloadSchema, type JournalSyncPayload } from '@memry/contracts/sync-payloads'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import { increment } from '@memry/sync-client/vector-clock'
import { getIndexDatabase } from '../../database/client'
import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import { saveCanonicalNote } from '@memry/domain-notes'
import {
  deleteJournalEntryFile,
  extractJournalProperties,
  getJournalPath,
  getJournalRelativePath,
  parseJournalEntry,
  readJournalEntry,
  writeJournalEntryWithContent
} from '../../vault/journal'
import { syncNoteToCache, deleteNoteFromCache } from '../../vault/note-sync'
import { getCrdtProvider } from '../crdt-provider'
import { flushProjectionEvents } from '../../projections'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('JournalHandler')

/**
 * Writes a remote journal record to its vault file without costing the body.
 *
 * The body is a CRDT document (chapter 12 §12.2); a record carries `content`
 * only on create, and `null` on every update. Writing `content ?? ''` emptied
 * the file whenever another device changed only tags or properties, or when a
 * create with `content: ''` landed after the CRDT write-back had already put
 * the body in the file. The Y.Doc kept the text, but the file, the index and
 * the heatmap lost it until the next body edit. An empty or missing `content`
 * now keeps the body the file already holds; a non-empty one is written as
 * before (a create seeded from a template).
 */
async function writeSyncedJournal(
  date: string,
  data: JournalSyncPayload
): Promise<Awaited<ReturnType<typeof writeJournalEntryWithContent>>> {
  const existing = data.content ? null : await readJournalEntry(date)
  const content = data.content ? data.content : (existing?.content ?? '')
  return writeJournalEntryWithContent(
    date,
    content,
    data.tags,
    existing,
    data.properties ?? undefined
  )
}

class JournalHandler extends BaseItemHandler<JournalSyncPayload> {
  readonly type = 'journal' as const
  readonly schema = JournalSyncPayloadSchema

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: JournalSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    // `date` is optional in JournalSyncPayloadSchema only so a delete tombstone
    // can leave it out (see sync-payloads.ts and journal-sync.buildDeletePayload).
    // An upsert without it has no day to write to, so keep rejecting it here —
    // this is the same outcome the required field used to produce, just with a
    // clearer log line than a generic schema validation failure.
    const { date } = data
    if (!date) {
      log.warn('Skipping remote journal upsert with no date', { itemId })
      return 'skipped'
    }

    const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
    const now = utcNow()
    const existing = getNoteMetadataById(ctx.db, itemId)
    const indexDb = getIndexDatabase()

    if (existing) {
      const resolution = this.resolveClock(existing.clock, remoteClock)
      if (resolution.action === 'skip') {
        log.info('Skipping remote journal update, local is newer', { itemId })
        return 'skipped'
      }
      if (resolution.action === 'merge') {
        log.warn('Concurrent journal edit, applying (CRDT handles merge)', { itemId })
      }

      writeSyncedJournal(date, data)
        .then(async ({ entry, fileContent, frontmatter }) => {
          saveCanonicalNote(ctx.db, {
            id: itemId,
            path: getJournalRelativePath(entry.date),
            title: entry.date,
            journalDate: entry.date,
            clock: resolution.mergedClock,
            syncedAt: now,
            createdAt: entry.createdAt,
            modifiedAt: data.modifiedAt ?? entry.modifiedAt,
            properties: data.properties
          })

          syncNoteToCache(
            indexDb,
            {
              id: itemId,
              path: getJournalRelativePath(entry.date),
              fileContent,
              frontmatter,
              parsedContent: entry.content,
              title: entry.date,
              createdAt: entry.createdAt,
              modifiedAt: data.modifiedAt ?? entry.modifiedAt
            },
            { isNew: false }
          )
          void flushProjectionEvents()
        })
        .catch((err) => {
          log.error('Failed to write synced journal entry', { itemId, date, error: err })
        })

      ctx.emit(JournalChannels.events.ENTRY_UPDATED, { date, source: 'sync' })
      return resolution.action === 'merge' ? 'conflict' : 'applied'
    }

    writeSyncedJournal(date, data)
      .then(async ({ entry, fileContent, frontmatter }) => {
        saveCanonicalNote(ctx.db, {
          id: itemId,
          path: getJournalRelativePath(entry.date),
          title: entry.date,
          journalDate: entry.date,
          clock: remoteClock,
          syncedAt: now,
          createdAt: entry.createdAt,
          modifiedAt: entry.modifiedAt,
          properties: data.properties
        })

        syncNoteToCache(
          indexDb,
          {
            id: itemId,
            path: getJournalRelativePath(entry.date),
            fileContent,
            frontmatter,
            parsedContent: entry.content,
            title: entry.date,
            createdAt: entry.createdAt,
            modifiedAt: entry.modifiedAt
          },
          { isNew: true }
        )
        void flushProjectionEvents()

        ctx.emit(JournalChannels.events.ENTRY_CREATED, { date, source: 'sync' })
      })
      .catch((err) => {
        log.error('Failed to write new synced journal entry', {
          itemId,
          date,
          error: err
        })
      })

    return 'applied'
  }

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const indexDb = getIndexDatabase()
    const existing = getNoteMetadataById(ctx.db, itemId)
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = this.resolveDeleteClock(existing.clock, clock)
      if (resolution.skip) {
        log.info('Skipping remote journal delete, local is ahead of the tombstone', { itemId })
        return 'skipped'
      }
    }

    // Floated for the same reason as `noteHandler.applyDelete`: this runs per
    // item inside a pull batch and the ordering-critical half of `purge` is
    // synchronous anyway.
    void getCrdtProvider()
      .purge(itemId)
      .catch((err) => {
        log.error('Failed to purge the CRDT doc of a remotely deleted journal', {
          itemId,
          error: err
        })
      })

    if (existing.journalDate) {
      deleteJournalEntryFile(existing.journalDate).catch((err) => {
        log.error('Failed to delete synced journal file', { itemId, error: err })
      })
    }

    deleteNoteFromCache(indexDb, itemId)
    void flushProjectionEvents()
    ctx.emit(JournalChannels.events.ENTRY_DELETED, {
      date: existing.journalDate,
      source: 'sync'
    })
    return 'applied'
  }

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    const cached = getNoteMetadataById(db, itemId)
    if (!cached || !cached.journalDate) return undefined
    return cached as unknown as Record<string, unknown>
  }

  buildPushPayload(
    db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    operation: string
  ): string | null {
    const cached = getNoteMetadataById(db, itemId)
    if (!cached || !cached.journalDate) return null

    let content: string | null = null
    let tags: string[] = []
    let properties: Record<string, unknown> | null = null
    const filePath = getJournalPath(cached.journalDate)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = parseJournalEntry(raw, cached.journalDate)
      content = operation === 'create' ? parsed.content : null
      tags = parsed.frontmatter.tags ?? []
      properties = extractJournalProperties(parsed.frontmatter) ?? null
    } catch {
      log.warn('Could not read journal file for push payload', {
        noteId: cached.id,
        date: cached.journalDate
      })
    }

    return JSON.stringify({
      date: cached.journalDate,
      content,
      tags,
      properties,
      clock: cached.clock ?? {},
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    })
  }

  seedUnclocked(db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const items = db
      .select()
      .from(noteMetadata)
      .where(and(isNull(noteMetadata.clock), isNotNull(noteMetadata.journalDate)))
      .all()

    for (const item of items) {
      const clock = increment({}, deviceId)
      updateNoteMetadata(db, item.id, { clock })
      queue.enqueue({
        type: 'journal',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({
          date: item.journalDate!,
          clock,
          createdAt: item.createdAt,
          modifiedAt: item.modifiedAt
        }),
        priority: 0
      })
    }

    return items.length
  }
}

export const journalHandler = new JournalHandler()
