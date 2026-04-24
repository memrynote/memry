import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getDateGroup,
  getDateGroupLabel,
  groupByDate,
  groupByDateWithLabels,
  formatRelativeDate
} from './date-grouping'

describe('date-grouping', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-01-07T12:00:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('getDateGroup', () => {
    it('returns today for current date', () => {
      expect(getDateGroup(new Date('2025-01-07T10:00:00'))).toBe('today')
    })

    it('returns yesterday for previous day', () => {
      expect(getDateGroup(new Date('2025-01-06T10:00:00'))).toBe('yesterday')
    })

    it('returns pastWeek for dates within 7 days', () => {
      expect(getDateGroup(new Date('2025-01-02T10:00:00'))).toBe('pastWeek')
      expect(getDateGroup(new Date('2025-01-01T10:00:00'))).toBe('pastWeek')
    })

    it('returns past30Days for dates within 30 days', () => {
      expect(getDateGroup(new Date('2024-12-20T10:00:00'))).toBe('past30Days')
      expect(getDateGroup(new Date('2024-12-10T10:00:00'))).toBe('past30Days')
    })

    it('returns older for dates beyond 30 days', () => {
      expect(getDateGroup(new Date('2024-11-01T10:00:00'))).toBe('older')
      expect(getDateGroup(new Date('2024-01-01T10:00:00'))).toBe('older')
    })

    it('handles string dates', () => {
      expect(getDateGroup('2025-01-07T10:00:00')).toBe('today')
      expect(getDateGroup('2025-01-06T10:00:00')).toBe('yesterday')
    })
  })

  describe('getDateGroupLabel', () => {
    it('returns correct labels', () => {
      expect(getDateGroupLabel('today')).toBe('Today')
      expect(getDateGroupLabel('yesterday')).toBe('Yesterday')
      expect(getDateGroupLabel('pastWeek')).toBe('Past week')
      expect(getDateGroupLabel('past30Days')).toBe('Past 30 days')
      expect(getDateGroupLabel('older')).toBe('Older')
    })
  })

  describe('groupByDate', () => {
    const items = [
      { id: 1, modified: '2025-01-07T10:00:00' },
      { id: 2, modified: '2025-01-07T08:00:00' },
      { id: 3, modified: '2025-01-06T10:00:00' },
      { id: 4, modified: '2025-01-03T10:00:00' },
      { id: 5, modified: '2024-12-20T10:00:00' },
      { id: 6, modified: '2024-10-01T10:00:00' }
    ]

    it('groups items by date correctly', () => {
      const grouped = groupByDate(items, (item) => item.modified)

      expect(grouped.today).toHaveLength(2)
      expect(grouped.yesterday).toHaveLength(1)
      expect(grouped.pastWeek).toHaveLength(1)
      expect(grouped.past30Days).toHaveLength(1)
      expect(grouped.older).toHaveLength(1)
    })

    it('preserves item order within groups', () => {
      const grouped = groupByDate(items, (item) => item.modified)

      expect(grouped.today[0].id).toBe(1)
      expect(grouped.today[1].id).toBe(2)
    })

    it('handles empty array', () => {
      const grouped = groupByDate([], (item: { modified: string }) => item.modified)

      expect(grouped.today).toHaveLength(0)
      expect(grouped.yesterday).toHaveLength(0)
      expect(grouped.pastWeek).toHaveLength(0)
      expect(grouped.past30Days).toHaveLength(0)
      expect(grouped.older).toHaveLength(0)
    })
  })

  describe('groupByDateWithLabels', () => {
    const items = [
      { id: 1, modified: '2025-01-07T10:00:00' },
      { id: 2, modified: '2025-01-06T10:00:00' },
      { id: 3, modified: '2024-10-01T10:00:00' }
    ]

    it('returns array of group objects with labels', () => {
      const grouped = groupByDateWithLabels(items, (item) => item.modified)

      expect(grouped).toHaveLength(3)
      expect(grouped[0]).toEqual({
        group: 'today',
        label: 'Today',
        items: [items[0]]
      })
      expect(grouped[1]).toEqual({
        group: 'yesterday',
        label: 'Yesterday',
        items: [items[1]]
      })
      expect(grouped[2]).toEqual({
        group: 'older',
        label: 'Older',
        items: [items[2]]
      })
    })

    it('omits empty groups', () => {
      const todayOnly = [{ id: 1, modified: '2025-01-07T10:00:00' }]
      const grouped = groupByDateWithLabels(todayOnly, (item) => item.modified)

      expect(grouped).toHaveLength(1)
      expect(grouped[0].group).toBe('today')
    })

    it('preserves group order', () => {
      const allGroups = [
        { id: 1, modified: '2024-10-01T10:00:00' },
        { id: 2, modified: '2025-01-07T10:00:00' },
        { id: 3, modified: '2025-01-06T10:00:00' },
        { id: 4, modified: '2025-01-03T10:00:00' },
        { id: 5, modified: '2024-12-20T10:00:00' }
      ]
      const grouped = groupByDateWithLabels(allGroups, (item) => item.modified)

      expect(grouped[0].group).toBe('today')
      expect(grouped[1].group).toBe('yesterday')
      expect(grouped[2].group).toBe('pastWeek')
      expect(grouped[3].group).toBe('past30Days')
      expect(grouped[4].group).toBe('older')
    })
  })

  describe('formatRelativeDate', () => {
    it('shows time for today', () => {
      const result = formatRelativeDate('2025-01-07T14:30:00')
      expect(result).toBe('2:30 PM')
    })

    it('shows Yesterday for yesterday', () => {
      expect(formatRelativeDate('2025-01-06T10:00:00')).toBe('Yesterday')
    })

    it('shows relative time for past week', () => {
      const result = formatRelativeDate('2025-01-05T10:00:00')
      expect(result).toContain('days ago')
    })

    it('shows month and day for dates within past year', () => {
      const result = formatRelativeDate('2024-12-01T10:00:00')
      expect(result).toBe('Dec 1')
    })

    it('shows full date for older dates', () => {
      const result = formatRelativeDate('2024-01-01T10:00:00')
      expect(result).toBe('Jan 1, 2024')
    })

    it('handles Date objects', () => {
      const result = formatRelativeDate(new Date('2025-01-07T14:30:00'))
      expect(result).toBe('2:30 PM')
    })
  })
})
