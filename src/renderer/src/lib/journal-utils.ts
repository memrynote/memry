/**
 * Journal Utilities
 * Date generation, formatting, and opacity calculation for journal day cards
 */

// =============================================================================
// TYPES
// =============================================================================

export interface DayData {
  /** ISO date string (YYYY-MM-DD) */
  date: string
  /** Whether this is today */
  isToday: boolean
  /** Whether this is a future date */
  isFuture: boolean
}

export interface DayHeader {
  /** Day name (Monday, Tuesday, etc.) */
  dayName: string
  /** Formatted date string */
  dateStr: string
  /** Month and year for display */
  monthYear: string
  /** Whether this is today */
  isToday: boolean
  /** Whether this is a future date */
  isFuture: boolean
}

// =============================================================================
// DATE GENERATION
// =============================================================================

/**
 * Get today's date as ISO string (YYYY-MM-DD)
 */
export function getTodayString(): string {
  return formatDateToISO(new Date())
}

/**
 * Format a Date to ISO date string (YYYY-MM-DD)
 */
export function formatDateToISO(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Parse an ISO date string to Date object
 */
export function parseISODate(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(year, month - 1, day)
}

/**
 * Add days to a date
 */
export function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

/**
 * Generate a range of dates centered around a given date
 * @param centerDate - The center date (usually today)
 * @param pastDays - Number of past days to generate (default 14)
 * @param futureDays - Number of future days to generate (default 7)
 */
export function generateDateRange(
  centerDate: Date = new Date(),
  pastDays: number = 14,
  futureDays: number = 7
): DayData[] {
  const today = formatDateToISO(new Date())
  const days: DayData[] = []

  // Generate past days (oldest first)
  for (let i = pastDays; i > 0; i--) {
    const date = addDays(centerDate, -i)
    const dateStr = formatDateToISO(date)
    days.push({
      date: dateStr,
      isToday: dateStr === today,
      isFuture: dateStr > today,
    })
  }

  // Add center date (today)
  const centerDateStr = formatDateToISO(centerDate)
  days.push({
    date: centerDateStr,
    isToday: centerDateStr === today,
    isFuture: centerDateStr > today,
  })

  // Generate future days
  for (let i = 1; i <= futureDays; i++) {
    const date = addDays(centerDate, i)
    const dateStr = formatDateToISO(date)
    days.push({
      date: dateStr,
      isToday: false,
      isFuture: true,
    })
  }

  return days
}

/**
 * Generate more past days from a given oldest date
 */
export function generateMorePastDays(oldestDate: string, count: number = 14): DayData[] {
  const today = formatDateToISO(new Date())
  const startDate = parseISODate(oldestDate)
  const days: DayData[] = []

  for (let i = count; i > 0; i--) {
    const date = addDays(startDate, -i)
    const dateStr = formatDateToISO(date)
    days.push({
      date: dateStr,
      isToday: dateStr === today,
      isFuture: dateStr > today,
    })
  }

  return days
}

/**
 * Generate more future days from a given newest date
 */
export function generateMoreFutureDays(newestDate: string, count: number = 14): DayData[] {
  const today = formatDateToISO(new Date())
  const startDate = parseISODate(newestDate)
  const days: DayData[] = []

  for (let i = 1; i <= count; i++) {
    const date = addDays(startDate, i)
    const dateStr = formatDateToISO(date)
    days.push({
      date: dateStr,
      isToday: false,
      isFuture: dateStr > today,
    })
  }

  return days
}

// =============================================================================
// DATE FORMATTING
// =============================================================================

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                     'July', 'August', 'September', 'October', 'November', 'December']

/**
 * Format a date for day card header
 */
export function formatDayHeader(dateStr: string): DayHeader {
  const date = parseISODate(dateStr)
  const today = formatDateToISO(new Date())

  const dayName = DAY_NAMES[date.getDay()]
  const monthName = MONTH_NAMES[date.getMonth()]
  const dayNum = date.getDate()
  const year = date.getFullYear()

  return {
    dayName,
    dateStr: `${monthName} ${dayNum}, ${year}`,
    monthYear: `${monthName} ${year}`,
    isToday: dateStr === today,
    isFuture: dateStr > today,
  }
}

// =============================================================================
// OPACITY CALCULATION
// =============================================================================

/**
 * Calculate opacity based on distance from active day
 * @param distance - Number of days from active day (0 = active)
 * @returns Opacity value between 0.25 and 1.0
 */
export function getOpacityForDistance(distance: number): number {
  const absDistance = Math.abs(distance)

  if (absDistance === 0) return 1.0    // Active day
  if (absDistance === 1) return 0.7    // Adjacent days
  if (absDistance === 2) return 0.5    // 2 days away
  if (absDistance === 3) return 0.35   // 3 days away
  return 0.25                          // 4+ days away (minimum)
}

/**
 * Calculate distance between two date strings
 */
export function getDateDistance(date1: string, date2: string): number {
  const d1 = parseISODate(date1)
  const d2 = parseISODate(date2)
  const diffTime = d1.getTime() - d2.getTime()
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24))
  return diffDays
}

// =============================================================================
// GREETING
// =============================================================================

export interface TimeGreeting {
  /** Greeting text (Good morning, Good afternoon, etc.) */
  greeting: string
  /** Icon for the greeting */
  icon: string
}

/**
 * Get time-based greeting for today's day card
 * @returns Greeting text and icon based on current hour
 */
export function getTimeBasedGreeting(): TimeGreeting {
  const hour = new Date().getHours()

  if (hour >= 5 && hour < 12) {
    return { greeting: 'Good morning', icon: '🌅' }
  } else if (hour >= 12 && hour < 17) {
    return { greeting: 'Good afternoon', icon: '☀️' }
  } else if (hour >= 17 && hour < 21) {
    return { greeting: 'Good evening', icon: '🌆' }
  } else {
    return { greeting: 'Good night', icon: '🌙' }
  }
}

/**
 * Check if a date is yesterday relative to today
 */
export function isYesterday(dateStr: string): boolean {
  const today = new Date()
  const yesterday = addDays(today, -1)
  return dateStr === formatDateToISO(yesterday)
}

/**
 * Check if a date is tomorrow relative to today
 */
export function isTomorrow(dateStr: string): boolean {
  const today = new Date()
  const tomorrow = addDays(today, 1)
  return dateStr === formatDateToISO(tomorrow)
}

/**
 * Get special day label (Today, Yesterday, Tomorrow) or null
 */
export function getSpecialDayLabel(dateStr: string): string | null {
  const today = formatDateToISO(new Date())

  if (dateStr === today) return 'Today'
  if (isYesterday(dateStr)) return 'Yesterday'
  if (isTomorrow(dateStr)) return 'Tomorrow'
  return null
}

// =============================================================================
// BREADCRUMB NAVIGATION HELPERS
// =============================================================================

export interface DateParts {
  /** Day number (1-31) */
  day: number
  /** Month name (January, February, etc.) */
  month: string
  /** Month index (0-11) */
  monthIndex: number
  /** Full year (2025) */
  year: number
  /** Day name (Monday, Tuesday, etc.) */
  dayName: string
}

/**
 * Parse a date string into its clickable parts for breadcrumb navigation
 */
export function formatDateParts(dateStr: string): DateParts {
  const date = parseISODate(dateStr)
  return {
    day: date.getDate(),
    month: MONTH_NAMES[date.getMonth()],
    monthIndex: date.getMonth(),
    year: date.getFullYear(),
    dayName: DAY_NAMES[date.getDay()],
  }
}

/**
 * Get all days in a specific month
 */
export function getDaysInMonth(year: number, month: number): DayData[] {
  const today = formatDateToISO(new Date())
  const days: DayData[] = []

  // Get the number of days in the month
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month, day)
    const dateStr = formatDateToISO(date)
    days.push({
      date: dateStr,
      isToday: dateStr === today,
      isFuture: dateStr > today,
    })
  }

  return days
}

export interface MonthStat {
  /** Month index (0-11) */
  month: number
  /** Month name */
  monthName: string
  /** Number of days with entries */
  entryCount: number
  /** Total character count for the month */
  totalChars: number
  /** Activity levels for mini heatmap (up to 5 dots) */
  activityDots: (0 | 1 | 2 | 3 | 4)[]
}

/**
 * Get month statistics for year view
 */
export function getMonthStats(
  year: number,
  heatmapData: Array<{ date: string; characterCount: number; level: 0 | 1 | 2 | 3 | 4 }>
): MonthStat[] {
  const stats: MonthStat[] = []

  for (let month = 0; month < 12; month++) {
    const monthName = MONTH_NAMES[month]

    // Filter heatmap data for this month
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
    const monthEntries = heatmapData.filter(entry => entry.date.startsWith(monthPrefix))

    // Calculate stats
    const entriesWithContent = monthEntries.filter(e => e.characterCount > 0)
    const entryCount = entriesWithContent.length
    const totalChars = monthEntries.reduce((sum, e) => sum + e.characterCount, 0)

    // Generate activity dots (sample 5 weeks worth of data)
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const weekCount = Math.ceil(daysInMonth / 7)
    const activityDots: (0 | 1 | 2 | 3 | 4)[] = []

    for (let week = 0; week < Math.min(weekCount, 5); week++) {
      // Get max level for this week
      const weekStart = week * 7 + 1
      const weekEnd = Math.min(weekStart + 6, daysInMonth)
      let maxLevel: 0 | 1 | 2 | 3 | 4 = 0

      for (let day = weekStart; day <= weekEnd; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        const entry = monthEntries.find(e => e.date === dateStr)
        if (entry && entry.level > maxLevel) {
          maxLevel = entry.level
        }
      }
      activityDots.push(maxLevel)
    }

    stats.push({
      month,
      monthName,
      entryCount,
      totalChars,
      activityDots,
    })
  }

  return stats
}

/**
 * Get month name from month index
 */
export function getMonthName(monthIndex: number): string {
  return MONTH_NAMES[monthIndex]
}
