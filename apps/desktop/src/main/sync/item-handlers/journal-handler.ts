import fs from 'fs'
import { and, isNotNull, isNull } from 'drizzle-orm'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { JournalSyncPayloadSchema, type JournalSyncPayload } from '@memry/contracts/sync-payloads'
import { JournalChannels } from '@memry/contracts/ipc-channels'
import type { VectorClock } from '@memry/contracts/sync-api'
import { utcNow } from '@memry/shared/utc'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { getIndexDatabase } from '../../database/client'
import { getNoteMetadataById, updateNoteMetadata } from '@memry/storage-data'
import { saveCanonicalNote } from '@memry/domain-notes'
import {
  deleteJournalEntryFile,
  getJournalPath,
  getJournalRelativePath,
  parseJournalEntry,
  writeJournalEntryWithContent
} from '../../vault/journal'
import { syncNoteToCache, deleteNoteFromCache } from '../../vault/note-sync'
import { createLogger } from '../../lib/logger'
import { resolveClockConflict } from './types'
import type { SyncItemHandler, ApplyContext, ApplyResult, DrizzleDb } from './types'

const log = createLogger('JournalHandler')

export const journalHandler: SyncItemHandler<JournalSyncPayload> = {
  type: 'journal',
  schema: JournalSyncPayloadSchema,

  applyUpsert(
    ctx: ApplyContext,
    itemId: string,
    data: JournalSyncPayload,
    clock: VectorClock
  ): ApplyResult {
    const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
    const now = utcNow()
    const existing = getNoteMetadataById(ctx.db, itemId)
    const indexDb = getIndexDatabase()

    if (existing) {
      const resolution = resolveClockConflict(existing.clock, remoteClock)
      if (resolution.action === 'skip') {
        log.info('Skipping remote journal update, local is newer', { itemId })
        return 'skipped'
      }
      if (resolution.action === 'merge') {
        log.warn('Concurrent journal edit, applying (CRDT handles merge)', { itemId })
      }

      writeJournalEntryWithContent(
        data.date,
        data.content ?? '',
        data.tags,
        null,
        data.properties ?? undefined
      )
        .then(({ entry, fileContent, frontmatter }) => {
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
              parsedContent: entry.content
            },
            { isNew: false }
          )
        })
        .catch((err) => {
          log.error('Failed to write synced journal entry', { itemId, date: data.date, error: err })
        })

      ctx.emit(JournalChannels.events.ENTRY_UPDATED, { date: data.date, source: 'sync' })
      return resolution.action === 'merge' ? 'conflict' : 'applied'
    }

    writeJournalEntryWithContent(
      data.date,
      data.content ?? '',
      data.tags,
      null,
      data.properties ?? undefined
    )
      .then(({ entry, fileContent, frontmatter }) => {
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
            parsedContent: entry.content
          },
          { isNew: true }
        )

        ctx.emit(JournalChannels.events.ENTRY_CREATED, { date: data.date, source: 'sync' })
      })
      .catch((err) => {
        log.error('Failed to write new synced journal entry', {
          itemId,
          date: data.date,
          error: err
        })
      })

    return 'applied'
  },

  applyDelete(ctx: ApplyContext, itemId: string, clock?: VectorClock): 'applied' | 'skipped' {
    const existing = getNoteMetadataById(ctx.db, itemId)
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote journal delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    if (existing.journalDate) {
      deleteJournalEntryFile(existing.journalDate).catch((err) => {
        log.error('Failed to delete synced journal file', { itemId, error: err })
      })
    }

    deleteNoteFromCache(getIndexDatabase(), itemId)
    ctx.emit(JournalChannels.events.ENTRY_DELETED, {
      date: existing.journalDate,
      source: 'sync'
    })
    return 'applied'
  },

  fetchLocal(db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    const cached = getNoteMetadataById(db, itemId)
    if (!cached || !cached.journalDate) return undefined
    return cached as unknown as Record<string, unknown>
  },

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
      if (parsed.frontmatter.properties) {
        properties = parsed.frontmatter.properties as Record<string, unknown>
      }
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
  },

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
