/**
 * Snooze Preset Helpers
 *
 * Helper functions for calculating preset snooze times.
 * All times are returned as ISO strings.
 *
 * @module components/snooze/snooze-presets
 */

// ============================================================================
// Types
// ============================================================================

export interface SnoozePreset {
  id: string
  label: string
  description: string
  getTime: () => Date
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the start of a day (midnight)
 */
function startOfDay(date: Date): Date {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

/**
 * Add days to a date
 */
function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

/**
 * Add hours to a date
 */
function addHours(date: Date, hours: number): Date {
  const d = new Date(date)
  d.setHours(d.getHours() + hours)
  return d
}

/**
 * Get the next occurrence of a specific time today or tomorrow
 * If the time has already passed today, returns tomorrow at that time
 */
function getNextOccurrence(hours: number, minutes: number = 0): Date {
  const now = new Date()
  const today = new Date(now)
  today.setHours(hours, minutes, 0, 0)

  if (today > now) {
    return today
  }

  // Time has passed today, return tomorrow
  return addDays(today, 1)
}

/**
 * Get the next Monday at a specific time
 */
function getNextMonday(hours: number = 9, minutes: number = 0): Date {
  const now = new Date()
  const dayOfWeek = now.getDay() // 0 = Sunday, 1 = Monday, etc.

  let daysUntilMonday: number
  if (dayOfWeek === 0) {
    // Sunday -> next Monday is tomorrow
    daysUntilMonday = 1
  } else if (dayOfWeek === 1) {
    // Monday -> check if time has passed
    const todayTime = new Date(now)
    todayTime.setHours(hours, minutes, 0, 0)
    if (now < todayTime) {
      // Time hasn't passed, use today
      return todayTime
    }
    // Time has passed, use next Monday
    daysUntilMonday = 7
  } else {
    // Tuesday-Saturday -> calculate days until next Monday
    daysUntilMonday = 8 - dayOfWeek
  }

  const nextMonday = addDays(startOfDay(now), daysUntilMonday)
  nextMonday.setHours(hours, minutes, 0, 0)
  return nextMonday
}

/**
 * Get the next Saturday at a specific time
 */
function getNextSaturday(hours: number = 9, minutes: number = 0): Date {
  const now = new Date()
  const dayOfWeek = now.getDay() // 0 = Sunday, 1 = Monday, etc.

  let daysUntilSaturday: number
  if (dayOfWeek === 6) {
    // Saturday -> check if time has passed
    const todayTime = new Date(now)
    todayTime.setHours(hours, minutes, 0, 0)
    if (now < todayTime) {
      // Time hasn't passed, use today
      return todayTime
    }
    // Time has passed, use next Saturday
    daysUntilSaturday = 7
  } else if (dayOfWeek === 0) {
    // Sunday -> next Saturday is in 6 days
    daysUntilSaturday = 6
  } else {
    // Monday-Friday -> calculate days until Saturday
    daysUntilSaturday = 6 - dayOfWeek
  }

  const nextSaturday = addDays(startOfDay(now), daysUntilSaturday)
  nextSaturday.setHours(hours, minutes, 0, 0)
  return nextSaturday
}

// ============================================================================
// Preset Functions
// ============================================================================

/**
 * Get "Later Today" snooze time
 * Returns 3 hours from now or 6pm, whichever is later
 * If it's already past 6pm, returns 9am tomorrow
 */
export function laterToday(): Date {
  const now = new Date()
  const threeHoursLater = addHours(now, 3)

  // 6pm today
  const sixPmToday = new Date(now)
  sixPmToday.setHours(18, 0, 0, 0)

  // If it's already past 6pm, return 9am tomorrow
  if (now.getHours() >= 18) {
    return getNextOccurrence(9, 0)
  }

  // Return whichever is later: 3 hours from now or 6pm
  return threeHoursLater > sixPmToday ? threeHoursLater : sixPmToday
}

/**
 * Get "Tomorrow" snooze time
 * Returns 9am tomorrow
 */
export function tomorrow(): Date {
  const now = new Date()
  const tomorrowDate = addDays(startOfDay(now), 1)
  tomorrowDate.setHours(9, 0, 0, 0)
  return tomorrowDate
}

/**
 * Get "This Weekend" snooze time
 * Returns 9am Saturday
 */
export function thisWeekend(): Date {
  return getNextSaturday(9, 0)
}

/**
 * Get "Next Week" snooze time
 * Returns 9am Monday
 */
export function nextWeek(): Date {
  return getNextMonday(9, 0)
}

/**
 * Get "In 1 Hour" snooze time
 */
export function inOneHour(): Date {
  return addHours(new Date(), 1)
}

/**
 * Get "In 2 Hours" snooze time
 */
export function inTwoHours(): Date {
  return addHours(new Date(), 2)
}

// ============================================================================
// Preset Definitions
// ============================================================================

/**
 * Standard snooze presets for the snooze picker
 */
export const snoozePresets: SnoozePreset[] = [
  {
    id: 'later-today',
    label: 'Later Today',
    description: 'This evening',
    getTime: laterToday
  },
  {
    id: 'tomorrow',
    label: 'Tomorrow',
    description: 'Tomorrow at 9am',
    getTime: tomorrow
  },
  {
    id: 'this-weekend',
    label: 'This Weekend',
    description: 'Saturday at 9am',
    getTime: thisWeekend
  },
  {
    id: 'next-week',
    label: 'Next Week',
    description: 'Monday at 9am',
    getTime: nextWeek
  }
]

/**
 * Quick snooze presets (shorter durations)
 */
export const quickSnoozePresets: SnoozePreset[] = [
  {
    id: 'in-1-hour',
    label: 'In 1 Hour',
    description: '1 hour from now',
    getTime: inOneHour
  },
  {
    id: 'in-2-hours',
    label: 'In 2 Hours',
    description: '2 hours from now',
    getTime: inTwoHours
  }
]

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a date as a relative time description
 * e.g., "Tomorrow at 9:00 AM", "Monday at 9:00 AM"
 */
export function formatSnoozeTime(date: Date): string {
  const now = new Date()
  const today = startOfDay(now)
  const targetDay = startOfDay(date)
  const diffDays = Math.round((targetDay.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

  const timeStr = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })

  if (diffDays === 0) {
    return `Today at ${timeStr}`
  } else if (diffDays === 1) {
    return `Tomorrow at ${timeStr}`
  } else if (diffDays < 7) {
    const dayName = date.toLocaleDateString(undefined, { weekday: 'long' })
    return `${dayName} at ${timeStr}`
  } else {
    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    })
  }
}

/**
 * Format a date as a relative duration
 * e.g., "in 3 hours", "in 2 days"
 */
export function formatSnoozeDuration(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffMins = Math.round(diffMs / (1000 * 60))
  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffMins < 60) {
    return `in ${diffMins} minute${diffMins !== 1 ? 's' : ''}`
  } else if (diffHours < 24) {
    return `in ${diffHours} hour${diffHours !== 1 ? 's' : ''}`
  } else if (diffDays < 7) {
    return `in ${diffDays} day${diffDays !== 1 ? 's' : ''}`
  } else {
    const weeks = Math.round(diffDays / 7)
    return `in ${weeks} week${weeks !== 1 ? 's' : ''}`
  }
}

/**
 * Format a snooze time for display in list items
 * Shows relative time like "Returns in 2 days" or "Returns tomorrow"
 */
export function formatSnoozeReturn(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()

  // If already due
  if (diffMs <= 0) {
    return 'Due now'
  }

  const diffMins = Math.round(diffMs / (1000 * 60))
  const diffHours = Math.round(diffMs / (1000 * 60 * 60))
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffMins < 60) {
    return `Returns in ${diffMins}m`
  } else if (diffHours < 24) {
    return `Returns in ${diffHours}h`
  } else if (diffDays === 1) {
    return 'Returns tomorrow'
  } else if (diffDays < 7) {
    return `Returns in ${diffDays} days`
  } else {
    return `Returns ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
  }
}
