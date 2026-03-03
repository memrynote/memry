import type { InboxItem, InboxItemListItem } from '@/types'

// Default threshold for stale items (days)
export const STALE_THRESHOLD_DAYS = 7

/**
 * Calculate how many days an item has been in the inbox
 * Works with both InboxItem and InboxItemListItem (both have createdAt)
 */
export const getDaysInInbox = (item: InboxItem | InboxItemListItem): number => {
  const now = new Date()
  // Handle both Date objects and ISO strings
  const createdAt = item.createdAt instanceof Date ? item.createdAt : new Date(item.createdAt)
  const diffMs = now.getTime() - createdAt.getTime()
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

/**
 * Check if an item is stale (older than threshold)
 * For backend items, prefer using the pre-computed isStale field
 */
export const isStale = (
  item: InboxItem | InboxItemListItem,
  threshold: number = STALE_THRESHOLD_DAYS
): boolean => {
  // Backend items have isStale pre-computed
  if ('isStale' in item && typeof item.isStale === 'boolean') {
    return item.isStale
  }
  return getDaysInInbox(item) >= threshold
}

/**
 * Format the age of an item for display
 * - < 14 days: "X days in inbox"
 * - 14-29 days: "X weeks in inbox"
 * - 30-59 days: "Over a month in inbox"
 * - 60+ days: "Over X months in inbox"
 */
export const formatAge = (days: number): string => {
  if (days < 14) {
    return `${days} days in inbox`
  }
  if (days < 30) {
    const weeks = Math.floor(days / 7)
    return `${weeks} week${weeks > 1 ? 's' : ''} in inbox`
  }
  if (days < 60) {
    return 'Over a month in inbox'
  }
  const months = Math.floor(days / 30)
  return `Over ${months} months in inbox`
}

/**
 * Filter items to only stale items (7+ days old)
 * Works with both InboxItem and InboxItemListItem
 */
export const getStaleItems = <T extends InboxItem | InboxItemListItem>(
  items: T[],
  threshold: number = STALE_THRESHOLD_DAYS
): T[] => {
  return items.filter((item) => isStale(item, threshold))
}

/**
 * Filter items to only non-stale items (< 7 days old)
 * Works with both InboxItem and InboxItemListItem
 */
export const getNonStaleItems = <T extends InboxItem | InboxItemListItem>(
  items: T[],
  threshold: number = STALE_THRESHOLD_DAYS
): T[] => {
  return items.filter((item) => !isStale(item, threshold))
}

/**
 * Get a random nudge message for the stale section
 */
const nudgeMessages = [
  'These items are getting dusty.',
  'These have been waiting for a while.',
  'Some items could use your attention.',
  'A few things have been sitting here.',
  'Ready to clear some old items?'
]

export const getRandomNudgeMessage = (): string => {
  const index = Math.floor(Math.random() * nudgeMessages.length)
  return nudgeMessages[index]
}

/**
 * Get a consistent nudge message (based on item count for stability)
 */
export const getNudgeMessage = (itemCount: number): string => {
  const index = itemCount % nudgeMessages.length
  return nudgeMessages[index]
}
