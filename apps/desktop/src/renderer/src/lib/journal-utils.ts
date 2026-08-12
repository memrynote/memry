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

export type JournalDateLabels = {
  weekdays: readonly string[]
  weekdaysShort: readonly string[]
  months: readonly string[]
  monthsShort: readonly string[]
  relative: {
    today: string
    yesterday: string
    tomorrow: string
    future: string
  }
  greetings: {
    morning: string
    afternoon: string
    evening: string
    night: string
  }
}

export const ENGLISH_JOURNAL_DATE_LABELS: JournalDateLabels = {
  weekdays: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  weekdaysShort: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  months: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December'
  ],
  monthsShort: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  relative: {
    today: 'Today',
    yesterday: 'Yesterday',
    tomorrow: 'Tomorrow',
    future: 'Future'
  },
  greetings: {
    morning: 'Good morning',
    afternoon: 'Good afternoon',
    evening: 'Good evening',
    night: 'Good night'
  }
}

export const JOURNAL_WEEKDAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday'
] as const

export const JOURNAL_MONTH_KEYS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
] as const

export function createJournalDateLabels(t: (key: string) => string): JournalDateLabels {
  return {
    weekdays: JOURNAL_WEEKDAY_KEYS.map((key) => t(`date.weekday.${key}`)),
    weekdaysShort: JOURNAL_WEEKDAY_KEYS.map((key) => t(`date.weekdayShort.${key}`)),
    months: JOURNAL_MONTH_KEYS.map((key) => t(`date.month.${key}`)),
    monthsShort: JOURNAL_MONTH_KEYS.map((key) => t(`date.monthShort.${key}`)),
    relative: {
      today: t('date.relative.today'),
      yesterday: t('date.relative.yesterday'),
      tomorrow: t('date.relative.tomorrow'),
      future: t('date.relative.future')
    },
    greetings: {
      morning: t('date.greeting.morning'),
      afternoon: t('date.greeting.afternoon'),
      evening: t('date.greeting.evening'),
      night: t('date.greeting.night')
    }
  }
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

// =============================================================================
// DATE FORMATTING
// =============================================================================

/**
 * Format a date for day card header
 */
export function formatDayHeader(
  dateStr: string,
  labels: JournalDateLabels = ENGLISH_JOURNAL_DATE_LABELS
): DayHeader {
  const date = parseISODate(dateStr)
  const today = formatDateToISO(new Date())

  const dayName = labels.weekdays[date.getDay()]
  const monthName = labels.months[date.getMonth()]
  const dayNum = date.getDate()
  const year = date.getFullYear()

  return {
    dayName,
    dateStr: `${monthName} ${dayNum}, ${year}`,
    monthYear: `${monthName} ${year}`,
    isToday: dateStr === today,
    isFuture: dateStr > today
  }
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
export function getTimeBasedGreeting(
  labels: JournalDateLabels = ENGLISH_JOURNAL_DATE_LABELS
): TimeGreeting {
  const hour = new Date().getHours()

  if (hour >= 5 && hour < 12) {
    return { greeting: labels.greetings.morning, icon: '🌅' }
  } else if (hour >= 12 && hour < 17) {
    return { greeting: labels.greetings.afternoon, icon: '☀️' }
  } else if (hour >= 17 && hour < 21) {
    return { greeting: labels.greetings.evening, icon: '🌆' }
  } else {
    return { greeting: labels.greetings.night, icon: '🌙' }
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
export function getSpecialDayLabel(
  dateStr: string,
  labels: JournalDateLabels = ENGLISH_JOURNAL_DATE_LABELS
): string | null {
  const today = formatDateToISO(new Date())

  if (dateStr === today) return labels.relative.today
  if (isYesterday(dateStr)) return labels.relative.yesterday
  if (isTomorrow(dateStr)) return labels.relative.tomorrow
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
export function formatDateParts(
  dateStr: string,
  labels: JournalDateLabels = ENGLISH_JOURNAL_DATE_LABELS
): DateParts {
  const date = parseISODate(dateStr)
  return {
    day: date.getDate(),
    month: labels.months[date.getMonth()],
    monthIndex: date.getMonth(),
    year: date.getFullYear(),
    dayName: labels.weekdays[date.getDay()]
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
      isFuture: dateStr > today
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
  heatmapData: Array<{ date: string; characterCount: number; level: 0 | 1 | 2 | 3 | 4 }>,
  labels: JournalDateLabels = ENGLISH_JOURNAL_DATE_LABELS
): MonthStat[] {
  const stats: MonthStat[] = []

  for (let month = 0; month < 12; month++) {
    const monthName = labels.months[month]

    // Filter heatmap data for this month
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`
    const monthEntries = heatmapData.filter((entry) => entry.date.startsWith(monthPrefix))

    // Calculate stats
    const entriesWithContent = monthEntries.filter((e) => e.characterCount > 0)
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
        const entry = monthEntries.find((e) => e.date === dateStr)
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
      activityDots
    })
  }

  return stats
}

/**
 * Get month name from month index
 */
export function getMonthName(
  monthIndex: number,
  labels: JournalDateLabels = ENGLISH_JOURNAL_DATE_LABELS
): string {
  return labels.months[monthIndex]
}
