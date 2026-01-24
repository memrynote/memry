/**
 * Sync Queue Manager
 *
 * Manages an in-memory queue of pending sync items with SQLite persistence.
 *
 * @module sync/queue
 */

import { v4 as uuidv4 } from 'uuid'
import { BrowserWindow } from 'electron'
import { eq, asc } from 'drizzle-orm'
import { TypedEmitter } from './typed-emitter'
import { getDatabase } from '../database/client'
import { syncQueue } from '@shared/db/schema/sync-schema'
import type { NewSyncQueueItem } from '@shared/db/schema/sync-schema'
import type { SyncOperation, SyncItemType } from '@shared/contracts/sync-api'

export interface QueueItem {
  id: string
  type: SyncItemType
  itemId: string
  operation: SyncOperation
  payload: string
  priority: number
  attempts: number
  lastAttempt: string | null
  errorMessage: string | null
  createdAt: string
}

export interface QueueEvents extends Record<string, unknown[]> {
  'sync:queue-changed': [count: number]
  'sync:item-added': [item: QueueItem]
  'sync:item-removed': [id: string]
  'sync:item-updated': [item: QueueItem]
  'sync:queue-cleared': [payload: { itemCount: number; duration: number }]
}

export class SyncQueue extends TypedEmitter<QueueEvents> {
  private items: Map<string, QueueItem> = new Map()
  private initialized = false
  private lastCount = 0
  private queueStartAt: number | null = null

  async initialize(): Promise<void> {
    if (this.initialized) return

    await this.loadFromDatabase()
    this.initialized = true
  }

  private async loadFromDatabase(): Promise<void> {
    const db = getDatabase()
    const rows = await db.select().from(syncQueue).orderBy(asc(syncQueue.createdAt))

    this.items.clear()
    for (const row of rows) {
      const item: QueueItem = {
        id: row.id,
        type: row.type as SyncItemType,
        itemId: row.itemId,
        operation: row.operation as SyncOperation,
        payload: row.payload,
        priority: row.priority ?? 0,
        attempts: row.attempts ?? 0,
        lastAttempt: row.lastAttempt,
        errorMessage: row.errorMessage,
        createdAt: row.createdAt
      }
      this.items.set(row.id, item)
    }

    if (this.items.size > 0) {
      const oldest = this.getSorted()[0]
      this.queueStartAt = oldest ? new Date(oldest.createdAt).getTime() : Date.now()
    } else {
      this.queueStartAt = null
    }
  }

  /**
   * Add an item to the queue or update if it already exists.
   * Deduplicates by (type, itemId) - if an item with the same type and itemId exists,
   * it will be updated with the new payload and operation.
   *
   * @param type - The sync item type
   * @param itemId - The unique ID of the item
   * @param operation - The sync operation (create, update, delete)
   * @param payload - JSON stringified payload data
   * @param priority - Queue priority (higher = processed first)
   * @returns The queue item (new or updated)
   */
  async add(
    type: SyncItemType,
    itemId: string,
    operation: SyncOperation,
    payload: string,
    priority: number = 0
  ): Promise<QueueItem> {
    const existingItems = this.getByItemId(itemId)
    const existing = existingItems.find((i) => i.type === type)

    if (existing) {
      existing.operation = operation
      existing.payload = payload
      existing.priority = Math.max(existing.priority, priority)
      existing.errorMessage = null

      const db = getDatabase()
      await db
        .update(syncQueue)
        .set({
          operation,
          payload,
          priority: existing.priority,
          errorMessage: null
        })
        .where(eq(syncQueue.id, existing.id))

      this.emit('sync:item-updated', existing)
      this.broadcastToWindows('sync:item-updated', existing)
      return existing
    }

    const id = uuidv4()
    const createdAt = new Date().toISOString()

    const item: QueueItem = {
      id,
      type,
      itemId,
      operation,
      payload,
      priority,
      attempts: 0,
      lastAttempt: null,
      errorMessage: null,
      createdAt
    }

    const dbItem: NewSyncQueueItem = {
      id,
      type,
      itemId,
      operation,
      payload,
      priority,
      attempts: 0,
      lastAttempt: null,
      errorMessage: null,
      createdAt
    }

    const db = getDatabase()
    await db.insert(syncQueue).values(dbItem)

    this.items.set(id, item)
    if (this.items.size === 1) {
      this.queueStartAt = Date.now()
    }
    this.emitQueueChanged()
    this.emit('sync:item-added', item)
    this.broadcastToWindows('sync:item-added', item)

    return item
  }

  /**
   * Remove an item from the queue.
   *
   * @param id - The queue item ID to remove
   * @returns true if item was removed, false if not found
   */
  async remove(id: string): Promise<boolean> {
    if (!this.items.has(id)) {
      return false
    }

    const db = getDatabase()
    await db.delete(syncQueue).where(eq(syncQueue.id, id))

    this.items.delete(id)
    this.emitQueueChanged()
    this.emit('sync:item-removed', id)
    this.broadcastToWindows('sync:item-removed', id)

    return true
  }

  /**
   * Update attempt count and error message for a queue item.
   *
   * @param id - The queue item ID
   * @param errorMessage - Optional error message from the last attempt
   * @returns The updated item or null if not found
   */
  async updateAttempt(id: string, errorMessage: string | null = null): Promise<QueueItem | null> {
    const item = this.items.get(id)
    if (!item) return null

    const now = new Date().toISOString()
    item.attempts += 1
    item.lastAttempt = now
    item.errorMessage = errorMessage

    const db = getDatabase()
    await db
      .update(syncQueue)
      .set({
        attempts: item.attempts,
        lastAttempt: now,
        errorMessage
      })
      .where(eq(syncQueue.id, id))

    this.emit('sync:item-updated', item)
    this.broadcastToWindows('sync:item-updated', item)

    return item
  }

  /**
   * Get the highest priority item without removing it.
   */
  peek(): QueueItem | null {
    if (this.items.size === 0) return null

    const sorted = this.getSorted()
    return sorted[0] ?? null
  }

  /**
   * Get all items sorted by priority (descending) then createdAt (ascending).
   */
  getAll(): QueueItem[] {
    return this.getSorted()
  }

  /**
   * Get all queue items for a specific item ID.
   */
  getByItemId(itemId: string): QueueItem[] {
    return Array.from(this.items.values()).filter((item) => item.itemId === itemId)
  }

  /**
   * Get a specific queue item by its ID.
   */
  get(id: string): QueueItem | null {
    return this.items.get(id) ?? null
  }

  /**
   * Get the number of items in the queue.
   */
  size(): number {
    return this.items.size
  }

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean {
    return this.items.size === 0
  }

  /**
   * Remove all items from the queue.
   */
  async clear(): Promise<void> {
    const db = getDatabase()
    await db.delete(syncQueue)

    this.items.clear()
    this.queueStartAt = null
    this.emitQueueChanged()
  }

  private getSorted(): QueueItem[] {
    return Array.from(this.items.values()).sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority
      }
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
  }

  private emitQueueChanged(): void {
    const count = this.items.size
    this.emit('sync:queue-changed', count)
    this.broadcastToWindows('sync:queue-changed', count)

    if (count === 0 && this.lastCount > 0) {
      const duration =
        this.queueStartAt !== null ? Math.max(0, Date.now() - this.queueStartAt) : 0
      const payload = { itemCount: this.lastCount, duration }
      this.emit('sync:queue-cleared', payload)
      this.broadcastToWindows('sync:queue-cleared', payload)
      this.queueStartAt = null
    }

    this.lastCount = count
  }

  private broadcastToWindows(channel: string, data: unknown): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, data)
      }
    }
  }
}

let syncQueueInstance: SyncQueue | null = null

export function getSyncQueue(): SyncQueue {
  if (!syncQueueInstance) {
    syncQueueInstance = new SyncQueue()
  }
  return syncQueueInstance
}

export async function initSyncQueue(): Promise<SyncQueue> {
  const queue = getSyncQueue()
  await queue.initialize()
  return queue
}
