import fs from 'fs'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { JournalSyncPayload } from '@shared/contracts/sync-payloads'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById, updateNoteCache } from '@shared/db/queries/notes'
import { createLogger } from '../lib/logger'
import { getJournalPath, parseJournalEntry } from '../vault/journal'

const log = createLogger('JournalSync')

interface JournalSyncDeps {
  queue: SyncQueueManager
  getDeviceId: () => string | null
}

let instance: JournalSyncService | null = null

export function initJournalSyncService(deps: JournalSyncDeps): JournalSyncService {
  instance = new JournalSyncService(deps)
  return instance
}

export function getJournalSyncService(): JournalSyncService | null {
  return instance
}

export function resetJournalSyncService(): void {
  instance = null
}

export class JournalSyncService {
  private queue: SyncQueueManager
  private getDeviceId: () => string | null

  constructor(deps: JournalSyncDeps) {
    this.queue = deps.queue
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(noteId: string, date: string): void {
    this.enqueueSnapshot(noteId, date, 'create')
  }

  enqueueUpdate(noteId: string, date: string): void {
    this.enqueueSnapshot(noteId, date, 'update')
  }

  enqueueDelete(noteId: string, date: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID, skipping journal delete enqueue')
      return
    }

    try {
      const indexDb = getIndexDatabase()
      const cached = getNoteCacheById(indexDb, noteId)
      const existingClock = ((cached?.clock as VectorClock) ?? {})
      const newClock = increment(existingClock, deviceId)

      const payload: JournalSyncPayload = {
        date,
        clock: newClock,
        createdAt: cached?.createdAt,
        modifiedAt: cached?.modifiedAt
      }

      this.queue.enqueue({
        type: 'journal',
        itemId: noteId,
        operation: 'delete',
        payload: JSON.stringify(payload),
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue journal delete', err)
    }
  }

  private enqueueSnapshot(
    noteId: string,
    date: string,
    operation: 'create' | 'update'
  ): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID, skipping journal enqueue')
      return
    }

    try {
      const indexDb = getIndexDatabase()
      const cached = getNoteCacheById(indexDb, noteId)
      if (!cached) {
        log.warn('Journal not found in cache for enqueue', { noteId, date })
        return
      }

      const existingClock = (cached.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      updateNoteCache(indexDb, noteId, { clock: newClock })

      let content: string | null = null
      let tags: string[] = []
      let properties: Record<string, unknown> | null = null
      const filePath = getJournalPath(date)
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        const parsed = parseJournalEntry(raw, date)
        content = parsed.content
        tags = parsed.frontmatter.tags ?? []
        if (parsed.frontmatter.properties) {
          properties = parsed.frontmatter.properties as Record<string, unknown>
        }
      } catch {
        log.warn('Could not read journal file for sync snapshot', { noteId, date })
      }

      const payload: JournalSyncPayload = {
        date,
        content,
        tags,
        properties,
        clock: newClock,
        createdAt: cached.createdAt,
        modifiedAt: cached.modifiedAt
      }

      this.queue.enqueue({
        type: 'journal',
        itemId: noteId,
        operation,
        payload: JSON.stringify(payload),
        priority: 0
      })
    } catch (err) {
      log.error(`Failed to enqueue journal ${operation}`, err)
    }
  }
}
