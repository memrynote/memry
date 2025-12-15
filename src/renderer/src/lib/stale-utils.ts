// ============================================================================
// STALE ITEM UTILITIES
// ============================================================================
// Functions for detecting, managing, and processing stale inbox items.
// Items are considered "stale" when unfiled for more than 7 days.

import type { InboxItem } from '@/data/inbox-types'
import { STALE_THRESHOLD_DAYS, isItemSnoozed } from '@/data/inbox-types'

// ============================================================================
// CONSTANTS
// ============================================================================

export const UNSORTED_FOLDER_ID = 'unsorted'

export const STALE_COLLAPSED_KEY = 'memry:stale-section-collapsed'

// ============================================================================
// AGE THRESHOLDS
// ============================================================================

export type StaleAgeCategory = 'fresh' | 'aging' | 'stale' | 'critical'

/**
 * Get age category for visual styling intensity
 * - fresh: < 7 days (not stale)
 * - aging: 7-14 days
 * - stale: 14-30 days
 * - critical: 30+ days
 */
export function getStaleAgeCategory(item: InboxItem): StaleAgeCategory {
  const now = new Date()
  const diffMs = now.getTime() - item.createdAt.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 7) return 'fresh'
  if (diffDays < 14) return 'aging'
  if (diffDays < 30) return 'stale'
  return 'critical'
}

// ============================================================================
// DETECTION FUNCTIONS
// ============================================================================

/**
 * Check if an item is stale
 * An item is stale when:
 * - createdAt is more than 7 days ago
 * - AND folderId is null (unfiled)
 * - AND snoozedUntil is null or expired
 */
export function isStale(item: InboxItem, thresholdDays: number = STALE_THRESHOLD_DAYS): boolean {
  const threshold = new Date()
  threshold.setDate(threshold.getDate() - thresholdDays)

  return (
    item.createdAt < threshold &&
    item.folderId === null &&
    !isItemSnoozed(item)
  )
}

/**
 * Get all stale items from a list, sorted oldest first
 */
export function getStaleItems(items: InboxItem[]): InboxItem[] {
  return items
    .filter((item) => isStale(item))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
}

/**
 * Get all non-stale items from a list
 */
export function getNonStaleItems(items: InboxItem[]): InboxItem[] {
  return items.filter((item) => !isStale(item))
}

/**
 * Partition items into stale and non-stale groups
 */
export function partitionByStale(items: InboxItem[]): {
  stale: InboxItem[]
  nonStale: InboxItem[]
} {
  const stale: InboxItem[] = []
  const nonStale: InboxItem[] = []

  for (const item of items) {
    if (isStale(item)) {
      stale.push(item)
    } else {
      nonStale.push(item)
    }
  }

  // Sort stale items oldest first
  stale.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())

  return { stale, nonStale }
}

// ============================================================================
// STATISTICS
// ============================================================================

/**
 * Get count of stale items
 */
export function getStaleCount(items: InboxItem[]): number {
  return items.filter((item) => isStale(item)).length
}

/**
 * Get the oldest stale item
 */
export function getOldestStaleItem(items: InboxItem[]): InboxItem | null {
  const staleItems = getStaleItems(items)
  return staleItems.length > 0 ? staleItems[0] : null
}

/**
 * Get age distribution of stale items
 */
export function getStaleAgeDistribution(items: InboxItem[]): {
  aging: number      // 7-14 days
  stale: number      // 14-30 days
  critical: number   // 30+ days
  total: number
} {
  const staleItems = items.filter((item) => isStale(item))
  const now = new Date()

  let aging = 0
  let stale = 0
  let critical = 0

  for (const item of staleItems) {
    const diffDays = Math.floor(
      (now.getTime() - item.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    )

    if (diffDays >= 30) {
      critical++
    } else if (diffDays >= 14) {
      stale++
    } else {
      aging++
    }
  }

  return { aging, stale, critical, total: staleItems.length }
}

// ============================================================================
// TIME FORMATTING
// ============================================================================

/**
 * Format age for stale items display
 * Shows relative age: "7d ago", "2w ago", "1mo ago"
 */
export function formatStaleAge(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 14) {
    return `${diffDays}d ago`
  }

  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return `${weeks}w ago`
  }

  const months = Math.floor(diffDays / 30)
  return `${months}mo ago`
}

/**
 * Get numeric age in days
 */
export function getAgeInDays(date: Date): number {
  const now = new Date()
  return Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24))
}

// ============================================================================
// BATCH ACTIONS
// ============================================================================

/**
 * Create filed versions of items (to Unsorted folder)
 */
export function fileToUnsorted(items: InboxItem[]): InboxItem[] {
  const now = new Date()
  return items.map((item) => ({
    ...item,
    folderId: UNSORTED_FOLDER_ID,
    filedAt: now,
  }))
}

/**
 * Create filed versions of items to a specific folder
 */
export function fileToFolder(items: InboxItem[], folderId: string): InboxItem[] {
  const now = new Date()
  return items.map((item) => ({
    ...item,
    folderId,
    filedAt: now,
  }))
}

// ============================================================================
// PERSISTENCE
// ============================================================================

/**
 * Get collapsed state from localStorage
 */
export function getStaleSectionCollapsed(): boolean {
  try {
    return localStorage.getItem(STALE_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Save collapsed state to localStorage
 */
export function setStaleSectionCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STALE_COLLAPSED_KEY, String(collapsed))
  } catch {
    // Ignore storage errors
  }
}
