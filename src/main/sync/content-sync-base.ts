import type { SyncItemType, VectorClock } from '@shared/contracts/sync-api'
import type { NoteCache } from '@shared/db/schema/notes-cache'
import type { SyncQueueManager } from './queue'
import { increment } from './vector-clock'
import { getIndexDatabase } from '../database/client'
import { getNoteCacheById, updateNoteCache } from '@shared/db/queries/notes'
import type Logger from 'electron-log'

export interface ContentSyncDeps {
  queue: SyncQueueManager
  getDeviceId: () => string | null
}

export abstract class ContentSyncService<TPayload> {
  protected queue: SyncQueueManager
  protected getDeviceId: () => string | null
  protected abstract readonly log: Logger.LogFunctions
  abstract readonly itemType: SyncItemType

  constructor(deps: ContentSyncDeps) {
    this.queue = deps.queue
    this.getDeviceId = deps.getDeviceId
  }

  protected abstract buildSnapshotPayload(
    cached: NoteCache,
    clock: VectorClock,
    operation: 'create' | 'update',
    ...extra: string[]
  ): TPayload

  protected abstract buildDeletePayload(
    cached: NoteCache | undefined,
    clock: VectorClock,
    ...extra: string[]
  ): TPayload | null

  enqueueCreate(itemId: string, ...extra: string[]): void {
    this.enqueueSnapshot(itemId, 'create', ...extra)
  }

  enqueueUpdate(itemId: string, ...extra: string[]): void {
    this.enqueueSnapshot(itemId, 'update', ...extra)
  }

  enqueueDelete(itemId: string, ...extra: string[]): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      this.log.warn(`No device ID, skipping ${this.itemType} delete enqueue`)
      return
    }

    try {
      const indexDb = getIndexDatabase()
      const cached = getNoteCacheById(indexDb, itemId)

      if (cached?.localOnly) {
        this.log.debug(`Skipping ${this.itemType} delete enqueue: localOnly`, { itemId })
        return
      }

      const existingClock = (cached?.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      const payload = this.buildDeletePayload(cached, newClock, ...extra)
      if (payload === null) return

      this.queue.enqueue({
        type: this.itemType,
        itemId,
        operation: 'delete',
        payload: JSON.stringify(payload),
        priority: 0
      })
    } catch (err) {
      this.log.error(`Failed to enqueue ${this.itemType} delete`, err)
    }
  }

  private enqueueSnapshot(
    itemId: string,
    operation: 'create' | 'update',
    ...extra: string[]
  ): void {
    const deviceId = this.getDeviceId()
    if (!deviceId) {
      this.log.warn(`No device ID, skipping ${this.itemType} enqueue`)
      return
    }

    try {
      const indexDb = getIndexDatabase()
      const cached = getNoteCacheById(indexDb, itemId)
      if (!cached) {
        this.log.warn(`${this.itemType} not found in cache for enqueue`, { itemId })
        return
      }

      if (cached.localOnly) {
        this.log.debug(`Skipping ${this.itemType} enqueue: localOnly`, { itemId })
        return
      }

      const existingClock = (cached.clock as VectorClock) ?? {}
      const newClock = increment(existingClock, deviceId)

      updateNoteCache(indexDb, itemId, { clock: newClock })

      const payload = this.buildSnapshotPayload(cached, newClock, operation, ...extra)

      this.queue.enqueue({
        type: this.itemType,
        itemId,
        operation,
        payload: JSON.stringify(payload),
        priority: 0
      })
    } catch (err) {
      this.log.error(`Failed to enqueue ${this.itemType} ${operation}`, err)
    }
  }
}
