/**
 * Inbox Stats Module Tests
 *
 * Tests for stale item detection, inbox statistics tracking,
 * and capture patterns analysis.
 *
 * @module main/inbox/stats.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getStaleThreshold,
  setStaleThreshold,
  isStale,
  getStaleCutoffDate,
  getStaleItemIds,
  countStaleItems,
  incrementCaptureCount,
  incrementProcessedCount,
  incrementArchivedCount,
  getTodayStats,
  getTodayActivity,
  getAverageTimeToProcess
} from './stats'
import {
  createTestDatabase,
  cleanupTestDatabase,
  seedInboxItem,
  seedInboxItems,
  type TestDatabaseResult
} from '../../../tests/utils/test-db'

// Mock the database module
vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

import { getDatabase } from '../database'

describe('Inbox Stats Module', () => {
  let testDb: TestDatabaseResult

  beforeEach(() => {
    testDb = createTestDatabase()
    vi.mocked(getDatabase).mockReturnValue(testDb.db)
    // Reset stale threshold to default
    setStaleThreshold(7)
  })

  afterEach(() => {
    cleanupTestDatabase(testDb)
    vi.clearAllMocks()
  })

  // ==========================================================================
  // T403: Stale Threshold Management
  // ==========================================================================
  describe('Stale Threshold Management', () => {
    it('should return default stale threshold of 7 days', () => {
      expect(getStaleThreshold()).toBe(7)
    })

    it('should allow setting stale threshold', () => {
      setStaleThreshold(14)
      expect(getStaleThreshold()).toBe(14)
    })

    it('should clamp threshold to minimum of 1 day', () => {
      setStaleThreshold(0)
      expect(getStaleThreshold()).toBe(1)

      setStaleThreshold(-5)
      expect(getStaleThreshold()).toBe(1)
    })

    it('should clamp threshold to maximum of 365 days', () => {
      setStaleThreshold(500)
      expect(getStaleThreshold()).toBe(365)
    })
  })

  // ==========================================================================
  // T404: isStale and getStaleCutoffDate
  // ==========================================================================
  describe('isStale', () => {
    it('should return true for dates older than threshold', () => {
      setStaleThreshold(7)
      const oldDate = new Date()
      oldDate.setDate(oldDate.getDate() - 10)
      expect(isStale(oldDate.toISOString())).toBe(true)
    })

    it('should return false for dates within threshold', () => {
      setStaleThreshold(7)
      const recentDate = new Date()
      recentDate.setDate(recentDate.getDate() - 3)
      expect(isStale(recentDate.toISOString())).toBe(false)
    })

    it('should return false for dates exactly at threshold', () => {
      setStaleThreshold(7)
      const exactDate = new Date()
      exactDate.setDate(exactDate.getDate() - 7)
      // At exactly 7 days, should not be stale (threshold is >7)
      expect(isStale(exactDate.toISOString())).toBe(false)
    })

    it('should return true for dates just past threshold', () => {
      setStaleThreshold(7)
      const pastDate = new Date()
      pastDate.setDate(pastDate.getDate() - 8)
      expect(isStale(pastDate.toISOString())).toBe(true)
    })
  })

  describe('getStaleCutoffDate', () => {
    it('should return ISO date string representing stale cutoff', () => {
      setStaleThreshold(7)
      const cutoff = getStaleCutoffDate()

      expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      const cutoffDate = new Date(cutoff)
      const expectedDate = new Date()
      expectedDate.setDate(expectedDate.getDate() - 7)

      // Allow 1 second tolerance for test execution time
      expect(Math.abs(cutoffDate.getTime() - expectedDate.getTime())).toBeLessThan(1000)
    })

    it('should adjust based on current threshold', () => {
      setStaleThreshold(14)
      const cutoff = getStaleCutoffDate()

      const cutoffDate = new Date(cutoff)
      const expectedDate = new Date()
      expectedDate.setDate(expectedDate.getDate() - 14)

      expect(Math.abs(cutoffDate.getTime() - expectedDate.getTime())).toBeLessThan(1000)
    })
  })

  // ==========================================================================
  // T405: getStaleItemIds and countStaleItems
  // ==========================================================================
  describe('getStaleItemIds', () => {
    it('should return empty array when no stale items exist', () => {
      // Seed recent items
      seedInboxItem(testDb.db, {
        id: 'recent-item',
        createdAt: new Date().toISOString()
      })

      expect(getStaleItemIds()).toEqual([])
    })

    it('should return IDs of stale items', () => {
      const staleDate = new Date()
      staleDate.setDate(staleDate.getDate() - 10)

      seedInboxItems(testDb.db, [
        { id: 'stale-1', createdAt: staleDate.toISOString() },
        { id: 'stale-2', createdAt: staleDate.toISOString() },
        { id: 'recent', createdAt: new Date().toISOString() }
      ])

      const staleIds = getStaleItemIds()
      expect(staleIds).toHaveLength(2)
      expect(staleIds).toContain('stale-1')
      expect(staleIds).toContain('stale-2')
      expect(staleIds).not.toContain('recent')
    })

    it('should exclude filed items from stale list', () => {
      const staleDate = new Date()
      staleDate.setDate(staleDate.getDate() - 10)

      seedInboxItems(testDb.db, [
        { id: 'stale-unfiled', createdAt: staleDate.toISOString() },
        {
          id: 'stale-filed',
          createdAt: staleDate.toISOString(),
          filedAt: new Date().toISOString()
        }
      ])

      const staleIds = getStaleItemIds()
      expect(staleIds).toEqual(['stale-unfiled'])
    })

    it('should exclude snoozed items from stale list', () => {
      const staleDate = new Date()
      staleDate.setDate(staleDate.getDate() - 10)

      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + 1)

      seedInboxItems(testDb.db, [
        { id: 'stale-not-snoozed', createdAt: staleDate.toISOString() },
        {
          id: 'stale-snoozed',
          createdAt: staleDate.toISOString(),
          snoozedUntil: futureDate.toISOString()
        }
      ])

      const staleIds = getStaleItemIds()
      expect(staleIds).toEqual(['stale-not-snoozed'])
    })

    it('should exclude archived items from stale list', () => {
      const staleDate = new Date()
      staleDate.setDate(staleDate.getDate() - 10)

      seedInboxItems(testDb.db, [
        { id: 'stale-active', createdAt: staleDate.toISOString() },
        {
          id: 'stale-archived',
          createdAt: staleDate.toISOString(),
          archivedAt: new Date().toISOString()
        }
      ])

      const staleIds = getStaleItemIds()
      expect(staleIds).toEqual(['stale-active'])
    })

    it('should return empty array when database is not available', () => {
      vi.mocked(getDatabase).mockImplementation(() => {
        throw new Error('No database')
      })

      expect(getStaleItemIds()).toEqual([])
    })
  })

  describe('countStaleItems', () => {
    it('should return 0 when no stale items exist', () => {
      seedInboxItem(testDb.db, {
        id: 'recent-item',
        createdAt: new Date().toISOString()
      })

      expect(countStaleItems()).toBe(0)
    })

    it('should return count of stale items', () => {
      const staleDate = new Date()
      staleDate.setDate(staleDate.getDate() - 10)

      seedInboxItems(testDb.db, [
        { id: 'stale-1', createdAt: staleDate.toISOString() },
        { id: 'stale-2', createdAt: staleDate.toISOString() },
        { id: 'stale-3', createdAt: staleDate.toISOString() },
        { id: 'recent', createdAt: new Date().toISOString() }
      ])

      expect(countStaleItems()).toBe(3)
    })

    it('should return 0 when database is not available', () => {
      vi.mocked(getDatabase).mockImplementation(() => {
        throw new Error('No database')
      })

      expect(countStaleItems()).toBe(0)
    })
  })

  // ==========================================================================
  // T406: Stat Tracking (incrementCaptureCount, incrementProcessedCount)
  // ==========================================================================
  describe('incrementCaptureCount', () => {
    it('should create stats record for today if not exists', () => {
      incrementCaptureCount('link')

      const stats = getTodayStats()
      expect(stats).not.toBeNull()
      expect(stats?.captureCountLink).toBe(1)
    })

    it('should increment correct column for each item type', () => {
      incrementCaptureCount('link')
      incrementCaptureCount('note')
      incrementCaptureCount('image')
      incrementCaptureCount('voice')
      incrementCaptureCount('clip')
      incrementCaptureCount('pdf')
      incrementCaptureCount('social')

      const stats = getTodayStats()
      expect(stats?.captureCountLink).toBe(1)
      expect(stats?.captureCountNote).toBe(1)
      expect(stats?.captureCountImage).toBe(1)
      expect(stats?.captureCountVoice).toBe(1)
      expect(stats?.captureCountClip).toBe(1)
      expect(stats?.captureCountPdf).toBe(1)
      expect(stats?.captureCountSocial).toBe(1)
    })

    it('should increment same column multiple times', () => {
      incrementCaptureCount('link')
      incrementCaptureCount('link')
      incrementCaptureCount('link')

      const stats = getTodayStats()
      expect(stats?.captureCountLink).toBe(3)
    })

    it('should handle unknown item types gracefully', () => {
      // Should not throw
      incrementCaptureCount('unknown')

      const stats = getTodayStats()
      // Stats may or may not be created depending on implementation
      // The key is that it doesn't throw
    })
  })

  describe('incrementProcessedCount', () => {
    it('should increment processed count', () => {
      incrementProcessedCount()

      const stats = getTodayStats()
      expect(stats?.processedCount).toBe(1)
    })

    it('should increment by specified amount', () => {
      incrementProcessedCount(5)

      const stats = getTodayStats()
      expect(stats?.processedCount).toBe(5)
    })

    it('should accumulate multiple increments', () => {
      incrementProcessedCount(2)
      incrementProcessedCount(3)

      const stats = getTodayStats()
      expect(stats?.processedCount).toBe(5)
    })
  })

  describe('incrementArchivedCount', () => {
    it('should increment archived count', () => {
      incrementArchivedCount()

      const stats = getTodayStats()
      expect(stats?.archivedCount).toBe(1)
    })

    it('should increment by specified amount', () => {
      incrementArchivedCount(3)

      const stats = getTodayStats()
      expect(stats?.archivedCount).toBe(3)
    })
  })

  // ==========================================================================
  // T407: getTodayStats and getTodayActivity
  // ==========================================================================
  describe('getTodayStats', () => {
    it('should return null when no stats exist for today', () => {
      expect(getTodayStats()).toBeNull()
    })

    it('should return stats when they exist', () => {
      incrementCaptureCount('link')

      const stats = getTodayStats()
      expect(stats).not.toBeNull()
      expect(stats?.date).toBe(new Date().toISOString().split('T')[0])
    })

    it('should return null when database is not available', () => {
      vi.mocked(getDatabase).mockImplementation(() => {
        throw new Error('No database')
      })

      expect(getTodayStats()).toBeNull()
    })
  })

  describe('getTodayActivity', () => {
    it('should return zeros when no activity', () => {
      const activity = getTodayActivity()
      expect(activity.capturedToday).toBe(0)
      expect(activity.processedToday).toBe(0)
    })

    it('should sum all capture types for capturedToday', () => {
      incrementCaptureCount('link')
      incrementCaptureCount('link')
      incrementCaptureCount('note')
      incrementCaptureCount('image')

      const activity = getTodayActivity()
      expect(activity.capturedToday).toBe(4)
    })

    it('should return correct processedToday count', () => {
      incrementProcessedCount(5)

      const activity = getTodayActivity()
      expect(activity.processedToday).toBe(5)
    })

    it('should return both counts correctly', () => {
      incrementCaptureCount('link')
      incrementCaptureCount('note')
      incrementProcessedCount(3)

      const activity = getTodayActivity()
      expect(activity.capturedToday).toBe(2)
      expect(activity.processedToday).toBe(3)
    })
  })

  // ==========================================================================
  // T408: getAverageTimeToProcess
  // ==========================================================================
  describe('getAverageTimeToProcess', () => {
    it('should return 0 when no filed items exist', () => {
      expect(getAverageTimeToProcess()).toBe(0)
    })

    it('should calculate average time for filed items', () => {
      // Create items that were filed after different durations
      const now = new Date()
      const created1 = new Date(now.getTime() - 60 * 60 * 1000) // 1 hour ago (60 minutes)
      const filed1 = now

      const created2 = new Date(now.getTime() - 30 * 60 * 1000) // 30 minutes ago
      const filed2 = now

      seedInboxItems(testDb.db, [
        {
          id: 'item-1',
          createdAt: created1.toISOString(),
          filedAt: filed1.toISOString()
        },
        {
          id: 'item-2',
          createdAt: created2.toISOString(),
          filedAt: filed2.toISOString()
        }
      ])

      // Average of 60 and 30 minutes = 45 minutes
      const avg = getAverageTimeToProcess()
      expect(avg).toBe(45)
    })

    it('should only include items filed in last 30 days', () => {
      const now = new Date()

      // Old filed item (40 days ago)
      const oldCreated = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000)
      const oldFiled = new Date(now.getTime() - 39 * 24 * 60 * 60 * 1000)

      // Recent filed item (5 days ago, took 120 minutes)
      const recentCreated = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000)
      const recentFiled = new Date(recentCreated.getTime() + 120 * 60 * 1000)

      seedInboxItems(testDb.db, [
        {
          id: 'old-item',
          createdAt: oldCreated.toISOString(),
          filedAt: oldFiled.toISOString()
        },
        {
          id: 'recent-item',
          createdAt: recentCreated.toISOString(),
          filedAt: recentFiled.toISOString()
        }
      ])

      // Should only consider the recent item (120 minutes)
      const avg = getAverageTimeToProcess()
      expect(avg).toBe(120)
    })

    it('should return 0 when database is not available', () => {
      vi.mocked(getDatabase).mockImplementation(() => {
        throw new Error('No database')
      })

      expect(getAverageTimeToProcess()).toBe(0)
    })
  })
})
