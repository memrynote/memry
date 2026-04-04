import type { InboxItem, InboxItemListItem } from '@/types'

// Time period groups
export type TimePeriod = 'TODAY' | 'YESTERDAY' | 'OLDER'

export interface GroupedItems<T = InboxItemListItem> {
  period: TimePeriod
  items: T[]
}

// Helper to check if two dates are the same day
const isSameDay = (date1: Date, date2: Date): boolean => {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  )
}

/**
 * Get Date object from item's createdAt field
 * Handles both Date objects and ISO strings
 */
const getItemDate = (item: InboxItem | InboxItemListItem): Date => {
  const createdAt = item.createdAt
  return createdAt instanceof Date ? createdAt : new Date(createdAt)
}

// Helper to group items by time period
export const groupItemsByTimePeriod = <T extends InboxItem | InboxItemListItem>(
  items: T[],
  dateAccessor?: (item: T) => Date
): GroupedItems<T>[] => {
  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)

  const groups: Record<TimePeriod, T[]> = {
    TODAY: [],
    YESTERDAY: [],
    OLDER: []
  }

  items.forEach((item) => {
    const itemDate = dateAccessor ? dateAccessor(item) : getItemDate(item)
    if (isSameDay(itemDate, now)) {
      groups.TODAY.push(item)
    } else if (isSameDay(itemDate, yesterday)) {
      groups.YESTERDAY.push(item)
    } else {
      groups.OLDER.push(item)
    }
  })

  // Return only non-empty groups in order
  const result: GroupedItems<T>[] = []
  if (groups.TODAY.length > 0) result.push({ period: 'TODAY', items: groups.TODAY })
  if (groups.YESTERDAY.length > 0) result.push({ period: 'YESTERDAY', items: groups.YESTERDAY })
  if (groups.OLDER.length > 0) result.push({ period: 'OLDER', items: groups.OLDER })

  return result
}

// Helper to format timestamp based on time period
export const formatTimestamp = (timestamp: Date, period: TimePeriod): string => {
  if (period === 'TODAY' || period === 'YESTERDAY') {
    // Show time like "2:34 PM"
    return timestamp.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  }
  // For OLDER items, show date like "Dec 24"
  return timestamp.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })
}

// Helper to format voice memo duration
export const formatDuration = (seconds: number): string => {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// Compact relative time (Paper-style: "2m", "1h", "3d")
export const formatCompactRelativeTime = (date: Date | string): string => {
  const d = typeof date === 'string' ? new Date(date) : date
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMins < 1) return 'now'
  if (diffMins < 60) return `${diffMins}m`
  if (diffHours < 24) return `${diffHours}h`
  if (diffDays < 30) return `${diffDays}d`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export { extractDomain } from './url-metadata'
