import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { InboxItem, InboxItemListItem } from '@/types'
import {
  groupItemsByTimePeriod,
  formatTimestamp,
  formatDuration,
  extractDomain,
  type TimePeriod,
  type GroupedItems
} from './inbox-utils'

describe('inbox-utils', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 0, 15, 14, 30)) // January 15, 2026 at 2:30 PM
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('groupItemsByTimePeriod', () => {
    const createItem = (id: string, daysAgo: number): InboxItem => ({
      id,
      title: `Item ${id}`,
      createdAt: new Date(2026, 0, 15 - daysAgo)
    })

    it('should return empty array when no items provided', () => {
      const result = groupItemsByTimePeriod([])
      expect(result).toEqual([])
    })

    it('should group items created today as TODAY', () => {
      const items = [createItem('1', 0)]
      const result = groupItemsByTimePeriod(items)
      expect(result).toHaveLength(1)
      expect(result[0].period).toBe('TODAY')
      expect(result[0].items).toHaveLength(1)
    })

    it('should group items created yesterday as YESTERDAY', () => {
      const items = [createItem('1', 1)]
      const result = groupItemsByTimePeriod(items)
      expect(result).toHaveLength(1)
      expect(result[0].period).toBe('YESTERDAY')
      expect(result[0].items).toHaveLength(1)
    })

    it('should group items older than yesterday as OLDER', () => {
      const items = [createItem('1', 5)]
      const result = groupItemsByTimePeriod(items)
      expect(result).toHaveLength(1)
      expect(result[0].period).toBe('OLDER')
      expect(result[0].items).toHaveLength(1)
    })

    it('should group multiple items correctly', () => {
      const items = [
        createItem('1', 0), // today
        createItem('2', 0), // today
        createItem('3', 1), // yesterday
        createItem('4', 5), // older
        createItem('5', 10) // older
      ]
      const result = groupItemsByTimePeriod(items)

      expect(result).toHaveLength(3)

      const today = result.find((g) => g.period === 'TODAY')
      expect(today?.items).toHaveLength(2)

      const yesterday = result.find((g) => g.period === 'YESTERDAY')
      expect(yesterday?.items).toHaveLength(1)

      const older = result.find((g) => g.period === 'OLDER')
      expect(older?.items).toHaveLength(2)
    })

    it('should maintain proper group order (TODAY, YESTERDAY, OLDER)', () => {
      const items = [
        createItem('1', 5), // older
        createItem('2', 0), // today
        createItem('3', 1) // yesterday
      ]
      const result = groupItemsByTimePeriod(items)

      expect(result[0].period).toBe('TODAY')
      expect(result[1].period).toBe('YESTERDAY')
      expect(result[2].period).toBe('OLDER')
    })

    it('should skip empty groups', () => {
      const items = [createItem('1', 0), createItem('2', 5)] // today and older, no yesterday
      const result = groupItemsByTimePeriod(items)

      expect(result).toHaveLength(2)
      expect(result[0].period).toBe('TODAY')
      expect(result[1].period).toBe('OLDER')
    })

    it('should handle ISO string dates in InboxItemListItem', () => {
      const items: InboxItemListItem[] = [
        { id: '1', title: 'Test', createdAt: '2026-01-15T10:00:00.000Z' }
      ]
      const result = groupItemsByTimePeriod(items)
      expect(result).toHaveLength(1)
      expect(result[0].period).toBe('TODAY')
    })

    it('should handle Date objects in items', () => {
      const items: InboxItem[] = [{ id: '1', title: 'Test', createdAt: new Date(2026, 0, 15) }]
      const result = groupItemsByTimePeriod(items)
      expect(result).toHaveLength(1)
      expect(result[0].period).toBe('TODAY')
    })
  })

  describe('formatTimestamp', () => {
    it('should format TODAY timestamps as time', () => {
      const timestamp = new Date(2026, 0, 15, 14, 34)
      const result = formatTimestamp(timestamp, 'TODAY')
      expect(result).toMatch(/2:34\s*PM/i)
    })

    it('should format YESTERDAY timestamps as time', () => {
      const timestamp = new Date(2026, 0, 14, 9, 15)
      const result = formatTimestamp(timestamp, 'YESTERDAY')
      expect(result).toMatch(/9:15\s*AM/i)
    })

    it('should format OLDER timestamps as date', () => {
      const timestamp = new Date(2025, 11, 24, 10, 0) // December 24, 2025
      const result = formatTimestamp(timestamp, 'OLDER')
      expect(result).toBe('Dec 24')
    })

    it('should handle midnight correctly for TODAY', () => {
      const timestamp = new Date(2026, 0, 15, 0, 0)
      const result = formatTimestamp(timestamp, 'TODAY')
      expect(result).toMatch(/12:00\s*AM/i)
    })

    it('should handle noon correctly', () => {
      const timestamp = new Date(2026, 0, 15, 12, 0)
      const result = formatTimestamp(timestamp, 'TODAY')
      expect(result).toMatch(/12:00\s*PM/i)
    })

    it('should handle different months for OLDER', () => {
      const timestamp = new Date(2025, 5, 15) // June 15, 2025
      const result = formatTimestamp(timestamp, 'OLDER')
      expect(result).toBe('Jun 15')
    })
  })

  describe('formatDuration', () => {
    it('should format 0 seconds correctly', () => {
      expect(formatDuration(0)).toBe('0:00')
    })

    it('should format seconds under a minute', () => {
      expect(formatDuration(30)).toBe('0:30')
      expect(formatDuration(5)).toBe('0:05')
      expect(formatDuration(59)).toBe('0:59')
    })

    it('should format exactly one minute', () => {
      expect(formatDuration(60)).toBe('1:00')
    })

    it('should format minutes and seconds', () => {
      expect(formatDuration(90)).toBe('1:30')
      expect(formatDuration(125)).toBe('2:05')
      expect(formatDuration(599)).toBe('9:59')
    })

    it('should format 10+ minutes correctly', () => {
      expect(formatDuration(600)).toBe('10:00')
      expect(formatDuration(754)).toBe('12:34')
    })

    it('should pad seconds with leading zero', () => {
      expect(formatDuration(61)).toBe('1:01')
      expect(formatDuration(65)).toBe('1:05')
      expect(formatDuration(69)).toBe('1:09')
    })
  })

  describe('extractDomain', () => {
    it('should extract domain from simple URL', () => {
      expect(extractDomain('https://example.com')).toBe('example.com')
    })

    it('should remove www prefix', () => {
      expect(extractDomain('https://www.example.com')).toBe('example.com')
    })

    it('should handle URLs with paths', () => {
      expect(extractDomain('https://example.com/path/to/page')).toBe('example.com')
    })

    it('should handle URLs with query params', () => {
      expect(extractDomain('https://example.com?query=value')).toBe('example.com')
    })

    it('should handle URLs with ports', () => {
      // URL.hostname returns just the hostname without port
      expect(extractDomain('https://example.com:8080/path')).toBe('example.com')
    })

    it('should handle subdomains', () => {
      expect(extractDomain('https://blog.example.com')).toBe('blog.example.com')
    })

    it('should handle http URLs', () => {
      expect(extractDomain('http://example.com')).toBe('example.com')
    })

    it('should return original string for invalid URLs', () => {
      expect(extractDomain('not-a-url')).toBe('not-a-url')
      expect(extractDomain('')).toBe('')
    })

    it('should handle complex URLs with multiple www', () => {
      expect(extractDomain('https://www.subdomain.example.com')).toBe('subdomain.example.com')
    })
  })
})
