// ============================================================================
// NATURAL DATE PARSER
// ============================================================================
// Parses natural language date inputs like "tomorrow", "next friday", "dec 25"
// Returns a parsed result with date and optional time

import { startOfDay, addDays, isBefore } from './task-utils'

// ============================================================================
// TYPES
// ============================================================================

export interface ParsedDateResult {
  date: Date
  time: string | null // "HH:MM" format (24hr)
}

export interface ParseResult {
  success: true
  result: ParsedDateResult
  displayText: string // Human readable display, e.g., "Friday, December 20, 2024"
}

export interface ParseError {
  success: false
  error: string
}

export type NaturalDateParseResult = ParseResult | ParseError

// ============================================================================
// CONSTANTS
// ============================================================================

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const MONTH_ABBREVIATIONS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
]

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the next occurrence of a specific day of the week
 */
const getNextDayOfWeek = (dayIndex: number, startFrom: Date = new Date()): Date => {
  const today = startOfDay(startFrom)
  const currentDay = today.getDay()
  let daysUntil = dayIndex - currentDay

  // If target day is today or has passed this week, get next week's occurrence
  if (daysUntil <= 0) {
    daysUntil += 7
  }

  return addDays(today, daysUntil)
}

/**
 * Get the next Saturday (for "this weekend")
 */
export const nextSaturday = (from: Date = new Date()): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()

  // If today is Saturday (6), return today
  if (currentDay === 6) {
    return today
  }

  // If today is Sunday (0), return next Saturday (6 days)
  if (currentDay === 0) {
    return addDays(today, 6)
  }

  // Otherwise, find days until Saturday
  const daysUntilSaturday = 6 - currentDay
  return addDays(today, daysUntilSaturday)
}

/**
 * Get the next Monday (for "next week")
 */
export const nextMonday = (from: Date = new Date()): Date => {
  const today = startOfDay(from)
  const currentDay = today.getDay()

  // If today is Monday (1), return next Monday (7 days)
  if (currentDay === 1) {
    return addDays(today, 7)
  }

  // Calculate days until next Monday
  const daysUntilMonday = currentDay === 0 ? 1 : 8 - currentDay
  return addDays(today, daysUntilMonday)
}

/**
 * Add weeks to a date
 */
export const addWeeks = (date: Date, weeks: number): Date => {
  return addDays(date, weeks * 7)
}

/**
 * Add months to a date
 */
export const addMonths = (date: Date, months: number): Date => {
  const result = new Date(date)
  result.setMonth(result.getMonth() + months)
  return result
}

/**
 * Parse time string like "3pm", "3:30pm", "15:00", "3:30 PM"
 */
const parseTimeString = (timeStr: string): string | null => {
  const cleaned = timeStr.toLowerCase().replace(/\s+/g, '')

  // Match patterns like "3pm", "3:30pm", "15:00", "3:30 pm"
  const match12Hour = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (match12Hour) {
    let hours = parseInt(match12Hour[1], 10)
    const minutes = match12Hour[2] ? parseInt(match12Hour[2], 10) : 0
    const period = match12Hour[3]

    if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
      return null
    }

    // Convert to 24-hour format
    if (period === 'pm' && hours !== 12) {
      hours += 12
    } else if (period === 'am' && hours === 12) {
      hours = 0
    }

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
  }

  // Match 24-hour format "15:00"
  const match24Hour = cleaned.match(/^(\d{1,2}):(\d{2})$/)
  if (match24Hour) {
    const hours = parseInt(match24Hour[1], 10)
    const minutes = parseInt(match24Hour[2], 10)

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null
    }

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
  }

  return null
}

/**
 * Format date for display
 */
const formatDisplayDate = (date: Date, time: string | null): string => {
  const dateStr = date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  if (time) {
    const [hours, minutes] = time.split(':').map(Number)
    const period = hours >= 12 ? 'PM' : 'AM'
    const displayHours = hours % 12 || 12
    const timeStr = `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`
    return `${dateStr} · ${timeStr}`
  }

  return dateStr
}

// ============================================================================
// MAIN PARSER
// ============================================================================

/**
 * Parse natural language date input
 *
 * Supports:
 * - Relative: "today", "tomorrow", "yesterday", "next week", "in 3 days"
 * - Day names: "monday", "next friday", "this saturday"
 * - Month day: "dec 25", "december 25", "25th"
 * - Date formats: "12/25", "12-25"
 * - With time: "tomorrow at 3pm", "next friday 2:30pm"
 */
export const parseNaturalDate = (input: string): NaturalDateParseResult => {
  const lower = input.toLowerCase().trim()

  if (!lower) {
    return { success: false, error: 'Please enter a date' }
  }

  const now = new Date()
  const today = startOfDay(now)

  let date: Date | null = null
  let time: string | null = null

  // Extract time component if present (e.g., "at 3pm", "3:30pm")
  const timeMatch = lower.match(/(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)|\d{1,2}:\d{2})$/i)
  const inputWithoutTime = timeMatch ? lower.replace(timeMatch[0], '').trim() : lower

  if (timeMatch) {
    time = parseTimeString(timeMatch[1])
  }

  const normalizedInput = inputWithoutTime.replace(/\s+/g, ' ').trim()

  // -------------------------------------------------------------------------
  // RELATIVE TERMS
  // -------------------------------------------------------------------------

  if (normalizedInput === 'today') {
    date = today
  } else if (
    normalizedInput === 'tomorrow' ||
    normalizedInput === 'tmrw' ||
    normalizedInput === 'tmr'
  ) {
    date = addDays(today, 1)
  } else if (normalizedInput === 'yesterday') {
    date = addDays(today, -1)
  } else if (normalizedInput === 'next week') {
    date = nextMonday(today)
  } else if (normalizedInput === 'this weekend' || normalizedInput === 'weekend') {
    date = nextSaturday(today)
  }

  // -------------------------------------------------------------------------
  // "IN X DAYS/WEEKS" PATTERNS
  // -------------------------------------------------------------------------

  if (!date) {
    const inMatch = normalizedInput.match(/^in\s+(\d+)\s+(day|days|week|weeks|month|months)$/)
    if (inMatch) {
      const num = parseInt(inMatch[1], 10)
      const unit = inMatch[2]

      if (unit.startsWith('day')) {
        date = addDays(today, num)
      } else if (unit.startsWith('week')) {
        date = addWeeks(today, num)
      } else if (unit.startsWith('month')) {
        date = addMonths(today, num)
      }
    }
  }

  // -------------------------------------------------------------------------
  // DAY NAMES: "monday", "next friday", "this saturday"
  // -------------------------------------------------------------------------

  if (!date) {
    const dayMatch = normalizedInput.match(
      /^(next\s+|this\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/
    )
    if (dayMatch) {
      const prefix = dayMatch[1]?.trim()
      const dayName = dayMatch[2]
      const dayIndex = DAY_NAMES.indexOf(dayName)

      if (dayIndex !== -1) {
        date = getNextDayOfWeek(dayIndex, today)

        // "next friday" means skip this week if it's the same week
        if (prefix === 'next') {
          const currentDay = today.getDay()
          // If target is today or earlier in the week, add a week
          if (dayIndex <= currentDay) {
            date = addDays(date, 7)
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // MONTH + DAY: "dec 25", "december 25", "25 dec", "25th december"
  // -------------------------------------------------------------------------

  if (!date) {
    // Pattern: "dec 25" or "december 25"
    const monthDayMatch = normalizedInput.match(
      /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?$/
    )
    if (monthDayMatch) {
      const monthStr = monthDayMatch[1].substring(0, 3)
      const monthIndex = MONTH_ABBREVIATIONS.indexOf(monthStr)
      const day = parseInt(monthDayMatch[2], 10)

      if (monthIndex !== -1 && day >= 1 && day <= 31) {
        let result = new Date(now.getFullYear(), monthIndex, day)

        // If the date has passed, assume next year
        if (isBefore(startOfDay(result), today)) {
          result = new Date(now.getFullYear() + 1, monthIndex, day)
        }

        date = result
      }
    }
  }

  if (!date) {
    // Pattern: "25 dec" or "25th december"
    const dayMonthMatch = normalizedInput.match(
      /^(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/
    )
    if (dayMonthMatch) {
      const day = parseInt(dayMonthMatch[1], 10)
      const monthStr = dayMonthMatch[2].substring(0, 3)
      const monthIndex = MONTH_ABBREVIATIONS.indexOf(monthStr)

      if (monthIndex !== -1 && day >= 1 && day <= 31) {
        let result = new Date(now.getFullYear(), monthIndex, day)

        if (isBefore(startOfDay(result), today)) {
          result = new Date(now.getFullYear() + 1, monthIndex, day)
        }

        date = result
      }
    }
  }

  // -------------------------------------------------------------------------
  // NUMERIC DATES: "12/25", "12-25", "12/25/2024"
  // -------------------------------------------------------------------------

  if (!date) {
    const numericMatch = normalizedInput.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/)
    if (numericMatch) {
      const month = parseInt(numericMatch[1], 10) - 1 // 0-indexed
      const day = parseInt(numericMatch[2], 10)
      let year = numericMatch[3] ? parseInt(numericMatch[3], 10) : now.getFullYear()

      // Handle 2-digit year
      if (year < 100) {
        year += year < 50 ? 2000 : 1900
      }

      if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
        let result = new Date(year, month, day)

        // If no year specified and date has passed, assume next year
        if (!numericMatch[3] && isBefore(startOfDay(result), today)) {
          result = new Date(now.getFullYear() + 1, month, day)
        }

        date = result
      }
    }
  }

  // -------------------------------------------------------------------------
  // ORDINAL DAY ONLY: "25th", "1st"
  // -------------------------------------------------------------------------

  if (!date) {
    const ordinalMatch = normalizedInput.match(/^(\d{1,2})(?:st|nd|rd|th)$/)
    if (ordinalMatch) {
      const day = parseInt(ordinalMatch[1], 10)

      if (day >= 1 && day <= 31) {
        // Assume current month
        let result = new Date(now.getFullYear(), now.getMonth(), day)

        // If day has passed this month, use next month
        if (isBefore(startOfDay(result), today)) {
          result = new Date(now.getFullYear(), now.getMonth() + 1, day)
        }

        date = result
      }
    }
  }

  // -------------------------------------------------------------------------
  // RESULT
  // -------------------------------------------------------------------------

  if (date) {
    return {
      success: true,
      result: {
        date: startOfDay(date),
        time
      },
      displayText: formatDisplayDate(date, time)
    }
  }

  return {
    success: false,
    error: "Couldn't understand this date"
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default parseNaturalDate
