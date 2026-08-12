/**
 * Journal Utilities Tests
 * Comprehensive tests for date generation, formatting, and utility functions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  // Types
  DayHeader,
  DateParts,
  TimeGreeting,
  MonthStat,
  type JournalDateLabels,
  // Date Generation Functions (T111)
  getTodayString,
  formatDateToISO,
  parseISODate,
  addDays,
  // Date Formatting & Headers (T113)
  formatDayHeader,
  formatDateParts,
  getMonthName,
  // Special Days & Greeting (T115)
  getTimeBasedGreeting,
  isYesterday,
  isTomorrow,
  getSpecialDayLabel,
  getDaysInMonth,
  getMonthStats
} from './journal-utils'

// =============================================================================
// TEST SETUP
// =============================================================================

const CUSTOM_DATE_LABELS: JournalDateLabels = {
  weekdays: [
    'Weekday-0',
    'Weekday-1',
    'Weekday-2',
    'Weekday-3',
    'Weekday-4',
    'Weekday-5',
    'Weekday-6'
  ],
  weekdaysShort: ['W0', 'W1', 'W2', 'W3', 'W4', 'W5', 'W6'],
  months: [
    'Month-0',
    'Month-1',
    'Month-2',
    'Month-3',
    'Month-4',
    'Month-5',
    'Month-6',
    'Month-7',
    'Month-8',
    'Month-9',
    'Month-10',
    'Month-11'
  ],
  monthsShort: ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10', 'M11'],
  relative: {
    today: 'Custom today',
    yesterday: 'Custom yesterday',
    tomorrow: 'Custom tomorrow',
    future: 'Custom future'
  },
  greetings: {
    morning: 'Custom morning',
    afternoon: 'Custom afternoon',
    evening: 'Custom evening',
    night: 'Custom night'
  }
}

describe('journal-utils', () => {
  beforeEach(() => {
    // Use fake timers for deterministic date testing
    vi.useFakeTimers()
    // Set system time to January 15, 2026, 10:00 AM
    vi.setSystemTime(new Date(2026, 0, 15, 10, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ===========================================================================
  // T111: Date Generation Functions
  // ===========================================================================

  describe('T111: Date Generation Functions', () => {
    describe('getTodayString', () => {
      it('returns today as ISO string (YYYY-MM-DD)', () => {
        const result = getTodayString()
        expect(result).toBe('2026-01-15')
      })

      it('returns correct format with zero-padded month', () => {
        vi.setSystemTime(new Date(2026, 0, 5))
        const result = getTodayString()
        expect(result).toBe('2026-01-05')
      })

      it('returns correct format with zero-padded day', () => {
        vi.setSystemTime(new Date(2026, 8, 3))
        const result = getTodayString()
        expect(result).toBe('2026-09-03')
      })

      it('handles year boundaries correctly', () => {
        vi.setSystemTime(new Date(2025, 11, 31))
        expect(getTodayString()).toBe('2025-12-31')

        vi.setSystemTime(new Date(2026, 0, 1))
        expect(getTodayString()).toBe('2026-01-01')
      })
    })

    describe('formatDateToISO', () => {
      it('converts Date to YYYY-MM-DD format', () => {
        const date = new Date(2026, 0, 15)
        expect(formatDateToISO(date)).toBe('2026-01-15')
      })

      it('zero-pads single-digit months', () => {
        const date = new Date(2026, 4, 15) // May
        expect(formatDateToISO(date)).toBe('2026-05-15')
      })

      it('zero-pads single-digit days', () => {
        const date = new Date(2026, 0, 7)
        expect(formatDateToISO(date)).toBe('2026-01-07')
      })

      it('handles December correctly (month 11)', () => {
        const date = new Date(2026, 11, 25)
        expect(formatDateToISO(date)).toBe('2026-12-25')
      })

      it('handles January correctly (month 0)', () => {
        const date = new Date(2026, 0, 1)
        expect(formatDateToISO(date)).toBe('2026-01-01')
      })

      it('handles leap year February 29', () => {
        const date = new Date(2024, 1, 29)
        expect(formatDateToISO(date)).toBe('2024-02-29')
      })
    })

    describe('parseISODate', () => {
      it('parses YYYY-MM-DD to Date object', () => {
        const result = parseISODate('2026-01-15')
        expect(result.getFullYear()).toBe(2026)
        expect(result.getMonth()).toBe(0) // January
        expect(result.getDate()).toBe(15)
      })

      it('parses zero-padded months correctly', () => {
        const result = parseISODate('2026-05-10')
        expect(result.getMonth()).toBe(4) // May (0-indexed)
      })

      it('parses zero-padded days correctly', () => {
        const result = parseISODate('2026-01-05')
        expect(result.getDate()).toBe(5)
      })

      it('parses December correctly', () => {
        const result = parseISODate('2026-12-31')
        expect(result.getMonth()).toBe(11) // December
        expect(result.getDate()).toBe(31)
      })

      it('round-trips with formatDateToISO', () => {
        const original = '2026-07-22'
        const date = parseISODate(original)
        const formatted = formatDateToISO(date)
        expect(formatted).toBe(original)
      })
    })

    describe('addDays', () => {
      it('adds positive days correctly', () => {
        const date = new Date(2026, 0, 15)
        const result = addDays(date, 5)
        expect(formatDateToISO(result)).toBe('2026-01-20')
      })

      it('subtracts days with negative number', () => {
        const date = new Date(2026, 0, 15)
        const result = addDays(date, -5)
        expect(formatDateToISO(result)).toBe('2026-01-10')
      })

      it('handles month boundaries when adding', () => {
        const date = new Date(2026, 0, 30)
        const result = addDays(date, 5)
        expect(formatDateToISO(result)).toBe('2026-02-04')
      })

      it('handles month boundaries when subtracting', () => {
        const date = new Date(2026, 1, 5)
        const result = addDays(date, -10)
        expect(formatDateToISO(result)).toBe('2026-01-26')
      })

      it('handles year boundaries when adding', () => {
        const date = new Date(2025, 11, 30)
        const result = addDays(date, 5)
        expect(formatDateToISO(result)).toBe('2026-01-04')
      })

      it('handles year boundaries when subtracting', () => {
        const date = new Date(2026, 0, 5)
        const result = addDays(date, -10)
        expect(formatDateToISO(result)).toBe('2025-12-26')
      })

      it('does not mutate the original date', () => {
        const date = new Date(2026, 0, 15)
        const originalTime = date.getTime()
        addDays(date, 10)
        expect(date.getTime()).toBe(originalTime)
      })

      it('handles adding zero days', () => {
        const date = new Date(2026, 0, 15)
        const result = addDays(date, 0)
        expect(formatDateToISO(result)).toBe('2026-01-15')
      })

      it('handles leap year February', () => {
        const date = new Date(2024, 1, 28)
        const result = addDays(date, 2)
        expect(formatDateToISO(result)).toBe('2024-03-01')
      })
    })
  })

  // ===========================================================================
  // T113: Date Formatting & Headers
  // ===========================================================================

  describe('T113: Date Formatting & Headers', () => {
    describe('formatDayHeader', () => {
      it('returns correct DayHeader structure', () => {
        const result = formatDayHeader('2026-01-15')
        expect(result).toHaveProperty('dayName')
        expect(result).toHaveProperty('dateStr')
        expect(result).toHaveProperty('monthYear')
        expect(result).toHaveProperty('isToday')
        expect(result).toHaveProperty('isFuture')
      })

      it('returns correct dayName for Thursday (Jan 15, 2026)', () => {
        const result = formatDayHeader('2026-01-15')
        expect(result.dayName).toBe('Thursday')
      })

      it('returns formatted dateStr as "Month Day, Year"', () => {
        const result = formatDayHeader('2026-01-15')
        expect(result.dateStr).toBe('January 15, 2026')
      })

      it('returns monthYear as "Month Year"', () => {
        const result = formatDayHeader('2026-01-15')
        expect(result.monthYear).toBe('January 2026')
      })

      it('uses provided date labels for formatted strings', () => {
        const result = formatDayHeader('2026-04-15', CUSTOM_DATE_LABELS)

        expect(result.dayName).toBe('Weekday-3')
        expect(result.dateStr).toBe('Month-3 15, 2026')
        expect(result.monthYear).toBe('Month-3 2026')
      })

      it('sets isToday=true for current date', () => {
        const result = formatDayHeader('2026-01-15')
        expect(result.isToday).toBe(true)
      })

      it('sets isToday=false for other dates', () => {
        const result = formatDayHeader('2026-01-14')
        expect(result.isToday).toBe(false)
      })

      it('sets isFuture=true for future dates', () => {
        const result = formatDayHeader('2026-01-20')
        expect(result.isFuture).toBe(true)
      })

      it('sets isFuture=false for past dates', () => {
        const result = formatDayHeader('2026-01-10')
        expect(result.isFuture).toBe(false)
      })

      it('sets isFuture=false for today', () => {
        const result = formatDayHeader('2026-01-15')
        expect(result.isFuture).toBe(false)
      })

      it('handles all days of the week correctly', () => {
        const days = [
          { date: '2026-01-11', expected: 'Sunday' },
          { date: '2026-01-12', expected: 'Monday' },
          { date: '2026-01-13', expected: 'Tuesday' },
          { date: '2026-01-14', expected: 'Wednesday' },
          { date: '2026-01-15', expected: 'Thursday' },
          { date: '2026-01-16', expected: 'Friday' },
          { date: '2026-01-17', expected: 'Saturday' }
        ]
        days.forEach(({ date, expected }) => {
          expect(formatDayHeader(date).dayName).toBe(expected)
        })
      })
    })

    describe('formatDateParts', () => {
      it('returns correct DateParts structure', () => {
        const result = formatDateParts('2026-01-15')
        expect(result).toHaveProperty('day')
        expect(result).toHaveProperty('month')
        expect(result).toHaveProperty('monthIndex')
        expect(result).toHaveProperty('year')
        expect(result).toHaveProperty('dayName')
      })

      it('returns correct day number', () => {
        const result = formatDateParts('2026-01-15')
        expect(result.day).toBe(15)
      })

      it('returns correct month name', () => {
        const result = formatDateParts('2026-01-15')
        expect(result.month).toBe('January')
      })

      it('returns correct monthIndex (0-indexed)', () => {
        const result = formatDateParts('2026-01-15')
        expect(result.monthIndex).toBe(0)
      })

      it('returns correct year', () => {
        const result = formatDateParts('2026-01-15')
        expect(result.year).toBe(2026)
      })

      it('returns correct dayName', () => {
        const result = formatDateParts('2026-01-15')
        expect(result.dayName).toBe('Thursday')
      })

      it('uses provided labels for month and weekday names', () => {
        const result = formatDateParts('2026-04-15', CUSTOM_DATE_LABELS)

        expect(result.month).toBe('Month-3')
        expect(result.dayName).toBe('Weekday-3')
      })

      it('handles all months correctly', () => {
        const months = [
          { date: '2026-01-15', month: 'January', monthIndex: 0 },
          { date: '2026-02-15', month: 'February', monthIndex: 1 },
          { date: '2026-03-15', month: 'March', monthIndex: 2 },
          { date: '2026-04-15', month: 'April', monthIndex: 3 },
          { date: '2026-05-15', month: 'May', monthIndex: 4 },
          { date: '2026-06-15', month: 'June', monthIndex: 5 },
          { date: '2026-07-15', month: 'July', monthIndex: 6 },
          { date: '2026-08-15', month: 'August', monthIndex: 7 },
          { date: '2026-09-15', month: 'September', monthIndex: 8 },
          { date: '2026-10-15', month: 'October', monthIndex: 9 },
          { date: '2026-11-15', month: 'November', monthIndex: 10 },
          { date: '2026-12-15', month: 'December', monthIndex: 11 }
        ]
        months.forEach(({ date, month, monthIndex }) => {
          const result = formatDateParts(date)
          expect(result.month).toBe(month)
          expect(result.monthIndex).toBe(monthIndex)
        })
      })
    })

    describe('getMonthName', () => {
      it('returns January for index 0', () => {
        expect(getMonthName(0)).toBe('January')
      })

      it('returns February for index 1', () => {
        expect(getMonthName(1)).toBe('February')
      })

      it('returns December for index 11', () => {
        expect(getMonthName(11)).toBe('December')
      })

      it('uses provided labels for month names', () => {
        expect(getMonthName(3, CUSTOM_DATE_LABELS)).toBe('Month-3')
      })

      it('returns correct names for all months', () => {
        const expected = [
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
        ]
        expected.forEach((month, index) => {
          expect(getMonthName(index)).toBe(month)
        })
      })
    })
  })

  // ===========================================================================
  // T115: Special Days & Greeting
  // ===========================================================================

  describe('T115: Special Days & Greeting', () => {
    describe('getTimeBasedGreeting', () => {
      it('returns "Good morning" with sunrise emoji for 5-11', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 5, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good morning', icon: '🌅' })

        vi.setSystemTime(new Date(2026, 0, 15, 8, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good morning', icon: '🌅' })

        vi.setSystemTime(new Date(2026, 0, 15, 11, 59, 59))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good morning', icon: '🌅' })
      })

      it('uses provided greeting labels', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 8, 0, 0))

        expect(getTimeBasedGreeting(CUSTOM_DATE_LABELS)).toEqual({
          greeting: 'Custom morning',
          icon: '🌅'
        })
      })

      it('returns "Good afternoon" with sun emoji for 12-16', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good afternoon', icon: '☀️' })

        vi.setSystemTime(new Date(2026, 0, 15, 14, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good afternoon', icon: '☀️' })

        vi.setSystemTime(new Date(2026, 0, 15, 16, 59, 59))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good afternoon', icon: '☀️' })
      })

      it('returns "Good evening" with sunset emoji for 17-20', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 17, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good evening', icon: '🌆' })

        vi.setSystemTime(new Date(2026, 0, 15, 19, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good evening', icon: '🌆' })

        vi.setSystemTime(new Date(2026, 0, 15, 20, 59, 59))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good evening', icon: '🌆' })
      })

      it('returns "Good night" with moon emoji for 21-4', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 21, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good night', icon: '🌙' })

        vi.setSystemTime(new Date(2026, 0, 15, 23, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good night', icon: '🌙' })

        vi.setSystemTime(new Date(2026, 0, 15, 0, 0, 0))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good night', icon: '🌙' })

        vi.setSystemTime(new Date(2026, 0, 15, 4, 59, 59))
        expect(getTimeBasedGreeting()).toEqual({ greeting: 'Good night', icon: '🌙' })
      })

      it('handles boundary at 5:00 (transition to morning)', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 4, 59, 59))
        expect(getTimeBasedGreeting().greeting).toBe('Good night')

        vi.setSystemTime(new Date(2026, 0, 15, 5, 0, 0))
        expect(getTimeBasedGreeting().greeting).toBe('Good morning')
      })

      it('handles boundary at 12:00 (transition to afternoon)', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 11, 59, 59))
        expect(getTimeBasedGreeting().greeting).toBe('Good morning')

        vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0))
        expect(getTimeBasedGreeting().greeting).toBe('Good afternoon')
      })

      it('handles boundary at 17:00 (transition to evening)', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 16, 59, 59))
        expect(getTimeBasedGreeting().greeting).toBe('Good afternoon')

        vi.setSystemTime(new Date(2026, 0, 15, 17, 0, 0))
        expect(getTimeBasedGreeting().greeting).toBe('Good evening')
      })

      it('handles boundary at 21:00 (transition to night)', () => {
        vi.setSystemTime(new Date(2026, 0, 15, 20, 59, 59))
        expect(getTimeBasedGreeting().greeting).toBe('Good evening')

        vi.setSystemTime(new Date(2026, 0, 15, 21, 0, 0))
        expect(getTimeBasedGreeting().greeting).toBe('Good night')
      })
    })

    describe('isYesterday', () => {
      it('returns true for yesterday', () => {
        expect(isYesterday('2026-01-14')).toBe(true)
      })

      it('returns false for today', () => {
        expect(isYesterday('2026-01-15')).toBe(false)
      })

      it('returns false for tomorrow', () => {
        expect(isYesterday('2026-01-16')).toBe(false)
      })

      it('returns false for other past dates', () => {
        expect(isYesterday('2026-01-13')).toBe(false)
      })

      it('handles month boundary', () => {
        vi.setSystemTime(new Date(2026, 1, 1, 10, 0, 0)) // Feb 1
        expect(isYesterday('2026-01-31')).toBe(true)
      })

      it('handles year boundary', () => {
        vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0)) // Jan 1
        expect(isYesterday('2025-12-31')).toBe(true)
      })
    })

    describe('isTomorrow', () => {
      it('returns true for tomorrow', () => {
        expect(isTomorrow('2026-01-16')).toBe(true)
      })

      it('returns false for today', () => {
        expect(isTomorrow('2026-01-15')).toBe(false)
      })

      it('returns false for yesterday', () => {
        expect(isTomorrow('2026-01-14')).toBe(false)
      })

      it('returns false for other future dates', () => {
        expect(isTomorrow('2026-01-17')).toBe(false)
      })

      it('handles month boundary', () => {
        vi.setSystemTime(new Date(2026, 0, 31, 10, 0, 0)) // Jan 31
        expect(isTomorrow('2026-02-01')).toBe(true)
      })

      it('handles year boundary', () => {
        vi.setSystemTime(new Date(2025, 11, 31, 10, 0, 0)) // Dec 31
        expect(isTomorrow('2026-01-01')).toBe(true)
      })
    })

    describe('getSpecialDayLabel', () => {
      it('returns "Today" for current date', () => {
        expect(getSpecialDayLabel('2026-01-15')).toBe('Today')
      })

      it('returns "Yesterday" for yesterday', () => {
        expect(getSpecialDayLabel('2026-01-14')).toBe('Yesterday')
      })

      it('returns "Tomorrow" for tomorrow', () => {
        expect(getSpecialDayLabel('2026-01-16')).toBe('Tomorrow')
      })

      it('returns null for other dates', () => {
        expect(getSpecialDayLabel('2026-01-13')).toBeNull()
        expect(getSpecialDayLabel('2026-01-17')).toBeNull()
        expect(getSpecialDayLabel('2026-01-01')).toBeNull()
      })

      it('uses provided relative labels', () => {
        expect(getSpecialDayLabel('2026-01-15', CUSTOM_DATE_LABELS)).toBe('Custom today')
        expect(getSpecialDayLabel('2026-01-14', CUSTOM_DATE_LABELS)).toBe('Custom yesterday')
        expect(getSpecialDayLabel('2026-01-16', CUSTOM_DATE_LABELS)).toBe('Custom tomorrow')
      })

      it('handles month boundaries correctly', () => {
        vi.setSystemTime(new Date(2026, 1, 1, 10, 0, 0)) // Feb 1
        expect(getSpecialDayLabel('2026-02-01')).toBe('Today')
        expect(getSpecialDayLabel('2026-01-31')).toBe('Yesterday')
        expect(getSpecialDayLabel('2026-02-02')).toBe('Tomorrow')
      })
    })

    describe('getDaysInMonth', () => {
      it('returns correct number of days for January (31)', () => {
        const result = getDaysInMonth(2026, 0)
        expect(result.length).toBe(31)
      })

      it('returns correct number of days for February non-leap year (28)', () => {
        const result = getDaysInMonth(2026, 1)
        expect(result.length).toBe(28)
      })

      it('returns correct number of days for February leap year (29)', () => {
        const result = getDaysInMonth(2024, 1)
        expect(result.length).toBe(29)
      })

      it('returns correct number of days for April (30)', () => {
        const result = getDaysInMonth(2026, 3)
        expect(result.length).toBe(30)
      })

      it('returns DayData with correct structure', () => {
        const result = getDaysInMonth(2026, 0)
        result.forEach((day) => {
          expect(day).toHaveProperty('date')
          expect(day).toHaveProperty('isToday')
          expect(day).toHaveProperty('isFuture')
        })
      })

      it('marks today correctly within the month', () => {
        const result = getDaysInMonth(2026, 0) // January 2026
        const todayEntry = result.find((d) => d.date === '2026-01-15')
        expect(todayEntry).toBeDefined()
        expect(todayEntry!.isToday).toBe(true)
      })

      it('marks only one day as today', () => {
        const result = getDaysInMonth(2026, 0)
        const todayCount = result.filter((d) => d.isToday).length
        expect(todayCount).toBe(1)
      })

      it('marks no day as today for other months', () => {
        const result = getDaysInMonth(2026, 2) // March
        const todayCount = result.filter((d) => d.isToday).length
        expect(todayCount).toBe(0)
      })

      it('marks future dates correctly', () => {
        const result = getDaysInMonth(2026, 0) // January 2026
        const futureDays = result.filter((d) => d.isFuture)
        // Days 16-31 are in the future (16 days)
        expect(futureDays.length).toBe(16)
      })

      it('returns dates in chronological order', () => {
        const result = getDaysInMonth(2026, 0)
        for (let i = 1; i < result.length; i++) {
          expect(result[i].date > result[i - 1].date).toBe(true)
        }
      })

      it('first date is the 1st of the month', () => {
        const result = getDaysInMonth(2026, 0)
        expect(result[0].date).toBe('2026-01-01')
      })

      it('last date is the last day of the month', () => {
        const result = getDaysInMonth(2026, 0)
        expect(result[result.length - 1].date).toBe('2026-01-31')
      })
    })

    describe('getMonthStats', () => {
      it('returns 12 MonthStat objects for a year', () => {
        const result = getMonthStats(2026, [])
        expect(result.length).toBe(12)
      })

      it('returns correct MonthStat structure', () => {
        const result = getMonthStats(2026, [])
        result.forEach((stat) => {
          expect(stat).toHaveProperty('month')
          expect(stat).toHaveProperty('monthName')
          expect(stat).toHaveProperty('entryCount')
          expect(stat).toHaveProperty('totalChars')
          expect(stat).toHaveProperty('activityDots')
        })
      })

      it('returns correct month indices (0-11)', () => {
        const result = getMonthStats(2026, [])
        result.forEach((stat, index) => {
          expect(stat.month).toBe(index)
        })
      })

      it('returns correct month names', () => {
        const result = getMonthStats(2026, [])
        const expected = [
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
        ]
        result.forEach((stat, index) => {
          expect(stat.monthName).toBe(expected[index])
        })
      })

      it('uses provided labels for month names', () => {
        const result = getMonthStats(2026, [], CUSTOM_DATE_LABELS)

        expect(result[0].monthName).toBe('Month-0')
        expect(result[3].monthName).toBe('Month-3')
      })

      it('calculates entryCount correctly', () => {
        const heatmapData = [
          { date: '2026-01-01', characterCount: 100, level: 1 as const },
          { date: '2026-01-02', characterCount: 200, level: 2 as const },
          { date: '2026-01-03', characterCount: 0, level: 0 as const } // No content
        ]
        const result = getMonthStats(2026, heatmapData)
        expect(result[0].entryCount).toBe(2) // Only entries with content
      })

      it('calculates totalChars correctly', () => {
        const heatmapData = [
          { date: '2026-01-01', characterCount: 100, level: 1 as const },
          { date: '2026-01-02', characterCount: 200, level: 2 as const },
          { date: '2026-01-03', characterCount: 50, level: 1 as const }
        ]
        const result = getMonthStats(2026, heatmapData)
        expect(result[0].totalChars).toBe(350)
      })

      it('returns zero counts for months with no data', () => {
        const result = getMonthStats(2026, [])
        result.forEach((stat) => {
          expect(stat.entryCount).toBe(0)
          expect(stat.totalChars).toBe(0)
        })
      })

      it('generates activityDots array', () => {
        const heatmapData = [
          { date: '2026-01-01', characterCount: 100, level: 2 as const },
          { date: '2026-01-08', characterCount: 200, level: 3 as const },
          { date: '2026-01-15', characterCount: 300, level: 4 as const }
        ]
        const result = getMonthStats(2026, heatmapData)
        expect(Array.isArray(result[0].activityDots)).toBe(true)
        expect(result[0].activityDots.length).toBeGreaterThan(0)
        expect(result[0].activityDots.length).toBeLessThanOrEqual(5)
      })

      it('activityDots contains valid values (0-4)', () => {
        const heatmapData = [
          { date: '2026-01-01', characterCount: 100, level: 2 as const },
          { date: '2026-01-08', characterCount: 200, level: 3 as const }
        ]
        const result = getMonthStats(2026, heatmapData)
        result[0].activityDots.forEach((dot) => {
          expect(dot).toBeGreaterThanOrEqual(0)
          expect(dot).toBeLessThanOrEqual(4)
        })
      })

      it('activityDots represents max level per week', () => {
        const heatmapData = [
          { date: '2026-01-01', characterCount: 100, level: 1 as const },
          { date: '2026-01-02', characterCount: 200, level: 3 as const },
          { date: '2026-01-03', characterCount: 50, level: 2 as const }
        ]
        const result = getMonthStats(2026, heatmapData)
        // First week (days 1-7) should have max level 3
        expect(result[0].activityDots[0]).toBe(3)
      })

      it('separates data by month correctly', () => {
        const heatmapData = [
          { date: '2026-01-15', characterCount: 100, level: 1 as const },
          { date: '2026-02-15', characterCount: 200, level: 2 as const }
        ]
        const result = getMonthStats(2026, heatmapData)
        expect(result[0].entryCount).toBe(1)
        expect(result[0].totalChars).toBe(100)
        expect(result[1].entryCount).toBe(1)
        expect(result[1].totalChars).toBe(200)
      })

      it('handles year parameter correctly', () => {
        const heatmapData = [
          { date: '2026-01-15', characterCount: 100, level: 1 as const },
          { date: '2025-01-15', characterCount: 200, level: 2 as const }
        ]
        const result = getMonthStats(2026, heatmapData)
        expect(result[0].entryCount).toBe(1)
        expect(result[0].totalChars).toBe(100)
      })
    })
  })
})
