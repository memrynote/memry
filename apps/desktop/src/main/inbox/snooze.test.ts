/**
 * Inbox Snooze Service Tests
 *
 * Tests for snoozing inbox items to resurface them at a later time,
 * including scheduler functionality.
 *
 * @module inbox/snooze.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  snoozeItem,
  unsnoozeItem,
  getSnoozedItems,
  getDueSnoozeItems,
  startSnoozeScheduler,
  stopSnoozeScheduler,
  isSchedulerActive,
  checkDueItemsOnStartup,
  bulkSnoozeItems
} from './snooze'
import {
  createTestDatabase,
  cleanupTestDatabase,
  seedInboxItem,
  seedInboxItems,
  seedInboxItemTags,
  type TestDatabaseResult
} from '../../../tests/utils/test-db'

// Mock the database module
vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

vi.mock('../vault', () => ({
  getStatus: vi.fn(() => ({
    isOpen: true,
    path: '/test-vault',
    isIndexing: false,
    indexProgress: 0,
    error: null
  }))
}))

// Create a mock send function that persists across calls
const mockSend = vi.fn()

// Mock BrowserWindow to capture events
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        webContents: {
          send: mockSend
        }
      }
    ])
  }
}))

// Mock the attachments module
vi.mock('./attachments', () => ({
  resolveAttachmentUrl: vi.fn((path) => (path ? `memry-file://${path}` : null))
}))

import { getDatabase } from '../database'

describe('Inbox Snooze Service', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    mockSend.mockClear()
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopSnoozeScheduler()
    cleanupTestDatabase(testDb)
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  // ==========================================================================
  // T410: snoozeItem and unsnoozeItem
  // ==========================================================================
  describe('snoozeItem', () => {
    it('should snooze an item until specified time', () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const result = snoozeItem({
        itemId,
        snoozeUntil: futureDate.toISOString()
      })

      expect(result.success).toBe(true)
      expect(result.item).toBeDefined()
      expect(result.item?.snoozedUntil).toBeDefined()
    })

    it('should store snooze reason when provided', () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const result = snoozeItem({
        itemId,
        snoozeUntil: futureDate.toISOString(),
        reason: 'Wait for response'
      })

      expect(result.success).toBe(true)
      expect(result.item?.snoozeReason).toBe('Wait for response')
    })

    it('should fail when item does not exist', () => {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const result = snoozeItem({
        itemId: 'nonexistent',
        snoozeUntil: futureDate.toISOString()
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should fail when snooze time is in the past', () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 1)

      const result = snoozeItem({
        itemId,
        snoozeUntil: pastDate.toISOString()
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('future')
    })

    it('should fail when item is already filed', () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item',
        filedAt: new Date().toISOString()
      })

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const result = snoozeItem({
        itemId,
        snoozeUntil: futureDate.toISOString()
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('filed')
    })

    it('should fail with invalid date format', () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const result = snoozeItem({
        itemId,
        snoozeUntil: 'invalid-date'
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid')
    })

    it('should emit SNOOZED event', () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      snoozeItem({
        itemId,
        snoozeUntil: futureDate.toISOString()
      })

      expect(mockSend).toHaveBeenCalledWith(
        'inbox:snoozed',
        expect.objectContaining({
          id: itemId
        })
      )
    })
  })

  describe('unsnoozeItem', () => {
    it('should unsnooze a snoozed item', () => {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item',
        snoozedUntil: futureDate.toISOString(),
        snoozeReason: 'Some reason'
      })

      const result = unsnoozeItem(itemId)

      expect(result.success).toBe(true)
      expect(result.item?.snoozedUntil).toBeNull()
      expect(result.item?.snoozeReason).toBeNull()
    })

    it('should fail when item does not exist', () => {
      const result = unsnoozeItem('nonexistent')

      expect(result.success).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should fail when item is not snoozed', () => {
      const itemId = seedInboxItem(testDb.db, {
        id: 'item-1',
        title: 'Test Item'
      })

      const result = unsnoozeItem(itemId)

      expect(result.success).toBe(false)
      expect(result.error).toContain('not snoozed')
    })
  })

  // ==========================================================================
  // T411: getSnoozedItems and getDueSnoozeItems
  // ==========================================================================
  describe('getSnoozedItems', () => {
    it('should return empty array when no snoozed items', () => {
      seedInboxItem(testDb.db, { id: 'item-1', title: 'Test' })

      expect(getSnoozedItems()).toEqual([])
    })

    it('should return all snoozed items ordered by snooze time', () => {
      const date1 = new Date()
      date1.setDate(date1.getDate() + 1)

      const date2 = new Date()
      date2.setDate(date2.getDate() + 2)

      seedInboxItems(testDb.db, [
        { id: 'item-later', snoozedUntil: date2.toISOString(), title: 'Later' },
        { id: 'item-sooner', snoozedUntil: date1.toISOString(), title: 'Sooner' },
        { id: 'item-not-snoozed', title: 'Not snoozed' }
      ])

      const snoozed = getSnoozedItems()
      expect(snoozed).toHaveLength(2)
      expect(snoozed[0].id).toBe('item-sooner')
      expect(snoozed[1].id).toBe('item-later')
    })

    it('should exclude filed items', () => {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      seedInboxItems(testDb.db, [
        { id: 'snoozed-unfiled', snoozedUntil: futureDate.toISOString(), title: 'Unfiled' },
        {
          id: 'snoozed-filed',
          snoozedUntil: futureDate.toISOString(),
          filedAt: new Date().toISOString(),
          title: 'Filed'
        }
      ])

      const snoozed = getSnoozedItems()
      expect(snoozed).toHaveLength(1)
      expect(snoozed[0].id).toBe('snoozed-unfiled')
    })

    it('should include tags for each item', () => {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const itemId = seedInboxItem(testDb.db, {
        id: 'item-with-tags',
        snoozedUntil: futureDate.toISOString(),
        title: 'With Tags'
      })
      seedInboxItemTags(testDb.db, itemId, ['tag1', 'tag2'])

      const snoozed = getSnoozedItems()
      expect(snoozed[0].tags).toContain('tag1')
      expect(snoozed[0].tags).toContain('tag2')
    })
  })

  describe('getDueSnoozeItems', () => {
    it('should return empty array when no due items', () => {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      seedInboxItem(testDb.db, {
        id: 'item-1',
        snoozedUntil: futureDate.toISOString(),
        title: 'Future'
      })

      expect(getDueSnoozeItems()).toEqual([])
    })

    it('should return items whose snooze time has passed', () => {
      const pastDate = new Date()
      pastDate.setMinutes(pastDate.getMinutes() - 5)

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      seedInboxItems(testDb.db, [
        { id: 'due-item', snoozedUntil: pastDate.toISOString(), title: 'Due' },
        { id: 'future-item', snoozedUntil: futureDate.toISOString(), title: 'Future' }
      ])

      const due = getDueSnoozeItems()
      expect(due).toHaveLength(1)
      expect(due[0].id).toBe('due-item')
    })

    it('should exclude filed items', () => {
      const pastDate = new Date()
      pastDate.setMinutes(pastDate.getMinutes() - 5)

      seedInboxItems(testDb.db, [
        { id: 'due-unfiled', snoozedUntil: pastDate.toISOString(), title: 'Unfiled' },
        {
          id: 'due-filed',
          snoozedUntil: pastDate.toISOString(),
          filedAt: new Date().toISOString(),
          title: 'Filed'
        }
      ])

      const due = getDueSnoozeItems()
      expect(due).toHaveLength(1)
      expect(due[0].id).toBe('due-unfiled')
    })
  })

  // ==========================================================================
  // T412: bulkSnoozeItems
  // ==========================================================================
  describe('bulkSnoozeItems', () => {
    it('should snooze multiple items at once', () => {
      seedInboxItems(testDb.db, [
        { id: 'item-1', title: 'Item 1' },
        { id: 'item-2', title: 'Item 2' },
        { id: 'item-3', title: 'Item 3' }
      ])

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const result = bulkSnoozeItems(['item-1', 'item-2', 'item-3'], futureDate.toISOString())

      expect(result.success).toBe(true)
      expect(result.processedCount).toBe(3)
      expect(result.errors).toHaveLength(0)
    })

    it('should apply reason to all items', () => {
      seedInboxItems(testDb.db, [
        { id: 'item-1', title: 'Item 1' },
        { id: 'item-2', title: 'Item 2' }
      ])

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      bulkSnoozeItems(['item-1', 'item-2'], futureDate.toISOString(), 'Bulk reason')

      const snoozed = getSnoozedItems()
      expect(snoozed).toHaveLength(2)
      snoozed.forEach((item) => {
        expect(item.snoozeReason).toBe('Bulk reason')
      })
    })

    it('should report partial success with errors', () => {
      seedInboxItems(testDb.db, [
        { id: 'item-1', title: 'Item 1' },
        { id: 'item-2', title: 'Item 2', filedAt: new Date().toISOString() } // Already filed
      ])

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      const result = bulkSnoozeItems(['item-1', 'item-2', 'nonexistent'], futureDate.toISOString())

      expect(result.success).toBe(false)
      expect(result.processedCount).toBe(1)
      expect(result.errors).toHaveLength(2)
    })
  })

  // ==========================================================================
  // T413: checkDueItemsOnStartup
  // ==========================================================================
  describe('checkDueItemsOnStartup', () => {
    it('should process items that became due while app was closed', () => {
      const pastDate = new Date()
      pastDate.setMinutes(pastDate.getMinutes() - 30)

      seedInboxItems(testDb.db, [
        { id: 'due-1', snoozedUntil: pastDate.toISOString(), title: 'Due 1' },
        { id: 'due-2', snoozedUntil: pastDate.toISOString(), title: 'Due 2' }
      ])

      checkDueItemsOnStartup()

      // Items should be unsnoozed
      const snoozed = getSnoozedItems()
      expect(snoozed).toHaveLength(0)
    })

    it('should emit SNOOZE_DUE event', () => {
      const pastDate = new Date()
      pastDate.setMinutes(pastDate.getMinutes() - 30)

      seedInboxItem(testDb.db, {
        id: 'due-item',
        snoozedUntil: pastDate.toISOString(),
        title: 'Due'
      })

      checkDueItemsOnStartup()

      expect(mockSend).toHaveBeenCalledWith(
        'inbox:snooze-due',
        expect.objectContaining({
          count: 1
        })
      )
    })
  })

  // ==========================================================================
  // T414: Scheduler (startSnoozeScheduler, stopSnoozeScheduler)
  // ==========================================================================
  describe('Snooze Scheduler', () => {
    it('should start and track scheduler state', () => {
      expect(isSchedulerActive()).toBe(false)

      startSnoozeScheduler()

      expect(isSchedulerActive()).toBe(true)
    })

    it('should not start duplicate schedulers', () => {
      startSnoozeScheduler()
      startSnoozeScheduler()

      expect(isSchedulerActive()).toBe(true)
      // Should not throw or create multiple intervals
    })

    it('should stop scheduler', () => {
      startSnoozeScheduler()
      expect(isSchedulerActive()).toBe(true)

      stopSnoozeScheduler()
      expect(isSchedulerActive()).toBe(false)
    })

    it('should process due items on start', () => {
      const pastDate = new Date()
      pastDate.setMinutes(pastDate.getMinutes() - 5)

      seedInboxItem(testDb.db, {
        id: 'due-item',
        snoozedUntil: pastDate.toISOString(),
        title: 'Due'
      })

      startSnoozeScheduler()

      // Due item should be processed immediately
      expect(mockSend).toHaveBeenCalledWith('inbox:snooze-due', expect.anything())
    })

    it('should process due items every minute', () => {
      startSnoozeScheduler()

      // Clear any initial calls
      mockSend.mockClear()

      // Seed a due item
      const pastDate = new Date()
      pastDate.setMinutes(pastDate.getMinutes() - 5)

      seedInboxItem(testDb.db, {
        id: 'due-item',
        snoozedUntil: pastDate.toISOString(),
        title: 'Due'
      })

      // Advance time by 1 minute
      vi.advanceTimersByTime(60 * 1000)

      expect(mockSend).toHaveBeenCalledWith('inbox:snooze-due', expect.anything())
    })

    it('should handle errors gracefully in scheduler', () => {
      startSnoozeScheduler()

      // Make database throw
      vi.mocked(getDatabase).mockImplementation(() => {
        throw new Error('Database error')
      })

      // Should not throw when processing due items
      expect(() => vi.advanceTimersByTime(60 * 1000)).not.toThrow()
    })
  })
})
