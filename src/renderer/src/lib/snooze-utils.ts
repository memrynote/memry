// ============================================================================
// SNOOZE UTILITIES
// ============================================================================
// Functions for calculating snooze times and managing snoozed items.

import type { InboxItem } from '@/data/inbox-types'

// ============================================================================
// TYPES
// ============================================================================

export type SnoozeOptionId =
  | 'later-today'
  | 'tomorrow'
  | 'this-weekend'
  | 'next-week'
  | 'custom'

export interface SnoozeOption {
  id: SnoozeOptionId
  label: string
  description: string
  getTime: () => Date
  icon: string
}

export interface SnoozedItemGroup {
  label: string
  items: SnoozedItemWithMeta[]
}

export type SnoozedItemWithMeta = InboxItem & {
  timeUntilReturn: string
  formattedReturnTime: string
}

// ============================================================================
// TIME CALCULATION HELPERS
// ============================================================================

/**
 * Set a date to a specific hour (24h format), clearing minutes/seconds
 */
function setToHour(date: Date, hour: number): Date {
  const result = new Date(date)
  result.setHours(hour, 0, 0, 0)
  return result
}

/**
 * Get the next occurrence of a specific day of week
 * @param dayOfWeek 0 = Sunday, 1 = Monday, ..., 6 = Saturday
 */
function getNextDayOfWeek(dayOfWeek: number, fromDate: Date = new Date()): Date {
  const result = new Date(fromDate)
  result.setDate(result.getDate() + ((7 + dayOfWeek - result.getDay()) % 7 || 7))
  return result
}

/**
 * Add days to a date
 */
function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

/**
 * Check if two dates are the same calendar day
 */
function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  )
}

/**
 * Check if a date is tomorrow
 */
function isTomorrow(date: Date): boolean {
  const tomorrow = addDays(new Date(), 1)
  return isSameDay(date, tomorrow)
}

/**
 * Check if a date is within this week (next 7 days)
 */
function isThisWeek(date: Date): boolean {
  const now = new Date()
  const weekFromNow = addDays(now, 7)
  return date > now && date <= weekFromNow
}

// ============================================================================
// SNOOZE TIME CALCULATIONS
// ============================================================================

/**
 * Calculate "Later today" time
 * - If before 3 PM: today at 6 PM
 * - If after 3 PM: now + 3 hours
 */
export function getLaterTodayTime(): Date {
  const now = new Date()
  const currentHour = now.getHours()

  if (currentHour < 15) {
    // Before 3 PM - return 6 PM today
    return setToHour(now, 18)
  } else {
    // After 3 PM - return now + 3 hours
    const result = new Date(now)
    result.setHours(result.getHours() + 3)
    return result
  }
}

/**
 * Calculate "Tomorrow" time - Tomorrow at 9 AM
 */
export function getTomorrowTime(): Date {
  const tomorrow = addDays(new Date(), 1)
  return setToHour(tomorrow, 9)
}

/**
 * Calculate "This weekend" time - Next Saturday at 10 AM
 */
export function getThisWeekendTime(): Date {
  const saturday = getNextDayOfWeek(6) // 6 = Saturday
  return setToHour(saturday, 10)
}

/**
 * Calculate "Next week" time - Next Monday at 9 AM
 */
export function getNextWeekTime(): Date {
  const monday = getNextDayOfWeek(1) // 1 = Monday
  return setToHour(monday, 9)
}

// ============================================================================
// SNOOZE OPTIONS
// ============================================================================

/**
 * Get all snooze options with calculated times
 */
export function getSnoozeOptions(): SnoozeOption[] {
  return [
    {
      id: 'later-today',
      label: 'Later today',
      description: formatSnoozePreview(getLaterTodayTime()),
      getTime: getLaterTodayTime,
      icon: 'Sun',
    },
    {
      id: 'tomorrow',
      label: 'Tomorrow',
      description: formatSnoozePreview(getTomorrowTime()),
      getTime: getTomorrowTime,
      icon: 'Sunrise',
    },
    {
      id: 'this-weekend',
      label: 'This weekend',
      description: formatSnoozePreview(getThisWeekendTime()),
      getTime: getThisWeekendTime,
      icon: 'Coffee',
    },
    {
      id: 'next-week',
      label: 'Next week',
      description: formatSnoozePreview(getNextWeekTime()),
      getTime: getNextWeekTime,
      icon: 'Calendar',
    },
    {
      id: 'custom',
      label: 'Pick date & time',
      description: 'Choose a specific time',
      getTime: () => new Date(), // Will be overridden by custom picker
      icon: 'CalendarDays',
    },
  ]
}

/**
 * Calculate snooze time for a given option ID
 */
export function calculateSnoozeTime(optionId: SnoozeOptionId): Date {
  switch (optionId) {
    case 'later-today':
      return getLaterTodayTime()
    case 'tomorrow':
      return getTomorrowTime()
    case 'this-weekend':
      return getThisWeekendTime()
    case 'next-week':
      return getNextWeekTime()
    default:
      return new Date()
  }
}

// ============================================================================
// SNOOZE STATUS HELPERS
// ============================================================================

/**
 * Check if an item is currently snoozed
 */
export function isItemSnoozed(item: InboxItem): boolean {
  return item.snoozedUntil !== null && item.snoozedUntil > new Date()
}

/**
 * Get all snoozed items from a list
 */
export function getSnoozedItems(items: InboxItem[]): InboxItem[] {
  return items.filter(isItemSnoozed)
}

/**
 * Get items that have returned (snooze expired)
 */
export function getReturningItems(items: InboxItem[]): InboxItem[] {
  const now = new Date()
  // Items where snooze was set but has now expired (within last hour)
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000)

  return items.filter((item) => {
    if (!item.snoozedUntil || !item.snoozedAt) return false
    // Snooze has expired and it happened recently
    return item.snoozedUntil <= now && item.snoozedUntil > oneHourAgo
  })
}

// ============================================================================
// TIME FORMATTING
// ============================================================================

/**
 * Format a snooze preview time (e.g., "6 PM", "Sat 10 AM")
 */
export function formatSnoozePreview(date: Date): string {
  const now = new Date()
  const isToday = isSameDay(date, now)
  const tomorrow = isTomorrow(date)

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: date.getMinutes() > 0 ? '2-digit' : undefined,
    hour12: true,
  })

  if (isToday) {
    return timeStr
  }

  if (tomorrow) {
    return `Tomorrow ${timeStr}`
  }

  const dayStr = date.toLocaleDateString('en-US', { weekday: 'short' })
  return `${dayStr} ${timeStr}`
}

/**
 * Format the return time display for snoozed items list
 */
export function formatReturnTime(date: Date): string {
  const now = new Date()
  const isToday = isSameDay(date, now)
  const tomorrow = isTomorrow(date)
  const thisWeek = isThisWeek(date)

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: date.getMinutes() > 0 ? '2-digit' : undefined,
    hour12: true,
  })

  if (isToday) {
    return timeStr
  }

  if (tomorrow) {
    return `Tomorrow ${timeStr}`
  }

  if (thisWeek) {
    const dayStr = date.toLocaleDateString('en-US', { weekday: 'long' })
    return `${dayStr} ${timeStr}`
  }

  // Further out - show full date
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: date.getMinutes() > 0 ? '2-digit' : undefined,
    hour12: true,
  })
}

/**
 * Format time until return (relative)
 */
export function getTimeUntilReturn(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()

  if (diffMs <= 0) {
    return 'Now'
  }

  const minutes = Math.floor(diffMs / (1000 * 60))
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (minutes < 60) {
    return `in ${minutes} minute${minutes !== 1 ? 's' : ''}`
  }

  if (hours < 24) {
    return `in ${hours} hour${hours !== 1 ? 's' : ''}`
  }

  if (days === 1) {
    return 'Tomorrow'
  }

  return `in ${days} days`
}

/**
 * Format how long ago an item was snoozed
 */
export function formatSnoozedAgo(date: Date | null): string {
  if (!date) return ''

  const now = new Date()
  const diffMs = now.getTime() - date.getTime()

  const minutes = Math.floor(diffMs / (1000 * 60))
  const hours = Math.floor(diffMs / (1000 * 60 * 60))
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (minutes < 60) {
    return `Snoozed ${minutes} minute${minutes !== 1 ? 's' : ''} ago`
  }

  if (hours < 24) {
    return `Snoozed ${hours} hour${hours !== 1 ? 's' : ''} ago`
  }

  if (days === 1) {
    return 'Snoozed yesterday'
  }

  return `Snoozed ${days} days ago`
}

// ============================================================================
// SNOOZED ITEMS GROUPING
// ============================================================================

/**
 * Group snoozed items by return time category
 */
export function groupSnoozedItems(items: InboxItem[]): SnoozedItemGroup[] {
  const now = new Date()
  const snoozedItems = getSnoozedItems(items)

  // Add metadata to items
  const itemsWithMeta: SnoozedItemWithMeta[] = snoozedItems
    .map((item) => ({
      ...item,
      timeUntilReturn: getTimeUntilReturn(item.snoozedUntil!),
      formattedReturnTime: formatReturnTime(item.snoozedUntil!),
    }))
    .sort((a, b) => a.snoozedUntil!.getTime() - b.snoozedUntil!.getTime())

  // Group by category
  const today: SnoozedItemWithMeta[] = []
  const tomorrow: SnoozedItemWithMeta[] = []
  const later: SnoozedItemWithMeta[] = []

  for (const item of itemsWithMeta) {
    if (isSameDay(item.snoozedUntil!, now)) {
      today.push(item)
    } else if (isTomorrow(item.snoozedUntil!)) {
      tomorrow.push(item)
    } else {
      later.push(item)
    }
  }

  const groups: SnoozedItemGroup[] = []

  if (today.length > 0) {
    groups.push({ label: `Returning today (${today.length})`, items: today })
  }

  if (tomorrow.length > 0) {
    groups.push({ label: `Returning tomorrow (${tomorrow.length})`, items: tomorrow })
  }

  if (later.length > 0) {
    groups.push({ label: `Returning later (${later.length})`, items: later })
  }

  return groups
}

// ============================================================================
// SNOOZE ACTIONS
// ============================================================================

/**
 * Create a snoozed version of an item
 */
export function snoozeItem(item: InboxItem, until: Date): InboxItem {
  return {
    ...item,
    snoozedUntil: until,
    snoozedAt: new Date(),
  }
}

/**
 * Remove snooze from an item (unsnooze)
 */
export function unsnoozeItem(item: InboxItem): InboxItem {
  return {
    ...item,
    snoozedUntil: null,
    snoozedAt: null,
  }
}

/**
 * Batch snooze multiple items
 */
export function snoozeItems(items: InboxItem[], until: Date): InboxItem[] {
  return items.map((item) => snoozeItem(item, until))
}

/**
 * Batch unsnooze multiple items
 */
export function unsnoozeItems(items: InboxItem[]): InboxItem[] {
  return items.map(unsnoozeItem)
}
