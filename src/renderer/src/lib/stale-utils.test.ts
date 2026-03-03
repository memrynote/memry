import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { InboxItem, InboxItemListItem } from '@/types'
import {
  STALE_THRESHOLD_DAYS,
  getDaysInInbox,
  isStale,
  formatAge,
  getStaleItems,
  getNonStaleItems,
  getRandomNudgeMessage,
  getNudgeMessage
} from './stale-utils'

describe('stale-utils', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15)) // January 15, 2026
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('STALE_THRESHOLD_DAYS', () => {
    it('should be 7 days', () => {
      expect(STALE_THRESHOLD_DAYS).toBe(7)
    })
  })

  describe('getDaysInInbox', () => {
    it('should return 0 for item created today', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 15)
      }
      expect(getDaysInInbox(item)).toBe(0)
    })

    it('should return correct days for item created 5 days ago', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 10)
      }
      expect(getDaysInInbox(item)).toBe(5)
    })

    it('should return correct days for item created 30 days ago', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2025, 11, 16) // December 16, 2025
      }
      expect(getDaysInInbox(item)).toBe(30)
    })

    it('should handle ISO string dates', () => {
      const item: InboxItemListItem = {
        id: '1',
        title: 'Test',
        createdAt: '2026-01-10T12:00:00.000Z' // Use noon UTC to avoid timezone edge cases
      }
      // The difference between Jan 10 noon UTC and Jan 15 midnight local time
      // Floor of 4.5 days = 4 days
      expect(getDaysInInbox(item)).toBe(4)
    })

    it('should handle Date objects in InboxItemListItem', () => {
      const item: InboxItemListItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 8)
      }
      expect(getDaysInInbox(item)).toBe(7)
    })
  })

  describe('isStale', () => {
    it('should return false for item created today', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 15)
      }
      expect(isStale(item)).toBe(false)
    })

    it('should return false for item created 6 days ago (just under threshold)', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 9)
      }
      expect(isStale(item)).toBe(false)
    })

    it('should return true for item created 7 days ago (at threshold)', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 8)
      }
      expect(isStale(item)).toBe(true)
    })

    it('should return true for item created 30 days ago', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2025, 11, 16)
      }
      expect(isStale(item)).toBe(true)
    })

    it('should use custom threshold when provided', () => {
      const item: InboxItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 12) // 3 days ago
      }
      expect(isStale(item, 3)).toBe(true)
      expect(isStale(item, 5)).toBe(false)
    })

    it('should use pre-computed isStale field from backend item when available', () => {
      const item: InboxItemListItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 15), // today
        isStale: true // backend says stale
      }
      expect(isStale(item)).toBe(true)
    })

    it('should use pre-computed isStale field even when false', () => {
      const item: InboxItemListItem = {
        id: '1',
        title: 'Test',
        createdAt: new Date(2026, 0, 1), // 14 days ago
        isStale: false // backend says not stale
      }
      expect(isStale(item)).toBe(false)
    })
  })

  describe('formatAge', () => {
    it('should format 0 days correctly', () => {
      expect(formatAge(0)).toBe('0 days in inbox')
    })

    it('should format 1 day correctly', () => {
      expect(formatAge(1)).toBe('1 days in inbox')
    })

    it('should format 7 days correctly', () => {
      expect(formatAge(7)).toBe('7 days in inbox')
    })

    it('should format 13 days correctly (still in days range)', () => {
      expect(formatAge(13)).toBe('13 days in inbox')
    })

    it('should format 14 days as weeks', () => {
      expect(formatAge(14)).toBe('2 weeks in inbox')
    })

    it('should format 21 days as 3 weeks', () => {
      expect(formatAge(21)).toBe('3 weeks in inbox')
    })

    it('should format 28 days as 4 weeks', () => {
      expect(formatAge(28)).toBe('4 weeks in inbox')
    })

    it('should format 30 days as over a month', () => {
      expect(formatAge(30)).toBe('Over a month in inbox')
    })

    it('should format 59 days as over a month', () => {
      expect(formatAge(59)).toBe('Over a month in inbox')
    })

    it('should format 60 days as over 2 months', () => {
      expect(formatAge(60)).toBe('Over 2 months in inbox')
    })

    it('should format 90 days as over 3 months', () => {
      expect(formatAge(90)).toBe('Over 3 months in inbox')
    })

    it('should format 365 days as over 12 months', () => {
      expect(formatAge(365)).toBe('Over 12 months in inbox')
    })
  })

  describe('getStaleItems', () => {
    const freshItem: InboxItem = {
      id: '1',
      title: 'Fresh',
      createdAt: new Date(2026, 0, 15) // today
    }

    const staleItem: InboxItem = {
      id: '2',
      title: 'Stale',
      createdAt: new Date(2026, 0, 1) // 14 days ago
    }

    const borderlineItem: InboxItem = {
      id: '3',
      title: 'Borderline',
      createdAt: new Date(2026, 0, 8) // exactly 7 days ago
    }

    it('should return empty array when no items are stale', () => {
      const items = [freshItem]
      expect(getStaleItems(items)).toEqual([])
    })

    it('should return only stale items', () => {
      const items = [freshItem, staleItem]
      const result = getStaleItems(items)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('2')
    })

    it('should include borderline items (exactly at threshold)', () => {
      const items = [freshItem, borderlineItem]
      const result = getStaleItems(items)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('3')
    })

    it('should work with custom threshold', () => {
      const items = [freshItem, staleItem, borderlineItem]
      const result = getStaleItems(items, 14)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('2')
    })

    it('should return all items when all are stale', () => {
      const items = [staleItem, borderlineItem]
      const result = getStaleItems(items)
      expect(result).toHaveLength(2)
    })
  })

  describe('getNonStaleItems', () => {
    const freshItem: InboxItem = {
      id: '1',
      title: 'Fresh',
      createdAt: new Date(2026, 0, 15)
    }

    const staleItem: InboxItem = {
      id: '2',
      title: 'Stale',
      createdAt: new Date(2026, 0, 1)
    }

    it('should return all items when none are stale', () => {
      const items = [freshItem]
      const result = getNonStaleItems(items)
      expect(result).toHaveLength(1)
    })

    it('should return only fresh items', () => {
      const items = [freshItem, staleItem]
      const result = getNonStaleItems(items)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('1')
    })

    it('should return empty array when all items are stale', () => {
      const items = [staleItem]
      const result = getNonStaleItems(items)
      expect(result).toEqual([])
    })

    it('should work with custom threshold', () => {
      const items = [freshItem, staleItem]
      const result = getNonStaleItems(items, 30)
      expect(result).toHaveLength(2)
    })
  })

  describe('getRandomNudgeMessage', () => {
    it('should return a string', () => {
      const message = getRandomNudgeMessage()
      expect(typeof message).toBe('string')
      expect(message.length).toBeGreaterThan(0)
    })

    it('should return one of the predefined messages', () => {
      const validMessages = [
        'These items are getting dusty.',
        'These have been waiting for a while.',
        'Some items could use your attention.',
        'A few things have been sitting here.',
        'Ready to clear some old items?'
      ]

      // Run multiple times to increase confidence
      for (let i = 0; i < 10; i++) {
        const message = getRandomNudgeMessage()
        expect(validMessages).toContain(message)
      }
    })
  })

  describe('getNudgeMessage', () => {
    const expectedMessages = [
      'These items are getting dusty.',
      'These have been waiting for a while.',
      'Some items could use your attention.',
      'A few things have been sitting here.',
      'Ready to clear some old items?'
    ]

    it('should return consistent message based on item count', () => {
      const message1 = getNudgeMessage(5)
      const message2 = getNudgeMessage(5)
      expect(message1).toBe(message2)
    })

    it('should return first message for count 0', () => {
      expect(getNudgeMessage(0)).toBe(expectedMessages[0])
    })

    it('should return second message for count 1', () => {
      expect(getNudgeMessage(1)).toBe(expectedMessages[1])
    })

    it('should cycle through messages based on modulo', () => {
      expect(getNudgeMessage(5)).toBe(expectedMessages[0]) // 5 % 5 = 0
      expect(getNudgeMessage(6)).toBe(expectedMessages[1]) // 6 % 5 = 1
      expect(getNudgeMessage(7)).toBe(expectedMessages[2]) // 7 % 5 = 2
    })

    it('should handle large numbers correctly', () => {
      expect(getNudgeMessage(100)).toBe(expectedMessages[0]) // 100 % 5 = 0
      expect(getNudgeMessage(103)).toBe(expectedMessages[3]) // 103 % 5 = 3
    })
  })
})
