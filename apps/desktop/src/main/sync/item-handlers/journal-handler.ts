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
  buildJournalEntryWrite
} from '../../vault/journal'
import { syncNoteToCache, deleteNoteFromCache } from '../../vault/note-sync'
import { getCrdtProvider } from '../crdt-provider'
import { writeSyncedVaultFile } from '../bulk-apply'
import { flushProjectionEvents } from '../../projections'
import { createLogger } from '../../lib/logger'
import { BaseItemHandler } from '@memry/sync-client/item-handlers/base-handler'
import type { ApplyContext, ApplyResult, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const log = createLogger('JournalHandler')

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

    let mergedClock = remoteClock
    let result: ApplyResult = 'applied'
    if (existing) {
      const resolution = this.resolveClock(existing.clock, remoteClock)
      if (resolution.action === 'skip') {
        log.info('Skipping remote journal update, local is newer', { itemId })
        return 'skipped'
      }
      if (resolution.action === 'merge') {
        log.warn('Concurrent journal edit, applying (CRDT handles merge)', { itemId })
        result = 'conflict'
      }
      mergedClock = resolution.mergedClock
    }

    // Everything below stays synchronous: it runs inside the pull's page
    // transaction (#2284).
    const { absolutePath, entry, fileContent, frontmatter } = buildJournalEntryWrite(
      date,
      data.content,
      data.tags,
      data.properties ?? undefined
    )
    const path = getJournalRelativePath(entry.date)
    const modifiedAt = existing ? (data.modifiedAt ?? entry.modifiedAt) : entry.modifiedAt

    saveCanonicalNote(ctx.db, {
      id: itemId,
      path,
      title: entry.date,
      journalDate: entry.date,
      clock: mergedClock,
      syncedAt: now,
      createdAt: entry.createdAt,
      modifiedAt,
      properties: data.properties
    })
    syncNoteToCache(
      indexDb,
      {
        id: itemId,
        path,
        fileContent,
        frontmatter,
        parsedContent: entry.content,
        title: entry.date,
        createdAt: entry.createdAt,
        modifiedAt
      },
      { isNew: !existing }
    )
    writeSyncedVaultFile(absolutePath, fileContent)
    void flushProjectionEvents()

    ctx.emit(
      existing ? JournalChannels.events.ENTRY_UPDATED : JournalChannels.events.ENTRY_CREATED,
      {
        date,
        source: 'sync'
      }
    )
    return result
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
