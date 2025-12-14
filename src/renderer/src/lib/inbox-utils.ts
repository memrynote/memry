/**
 * Inbox Utilities
 *
 * Helper functions for inbox components.
 */

// ============================================================================
// TIME FORMATTING
// ============================================================================

/**
 * Format a date as relative time for display
 *
 * Rules:
 * - < 1 hour: "Xm ago"
 * - < 24 hours: "Xh ago"
 * - Yesterday: "Yesterday"
 * - < 7 days: "X days ago"
 * - >= 7 days: "Mon DD" (Jan 15)
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  // Less than 1 hour
  if (diffMins < 60) {
    if (diffMins < 1) return 'Just now'
    return `${diffMins}m ago`
  }

  // Less than 24 hours
  if (diffHours < 24) {
    return `${diffHours}h ago`
  }

  // Check if yesterday
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(0, 0, 0, 0)

  const dateStart = new Date(date)
  dateStart.setHours(0, 0, 0, 0)

  if (dateStart.getTime() === yesterday.getTime()) {
    return 'Yesterday'
  }

  // Less than 7 days
  if (diffDays < 7) {
    return `${diffDays}d ago`
  }

  // More than 7 days - show date
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[date.getMonth()]} ${date.getDate()}`
}

/**
 * Format a date for stale items (shows age in days/weeks/months)
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
 * Format snooze return time
 */
export function formatSnoozeReturn(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  // Less than 1 hour
  if (diffMins < 60) {
    return `in ${diffMins} minutes`
  }

  // Less than 24 hours - show time
  if (diffHours < 24) {
    const hours = date.getHours()
    const mins = date.getMinutes()
    const ampm = hours >= 12 ? 'PM' : 'AM'
    const hour12 = hours % 12 || 12
    const minStr = mins.toString().padStart(2, '0')
    return `Today at ${hour12}:${minStr} ${ampm}`
  }

  // Tomorrow
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(0, 0, 0, 0)

  const dateStart = new Date(date)
  dateStart.setHours(0, 0, 0, 0)

  if (dateStart.getTime() === tomorrow.getTime()) {
    const hours = date.getHours()
    const ampm = hours >= 12 ? 'PM' : 'AM'
    const hour12 = hours % 12 || 12
    return `Tomorrow at ${hour12} ${ampm}`
  }

  // This week - show day name
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 7) {
    const hours = date.getHours()
    const ampm = hours >= 12 ? 'PM' : 'AM'
    const hour12 = hours % 12 || 12
    return `${dayNames[date.getDay()]} at ${hour12} ${ampm}`
  }

  // Later - show full date
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hours = date.getHours()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const hour12 = hours % 12 || 12
  return `${months[date.getMonth()]} ${date.getDate()} at ${hour12} ${ampm}`
}

// ============================================================================
// DURATION FORMATTING
// ============================================================================

/**
 * Format duration in seconds to human readable
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)

  if (mins >= 60) {
    const hours = Math.floor(mins / 60)
    const remainMins = mins % 60
    return `${hours}:${remainMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  return `${mins}:${secs.toString().padStart(2, '0')}`
}

// ============================================================================
// TEXT UTILITIES
// ============================================================================

/**
 * Truncate text with ellipsis
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 3).trim() + '...'
}

/**
 * Get preview lines from content
 */
export function getPreviewLines(content: string, maxLines: number = 3): string {
  const lines = content.split('\n').filter((line) => line.trim())
  return lines.slice(0, maxLines).join('\n')
}

// ============================================================================
// SELECTION UTILITIES
// ============================================================================

/**
 * Get range of IDs between two indices (for shift-click selection)
 */
export function getSelectionRange<T extends { id: string }>(
  items: T[],
  startId: string,
  endId: string
): string[] {
  const startIndex = items.findIndex((item) => item.id === startId)
  const endIndex = items.findIndex((item) => item.id === endId)

  if (startIndex === -1 || endIndex === -1) return []

  const [from, to] = startIndex < endIndex
    ? [startIndex, endIndex]
    : [endIndex, startIndex]

  return items.slice(from, to + 1).map((item) => item.id)
}

/**
 * Toggle selection of an ID in a set
 */
export function toggleSelection(
  selectedIds: Set<string>,
  id: string
): Set<string> {
  const newSet = new Set(selectedIds)
  if (newSet.has(id)) {
    newSet.delete(id)
  } else {
    newSet.add(id)
  }
  return newSet
}

/**
 * Add multiple IDs to selection
 */
export function addToSelection(
  selectedIds: Set<string>,
  ids: string[]
): Set<string> {
  const newSet = new Set(selectedIds)
  ids.forEach((id) => newSet.add(id))
  return newSet
}
