import fs from 'fs'
import type { VectorClock } from '@shared/contracts/sync-api'
import type { NoteSyncPayload } from '@shared/contracts/sync-payloads'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById, updateNoteCache } from '@shared/db/queries/notes'
import { createLogger } from '../lib/logger'
import { toAbsolutePath } from '../vault/notes'
import { parseNote } from '../vault/frontmatter'

const log = createLogger('NoteSync')

interface NoteSyncDeps {
  queue: SyncQueueManager
  getDeviceId: () => string | null
}

let instance: NoteSyncService | null = null

export function initNoteSyncService(deps: NoteSyncDeps): NoteSyncService {
  instance = new NoteSyncService(deps)
  return instance
}

export function getNoteSyncService(): NoteSyncService | null {
  return instance
}

export function resetNoteSyncService(): void {
  instance = null
}

export class NoteSyncService {
  private queue: SyncQueueManager
  private getDeviceId: () => string | null

  constructor(deps: NoteSyncDeps) {
    this.queue = deps.queue
    this.getDeviceId = deps.getDeviceId
  }

  enqueueCreate(noteId: string): void {
    this.enqueueSnapshot(noteId, 'create')
  }

  enqueueUpdate(noteId: string): void {
    this.enqueueSnapshot(noteId, 'update')
  }

  enqueueDelete(noteId: string): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID, skipping note delete enqueue')
      return
    }

    try {
      const indexDb = getIndexDatabase()
      const cached = getNoteCacheById(indexDb, noteId)
      if (!cached) {
        log.warn('Note not found in cache for delete enqueue', { noteId })
        return
      }

      const existingClock = (cached.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      const payload: NoteSyncPayload = {
        title: cached.title,
        clock: newClock,
        createdAt: cached.createdAt,
        modifiedAt: cached.modifiedAt
      }

      this.queue.enqueue({
        type: 'note',
        itemId: noteId,
        operation: 'delete',
        payload: JSON.stringify(payload),
        priority: 0
      })
    } catch (err) {
      log.error('Failed to enqueue note delete', err)
    }
  }

  private enqueueSnapshot(noteId: string, operation: 'create' | 'update'): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      log.warn('No device ID, skipping note enqueue')
      return
    }

    try {
      const indexDb = getIndexDatabase()
      const cached = getNoteCacheById(indexDb, noteId)
      if (!cached) {
        log.warn('Note not found in cache for enqueue', { noteId })
        return
      }

      const existingClock = (cached.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      updateNoteCache(indexDb, noteId, { clock: newClock })

      let content: string | null = null
      let tags: string[] = []
      const absolutePath = toAbsolutePath(cached.path)
      try {
        const raw = fs.readFileSync(absolutePath, 'utf-8')
        const parsed = parseNote(raw)
        content = parsed.content
        tags = parsed.frontmatter.tags ?? []
      } catch {
        log.warn('Could not read note file for sync snapshot', { noteId })
      }

      const payload: NoteSyncPayload = {
        title: cached.title,
        content,
        tags,
        emoji: cached.emoji,
        fileType: cached.fileType,
        clock: newClock,
        createdAt: cached.createdAt,
        modifiedAt: cached.modifiedAt
      }

      this.queue.enqueue({
        type: 'note',
        itemId: noteId,
        operation,
        payload: JSON.stringify(payload),
        priority: 0
      })
    } catch (err) {
      log.error(`Failed to enqueue note ${operation}`, err)
    }
  }
}
