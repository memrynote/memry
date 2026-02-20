import { isNull, and, isNotNull } from 'drizzle-orm'
import { noteCache } from '@shared/db/schema/notes-cache'
import { JournalSyncPayloadSchema, type JournalSyncPayload } from '@shared/contracts/sync-payloads'
import { JournalChannels } from '@shared/ipc-channels'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { SyncQueueManager } from '../queue'
import { increment } from '../vector-clock'
import { getIndexDatabase } from '../../database/client'
import { getNoteCacheById, updateNoteCache, deleteNoteCache } from '@shared/db/queries/notes'
import {
  writeJournalEntry,
  deleteJournalEntryFile,
  readJournalEntry,
  getJournalPath,
  parseJournalEntry
} from '../../vault/journal'
import fs from 'fs'
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
    const indexDb = getIndexDatabase()
    const remoteClock = Object.keys(clock).length > 0 ? clock : (data.clock ?? {})
    const now = new Date().toISOString()

    const existing = getNoteCacheById(indexDb, itemId)

    if (existing) {
      const resolution = resolveClockConflict(existing.clock, remoteClock)
      if (resolution.action === 'skip') {
        log.info('Skipping remote journal update, local is newer', { itemId })
        return 'skipped'
      }
      if (resolution.action === 'merge') {
        log.warn('Concurrent journal edit, applying (CRDT handles merge)', { itemId })
      }

      updateNoteCache(indexDb, itemId, {
        clock: resolution.mergedClock,
        syncedAt: now,
        modifiedAt: data.modifiedAt ?? now
      })

      writeJournalEntry(
        data.date,
        data.content ?? '',
        data.tags,
        data.properties ?? undefined
      ).catch((err) => {
        log.error('Failed to write synced journal entry', { itemId, date: data.date, error: err })
      })

      ctx.emit(JournalChannels.events.ENTRY_UPDATED, { date: data.date, source: 'sync' })
      return resolution.action === 'merge' ? 'conflict' : 'applied'
    }

    writeJournalEntry(data.date, data.content ?? '', data.tags, data.properties ?? undefined)
      .then(() => {
        const entry = readJournalEntry(data.date)
        return entry
      })
      .then((entry) => {
        if (entry) {
          updateNoteCache(indexDb, entry.id, {
            clock: remoteClock,
            syncedAt: now
          })
        }
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
    const indexDb = getIndexDatabase()
    const existing = getNoteCacheById(indexDb, itemId)
    if (!existing) return 'skipped'

    if (clock && existing.clock) {
      const resolution = resolveClockConflict(existing.clock, clock)
      if (resolution.action === 'skip' || resolution.action === 'merge') {
        log.info('Skipping remote journal delete, local has unseen changes', { itemId })
        return 'skipped'
      }
    }

    if (existing.date) {
      deleteJournalEntryFile(existing.date).catch((err) => {
        log.error('Failed to delete synced journal file', { itemId, error: err })
      })
    }

    deleteNoteCache(indexDb, itemId)
    ctx.emit(JournalChannels.events.ENTRY_DELETED, {
      date: existing.date,
      source: 'sync'
    })
    return 'applied'
  },

  fetchLocal(_db: DrizzleDb, itemId: string): Record<string, unknown> | undefined {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, itemId)
    if (!cached || !cached.date) return undefined
    return cached as unknown as Record<string, unknown>
  },

  buildPushPayload(
    _db: DrizzleDb,
    itemId: string,
    _deviceId: string,
    operation: string
  ): string | null {
    const indexDb = getIndexDatabase()
    const cached = getNoteCacheById(indexDb, itemId)
    if (!cached || !cached.date) return null

    let content: string | null = null
    let tags: string[] = []
    let properties: Record<string, unknown> | null = null
    const filePath = getJournalPath(cached.date)
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      const parsed = parseJournalEntry(raw, cached.date)
      content = operation === 'create' ? parsed.content : null
      tags = parsed.frontmatter.tags ?? []
      if (parsed.frontmatter.properties) {
        properties = parsed.frontmatter.properties as Record<string, unknown>
      }
    } catch {
      log.warn('Could not read journal file for push payload', {
        noteId: cached.id,
        date: cached.date
      })
    }

    return JSON.stringify({
      date: cached.date,
      content,
      tags,
      properties,
      clock: cached.clock ?? {},
      createdAt: cached.createdAt,
      modifiedAt: cached.modifiedAt
    })
  },

  seedUnclocked(_db: DrizzleDb, deviceId: string, queue: SyncQueueManager): number {
    const indexDb = getIndexDatabase()
    const items = indexDb
      .select()
      .from(noteCache)
      .where(and(isNull(noteCache.clock), isNotNull(noteCache.date)))
      .all()

    for (const item of items) {
      const clock = increment({}, deviceId)
      updateNoteCache(indexDb, item.id, { clock })
      queue.enqueue({
        type: 'journal',
        itemId: item.id,
        operation: 'create',
        payload: JSON.stringify({
          date: item.date!,
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
