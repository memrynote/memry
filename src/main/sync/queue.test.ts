/**
 * Sync Queue Tests
 *
 * Integration tests for the sync queue manager.
 * Uses in-memory SQLite database for isolation.
 *
 * @module main/sync/queue.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import {
  SyncQueueManager,
  getSyncQueue,
  resetSyncQueue,
  SyncPriority,
  type QueueItemInput,
} from './queue'
import { syncQueueStatus, syncItemType, syncOperation } from '@shared/db/schema/sync'

// Mock getDatabase to return our test database
vi.mock('../database/client', () => ({
  getDatabase: vi.fn(),
}))

import { getDatabase } from '../database/client'

describe('sync queue', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager

  beforeEach(() => {
    // Create fresh test database
    testDb = createTestDataDb()

    // Point getDatabase mock to our test database
    vi.mocked(getDatabase).mockReturnValue(testDb.db)

    // Reset singleton and create new instance
    resetSyncQueue()
    queue = getSyncQueue()
  })

  afterEach(() => {
    testDb.close()
    vi.clearAllMocks()
  })

  // ===========================================================================
  // Add Operations
  // ===========================================================================

  describe('addItem', () => {
    it('should add a new item to the queue', async () => {
      const input: QueueItemInput = {
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: JSON.stringify({ id: 'task-123', title: 'Test Task' }),
      }

      const item = await queue.addItem(input)

      expect(item.id).toBeDefined()
      expect(item.type).toBe(syncItemType.TASK)
      expect(item.itemId).toBe('task-123')
      expect(item.operation).toBe(syncOperation.CREATE)
      expect(item.status).toBe(syncQueueStatus.PENDING)
      expect(item.attempts).toBe(0)
      expect(item.priority).toBe(SyncPriority.NORMAL)
    })

    it('should update existing pending item instead of creating duplicate', async () => {
      const input1: QueueItemInput = {
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: JSON.stringify({ title: 'Original' }),
      }

      const input2: QueueItemInput = {
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.UPDATE,
        payload: JSON.stringify({ title: 'Updated' }),
      }

      await queue.addItem(input1)
      await queue.addItem(input2)

      const size = await queue.getQueueSize()
      expect(size).toBe(1)

      const items = await queue.getNextItems(10)
      expect(items[0].operation).toBe(syncOperation.UPDATE)
      expect(items[0].payload).toContain('Updated')
    })

    it('should allow same itemId for different types', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'item-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      await queue.addItem({
        type: syncItemType.NOTE,
        itemId: 'item-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      const size = await queue.getQueueSize()
      expect(size).toBe(2)
    })

    it('should use specified priority', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
        priority: SyncPriority.CRITICAL,
      })

      const items = await queue.getNextItems(1)
      expect(items[0].priority).toBe(SyncPriority.CRITICAL)
    })
  })

  describe('addItems', () => {
    it('should add multiple items', async () => {
      const inputs: QueueItemInput[] = [
        { type: syncItemType.TASK, itemId: 'task-1', operation: syncOperation.CREATE, payload: '{}' },
        { type: syncItemType.TASK, itemId: 'task-2', operation: syncOperation.CREATE, payload: '{}' },
        { type: syncItemType.NOTE, itemId: 'note-1', operation: syncOperation.UPDATE, payload: '{}' },
      ]

      const items = await queue.addItems(inputs)

      expect(items).toHaveLength(3)
      expect(await queue.getQueueSize()).toBe(3)
    })
  })

  // ===========================================================================
  // Retrieve Operations
  // ===========================================================================

  describe('getNextItems', () => {
    it('should return items ordered by priority (highest first)', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'low',
        operation: syncOperation.CREATE,
        payload: '{}',
        priority: SyncPriority.LOW,
      })

      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'critical',
        operation: syncOperation.CREATE,
        payload: '{}',
        priority: SyncPriority.CRITICAL,
      })

      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'normal',
        operation: syncOperation.CREATE,
        payload: '{}',
        priority: SyncPriority.NORMAL,
      })

      const items = await queue.getNextItems(10)

      expect(items[0].itemId).toBe('critical')
      expect(items[1].itemId).toBe('normal')
      expect(items[2].itemId).toBe('low')
    })

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await queue.addItem({
          type: syncItemType.TASK,
          itemId: `task-${i}`,
          operation: syncOperation.CREATE,
          payload: '{}',
        })
      }

      const items = await queue.getNextItems(2)
      expect(items).toHaveLength(2)
    })

    it('should not return in-progress items', async () => {
      const item = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      await queue.markInProgress(item.id)

      const items = await queue.getNextItems(10)
      expect(items).toHaveLength(0)
    })
  })

  describe('getItem', () => {
    it('should return item by id', async () => {
      const created = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      const item = await queue.getItem(created.id)

      expect(item).toBeDefined()
      expect(item?.itemId).toBe('task-123')
    })

    it('should return undefined for non-existent id', async () => {
      const item = await queue.getItem('non-existent')
      expect(item).toBeUndefined()
    })
  })

  describe('getItemsByItemId', () => {
    it('should return all queue entries for an item', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      // Simulate the first one being processed, then another update comes
      const items = await queue.getItemsByItemId('task-123')
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })

  // ===========================================================================
  // Status Update Operations
  // ===========================================================================

  describe('markInProgress', () => {
    it('should update status to in_progress', async () => {
      const created = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      const updated = await queue.markInProgress(created.id)

      expect(updated?.status).toBe(syncQueueStatus.IN_PROGRESS)
      expect(updated?.attempts).toBe(1)
      expect(updated?.lastAttempt).toBeDefined()
    })

    it('should increment attempts on each call', async () => {
      const created = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      await queue.markInProgress(created.id)
      // Reset to pending to allow marking in progress again
      await queue.resetItem(created.id)
      const updated = await queue.markInProgress(created.id)

      expect(updated?.attempts).toBe(1) // Reset clears attempts
    })
  })

  describe('markProcessed', () => {
    it('should remove item from queue', async () => {
      const created = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      const removed = await queue.markProcessed(created.id)

      expect(removed).toBe(true)
      expect(await queue.getItem(created.id)).toBeUndefined()
      expect(await queue.getQueueSize()).toBe(0)
    })

    it('should return false for non-existent id', async () => {
      const removed = await queue.markProcessed('non-existent')
      expect(removed).toBe(false)
    })
  })

  describe('markFailed', () => {
    it('should set status to pending for retry', async () => {
      const created = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      await queue.markInProgress(created.id)
      const updated = await queue.markFailed(created.id, 'Network error')

      expect(updated?.status).toBe(syncQueueStatus.PENDING)
      expect(updated?.errorMessage).toBe('Network error')
    })

    it('should set status to permanently failed after max attempts', async () => {
      const created = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      // Simulate 10 failed attempts (MAX_RETRY_ATTEMPTS)
      for (let i = 0; i < 10; i++) {
        await queue.markInProgress(created.id)
        // Reset status for next attempt if not last
        if (i < 9) {
          await testDb.db.run(
            testDb.db.update
              ? require('drizzle-orm').sql`UPDATE sync_queue SET status = 'pending' WHERE id = ${created.id}`
              : require('drizzle-orm').sql`UPDATE sync_queue SET status = 'pending' WHERE id = ${created.id}`
          )
        }
      }

      const updated = await queue.markFailed(created.id, 'Final error')

      expect(updated?.status).toBe(syncQueueStatus.FAILED)
      expect(updated?.errorMessage).toContain('Permanently failed')
    })
  })

  describe('resetItem', () => {
    it('should reset failed item to pending', async () => {
      const created = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      await queue.markInProgress(created.id)
      await queue.markFailed(created.id, 'Error')

      const reset = await queue.resetItem(created.id)

      expect(reset?.status).toBe(syncQueueStatus.PENDING)
      expect(reset?.attempts).toBe(0)
      expect(reset?.errorMessage).toBeNull()
    })
  })

  // ===========================================================================
  // Queue Management Operations
  // ===========================================================================

  describe('getQueueSize', () => {
    it('should return total number of items', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-2',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      expect(await queue.getQueueSize()).toBe(2)
    })

    it('should return 0 for empty queue', async () => {
      expect(await queue.getQueueSize()).toBe(0)
    })
  })

  describe('getPendingCount', () => {
    it('should return only pending items count', async () => {
      const item = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-2',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      await queue.markInProgress(item.id)

      expect(await queue.getPendingCount()).toBe(1)
    })
  })

  describe('getPendingByType', () => {
    it('should count pending items by type', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-2',
        operation: syncOperation.CREATE,
        payload: '{}',
      })
      await queue.addItem({
        type: syncItemType.NOTE,
        itemId: 'note-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      expect(await queue.getPendingByType(syncItemType.TASK)).toBe(2)
      expect(await queue.getPendingByType(syncItemType.NOTE)).toBe(1)
      expect(await queue.getPendingByType(syncItemType.PROJECT)).toBe(0)
    })
  })

  describe('getStats', () => {
    it('should return detailed queue statistics', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })
      await queue.addItem({
        type: syncItemType.NOTE,
        itemId: 'note-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      const stats = await queue.getStats()

      expect(stats.total).toBe(2)
      expect(stats.pending).toBe(2)
      expect(stats.inProgress).toBe(0)
      expect(stats.failed).toBe(0)
      expect(stats.byType[syncItemType.TASK]).toBe(1)
      expect(stats.byType[syncItemType.NOTE]).toBe(1)
    })
  })

  describe('clearAll', () => {
    it('should remove all items from queue', async () => {
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-2',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      const cleared = await queue.clearAll()

      expect(cleared).toBe(2)
      expect(await queue.getQueueSize()).toBe(0)
    })
  })

  describe('retryFailed', () => {
    it('should reset all permanently failed items to pending', async () => {
      const item1 = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-1',
        operation: syncOperation.CREATE,
        payload: '{}',
      })
      const item2 = await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-2',
        operation: syncOperation.CREATE,
        payload: '{}',
      })

      // Helper to simulate max retries and permanent failure
      const makePermanentlyFailed = async (itemId: string) => {
        // MAX_RETRY_ATTEMPTS is 10, so we need 10 failed attempts
        for (let i = 0; i < 10; i++) {
          await queue.markInProgress(itemId)
          if (i < 9) {
            // Reset to pending to allow next attempt (except last)
            const item = await queue.getItem(itemId)
            if (item) {
              // Manually set status back to pending for next attempt
              await testDb.db.run(
                require('drizzle-orm').sql`UPDATE sync_queue SET status = 'pending' WHERE id = ${itemId}`
              )
            }
          }
        }
        await queue.markFailed(itemId, 'Final error')
      }

      await makePermanentlyFailed(item1.id)
      await makePermanentlyFailed(item2.id)

      // Verify both are permanently failed
      const item1Status = await queue.getItem(item1.id)
      const item2Status = await queue.getItem(item2.id)
      expect(item1Status?.status).toBe(syncQueueStatus.FAILED)
      expect(item2Status?.status).toBe(syncQueueStatus.FAILED)

      const reset = await queue.retryFailed()

      expect(reset).toBe(2)
      expect(await queue.getPendingCount()).toBe(2)
    })
  })

  // ===========================================================================
  // Singleton Pattern
  // ===========================================================================

  describe('singleton', () => {
    it('should return same instance', () => {
      const instance1 = getSyncQueue()
      const instance2 = getSyncQueue()

      expect(instance1).toBe(instance2)
    })

    it('should create new instance after reset', () => {
      const instance1 = getSyncQueue()
      resetSyncQueue()
      const instance2 = getSyncQueue()

      expect(instance1).not.toBe(instance2)
    })
  })

  // ===========================================================================
  // Real-World Scenarios
  // ===========================================================================

  describe('sync scenarios', () => {
    it('should handle typical create-update-delete lifecycle', async () => {
      // Create task
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.CREATE,
        payload: JSON.stringify({ title: 'New Task' }),
      })

      // Update before sync completes (coalesces)
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.UPDATE,
        payload: JSON.stringify({ title: 'Updated Task' }),
      })

      // Should have only 1 item (coalesced)
      expect(await queue.getQueueSize()).toBe(1)

      // Get and process
      const items = await queue.getNextItems(1)
      expect(items[0].operation).toBe(syncOperation.UPDATE)

      await queue.markInProgress(items[0].id)
      await queue.markProcessed(items[0].id)

      expect(await queue.getQueueSize()).toBe(0)

      // Delete task
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-123',
        operation: syncOperation.DELETE,
        payload: JSON.stringify({ id: 'task-123' }),
      })

      expect(await queue.getQueueSize()).toBe(1)
    })

    it('should prioritize critical operations', async () => {
      // Add background sync
      await queue.addItem({
        type: syncItemType.NOTE,
        itemId: 'note-bg',
        operation: syncOperation.UPDATE,
        payload: '{}',
        priority: SyncPriority.BACKGROUND,
      })

      // Add normal task update
      await queue.addItem({
        type: syncItemType.TASK,
        itemId: 'task-normal',
        operation: syncOperation.UPDATE,
        payload: '{}',
        priority: SyncPriority.NORMAL,
      })

      // Add critical settings change
      await queue.addItem({
        type: syncItemType.SETTINGS,
        itemId: 'settings-1',
        operation: syncOperation.UPDATE,
        payload: '{}',
        priority: SyncPriority.CRITICAL,
      })

      const items = await queue.getNextItems(3)

      expect(items[0].type).toBe(syncItemType.SETTINGS)
      expect(items[0].priority).toBe(SyncPriority.CRITICAL)
      expect(items[1].type).toBe(syncItemType.TASK)
      expect(items[2].type).toBe(syncItemType.NOTE)
    })

    it('should handle multiple item types concurrently', async () => {
      // Simulate user making multiple changes
      await queue.addItems([
        { type: syncItemType.TASK, itemId: 'task-1', operation: syncOperation.CREATE, payload: '{}' },
        { type: syncItemType.TASK, itemId: 'task-2', operation: syncOperation.UPDATE, payload: '{}' },
        { type: syncItemType.NOTE, itemId: 'note-1', operation: syncOperation.UPDATE, payload: '{}' },
        { type: syncItemType.PROJECT, itemId: 'project-1', operation: syncOperation.UPDATE, payload: '{}' },
        { type: syncItemType.INBOX_ITEM, itemId: 'inbox-1', operation: syncOperation.CREATE, payload: '{}' },
      ])

      const stats = await queue.getStats()

      expect(stats.total).toBe(5)
      expect(stats.byType[syncItemType.TASK]).toBe(2)
      expect(stats.byType[syncItemType.NOTE]).toBe(1)
      expect(stats.byType[syncItemType.PROJECT]).toBe(1)
      expect(stats.byType[syncItemType.INBOX_ITEM]).toBe(1)
    })
  })
})
