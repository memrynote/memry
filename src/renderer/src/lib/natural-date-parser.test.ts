// ============================================================================
// NATURAL DATE PARSER TESTS
// ============================================================================
// Tests for src/renderer/src/lib/natural-date-parser.ts
// Tasks: T031-T041

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  parseNaturalDate,
  nextSaturday,
  nextMonday,
  addWeeks,
  addMonths,
  type NaturalDateParseResult,
  type ParseResult,
  type ParseError
} from './natural-date-parser'

// ============================================================================
// TEST UTILITIES
// ============================================================================

// Reference date: Wednesday, January 14, 2026 12:00:00 (mid-week for day name tests)
// Note: Jan 14, 2026 is actually a Wednesday (Jan 15 is Thursday)
const REFERENCE_DATE = new Date(2026, 0, 14, 12, 0, 0)

// Helper to check if result is successful
const isSuccess = (result: NaturalDateParseResult): result is ParseResult => result.success

// Helper to check if result is an error
const isError = (result: NaturalDateParseResult): result is ParseError => !result.success

// Helper to get date string for comparison (YYYY-MM-DD)
const toDateString = (date: Date): string => {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// ============================================================================
// T031: TEST STRUCTURE
// ============================================================================

describe('Natural Date Parser', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(REFERENCE_DATE)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // ==========================================================================
  // T032: RELATIVE TERMS
  // ==========================================================================

  describe('parseNaturalDate - Relative Terms (T032)', () => {
    describe('"today"', () => {
      it("should return today's date", () => {
        const result = parseNaturalDate('today')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-14')
          expect(result.result.time).toBeNull()
        }
      })

      it('should handle uppercase', () => {
        const result = parseNaturalDate('TODAY')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-14')
        }
      })

      it('should handle mixed case', () => {
        const result = parseNaturalDate('Today')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-14')
        }
      })

      it('should handle leading/trailing whitespace', () => {
        const result = parseNaturalDate('  today  ')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-14')
        }
      })
    })

    describe('"tomorrow"', () => {
      it("should return tomorrow's date", () => {
        const result = parseNaturalDate('tomorrow')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-15')
          expect(result.result.time).toBeNull()
        }
      })

      it('should handle "tmrw" abbreviation', () => {
        const result = parseNaturalDate('tmrw')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-15')
        }
      })

      it('should handle "tmr" abbreviation', () => {
        const result = parseNaturalDate('tmr')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-15')
        }
      })
    })

    describe('"yesterday"', () => {
      it("should return yesterday's date", () => {
        const result = parseNaturalDate('yesterday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-13')
          expect(result.result.time).toBeNull()
        }
      })
    })
  })

  // ==========================================================================
  // T033: DAY NAMES
  // ==========================================================================

  describe('parseNaturalDate - Day Names (T033)', () => {
    // Reference: Wednesday, January 14, 2026
    // Sunday=0, Monday=1, Tuesday=2, Wednesday=3, Thursday=4, Friday=5, Saturday=6
    // Calendar:
    // Sun 11 | Mon 12 | Tue 13 | Wed 14 (today) | Thu 15 | Fri 16 | Sat 17
    // Sun 18 | Mon 19 | Tue 20 | Wed 21         | Thu 22 | Fri 23 | Sat 24

    describe('basic day names', () => {
      it('should return next Thursday for "thursday" (1 day ahead)', () => {
        const result = parseNaturalDate('thursday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-15')
        }
      })

      it('should return next Friday for "friday" (2 days ahead)', () => {
        const result = parseNaturalDate('friday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-16')
        }
      })

      it('should return next Saturday for "saturday" (3 days ahead)', () => {
        const result = parseNaturalDate('saturday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-17')
        }
      })

      it('should return next Sunday for "sunday" (4 days ahead)', () => {
        const result = parseNaturalDate('sunday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-18')
        }
      })

      it('should return next Monday for "monday" (5 days ahead)', () => {
        const result = parseNaturalDate('monday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-19')
        }
      })

      it('should return next Tuesday for "tuesday" (6 days ahead)', () => {
        const result = parseNaturalDate('tuesday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-20')
        }
      })

      it('should return next Wednesday for "wednesday" (7 days ahead)', () => {
        const result = parseNaturalDate('wednesday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          // Today is Wednesday, so "wednesday" means next Wednesday
          expect(toDateString(result.result.date)).toBe('2026-01-21')
        }
      })
    })

    describe('"next" prefix', () => {
      it('should return this week\'s Friday for "next friday" when Friday is ahead', () => {
        // Today is Wed Jan 14. Friday Jan 16 is ahead this week.
        // "next friday" behavior: if dayIndex > currentDay, returns this week's occurrence
        const result = parseNaturalDate('next friday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-16')
        }
      })

      it('should return following Monday for "next monday" (day already passed)', () => {
        // Today is Wed Jan 14. Monday Jan 12 passed this week.
        // "next monday" adds 7 days when dayIndex <= currentDay
        // getNextDayOfWeek returns Jan 19, then +7 = Jan 26
        const result = parseNaturalDate('next monday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-26')
        }
      })

      it('should return next week\'s Wednesday for "next wednesday"', () => {
        // Today is Wednesday. dayIndex (3) <= currentDay (3), so add 7
        // getNextDayOfWeek returns Jan 21, then +7 = Jan 28
        const result = parseNaturalDate('next wednesday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-28')
        }
      })
    })

    describe('"this" prefix', () => {
      it('should return this week\'s Friday for "this friday"', () => {
        const result = parseNaturalDate('this friday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-16')
        }
      })

      it('should return next Saturday for "this saturday"', () => {
        const result = parseNaturalDate('this saturday')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-17')
        }
      })
    })
  })

  // ==========================================================================
  // T034: RELATIVE DATES ("in X days/weeks/months")
  // ==========================================================================

  describe('parseNaturalDate - Relative Dates (T034)', () => {
    describe('"in X days"', () => {
      it('should add 1 day for "in 1 day"', () => {
        const result = parseNaturalDate('in 1 day')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-15')
        }
      })

      it('should add 3 days for "in 3 days"', () => {
        const result = parseNaturalDate('in 3 days')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-17')
        }
      })

      it('should add 7 days for "in 7 days"', () => {
        const result = parseNaturalDate('in 7 days')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-21')
        }
      })

      it('should add 30 days for "in 30 days"', () => {
        const result = parseNaturalDate('in 30 days')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-13')
        }
      })
    })

    describe('"in X weeks"', () => {
      it('should add 1 week for "in 1 week"', () => {
        const result = parseNaturalDate('in 1 week')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-21')
        }
      })

      it('should add 2 weeks for "in 2 weeks"', () => {
        const result = parseNaturalDate('in 2 weeks')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-28')
        }
      })

      it('should add 4 weeks for "in 4 weeks"', () => {
        const result = parseNaturalDate('in 4 weeks')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-11')
        }
      })
    })

    describe('"in X months"', () => {
      it('should add 1 month for "in 1 month"', () => {
        const result = parseNaturalDate('in 1 month')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-14')
        }
      })

      it('should add 3 months for "in 3 months"', () => {
        const result = parseNaturalDate('in 3 months')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-04-14')
        }
      })

      it('should add 6 months for "in 6 months"', () => {
        const result = parseNaturalDate('in 6 months')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-07-14')
        }
      })

      it('should handle year boundary for "in 12 months"', () => {
        const result = parseNaturalDate('in 12 months')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2027-01-14')
        }
      })
    })

    describe('"next week" and "weekend"', () => {
      it('should return next Monday for "next week"', () => {
        const result = parseNaturalDate('next week')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          // nextMonday from Wednesday Jan 14 = Monday Jan 19
          expect(toDateString(result.result.date)).toBe('2026-01-19')
        }
      })

      it('should return next Saturday for "this weekend"', () => {
        const result = parseNaturalDate('this weekend')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          // nextSaturday from Wednesday Jan 14 = Saturday Jan 17
          expect(toDateString(result.result.date)).toBe('2026-01-17')
        }
      })

      it('should return next Saturday for "weekend"', () => {
        const result = parseNaturalDate('weekend')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-17')
        }
      })
    })
  })

  // ==========================================================================
  // T035: MONTH + DAY
  // ==========================================================================

  describe('parseNaturalDate - Month + Day (T035)', () => {
    describe('month name + day format', () => {
      it('should parse "dec 25" as December 25', () => {
        const result = parseNaturalDate('dec 25')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should parse "december 25" as December 25', () => {
        const result = parseNaturalDate('december 25')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should parse "january 1" as January 1 next year (past this year)', () => {
        // Reference is Jan 15, so Jan 1 has passed
        const result = parseNaturalDate('january 1')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2027-01-01')
        }
      })

      it('should parse "jan 20" as January 20 this year (future)', () => {
        const result = parseNaturalDate('jan 20')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-20')
        }
      })

      it('should parse "jan 10" as January 10 next year (past this year)', () => {
        // Reference is Jan 14, so Jan 10 has passed
        const result = parseNaturalDate('jan 10')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2027-01-10')
        }
      })

      it('should parse "feb 14" as February 14', () => {
        const result = parseNaturalDate('feb 14')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-14')
        }
      })

      it('should parse all month abbreviations', () => {
        const months = [
          { abbr: 'jan', month: '01' },
          { abbr: 'feb', month: '02' },
          { abbr: 'mar', month: '03' },
          { abbr: 'apr', month: '04' },
          { abbr: 'may', month: '05' },
          { abbr: 'jun', month: '06' },
          { abbr: 'jul', month: '07' },
          { abbr: 'aug', month: '08' },
          { abbr: 'sep', month: '09' },
          { abbr: 'oct', month: '10' },
          { abbr: 'nov', month: '11' },
          { abbr: 'dec', month: '12' }
        ]

        for (const { abbr, month } of months) {
          const result = parseNaturalDate(`${abbr} 20`)
          expect(isSuccess(result)).toBe(true)
          if (isSuccess(result)) {
            expect(result.result.date.getMonth() + 1).toBe(parseInt(month))
          }
        }
      })
    })

    describe('day + month name format', () => {
      it('should parse "25 dec" as December 25', () => {
        const result = parseNaturalDate('25 dec')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should parse "25th december" as December 25', () => {
        const result = parseNaturalDate('25th december')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should parse "1st january" as January 1 next year', () => {
        const result = parseNaturalDate('1st january')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2027-01-01')
        }
      })

      it('should parse "2nd february" as February 2', () => {
        const result = parseNaturalDate('2nd february')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-02')
        }
      })

      it('should parse "3rd march" as March 3', () => {
        const result = parseNaturalDate('3rd march')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-03-03')
        }
      })
    })

    describe('ordinal suffixes', () => {
      it('should handle "1st"', () => {
        const result = parseNaturalDate('feb 1st')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.date.getDate()).toBe(1)
        }
      })

      it('should handle "2nd"', () => {
        const result = parseNaturalDate('feb 2nd')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.date.getDate()).toBe(2)
        }
      })

      it('should handle "3rd"', () => {
        const result = parseNaturalDate('feb 3rd')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.date.getDate()).toBe(3)
        }
      })

      it('should handle "4th" through "31st"', () => {
        const result = parseNaturalDate('feb 15th')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.date.getDate()).toBe(15)
        }
      })
    })
  })

  // ==========================================================================
  // T036: NUMERIC DATES
  // ==========================================================================

  describe('parseNaturalDate - Numeric Dates (T036)', () => {
    describe('MM/DD format', () => {
      it('should parse "12/25" as December 25', () => {
        const result = parseNaturalDate('12/25')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should parse "1/1" as January 1 next year (past)', () => {
        const result = parseNaturalDate('1/1')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2027-01-01')
        }
      })

      it('should parse "2/14" as February 14', () => {
        const result = parseNaturalDate('2/14')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-14')
        }
      })

      it('should parse "01/20" as January 20', () => {
        const result = parseNaturalDate('01/20')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-20')
        }
      })
    })

    describe('MM-DD format', () => {
      it('should parse "12-25" as December 25', () => {
        const result = parseNaturalDate('12-25')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should parse "02-14" as February 14', () => {
        const result = parseNaturalDate('02-14')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-14')
        }
      })
    })

    describe('MM/DD/YYYY format', () => {
      it('should parse "12/25/2026" as December 25, 2026', () => {
        const result = parseNaturalDate('12/25/2026')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should parse "01/01/2027" as January 1, 2027', () => {
        const result = parseNaturalDate('01/01/2027')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2027-01-01')
        }
      })

      it('should parse "12-25-2025" as December 25, 2025 (past year)', () => {
        const result = parseNaturalDate('12-25-2025')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2025-12-25')
        }
      })
    })

    describe('2-digit year handling', () => {
      it('should interpret "12/25/26" as 2026 (< 50 = 2000s)', () => {
        const result = parseNaturalDate('12/25/26')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-12-25')
        }
      })

      it('should interpret "12/25/30" as 2030 (< 50 = 2000s)', () => {
        const result = parseNaturalDate('12/25/30')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2030-12-25')
        }
      })

      it('should interpret "12/25/49" as 2049 (< 50 = 2000s)', () => {
        const result = parseNaturalDate('12/25/49')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2049-12-25')
        }
      })

      it('should interpret "12/25/50" as 1950 (>= 50 = 1900s)', () => {
        const result = parseNaturalDate('12/25/50')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('1950-12-25')
        }
      })

      it('should interpret "12/25/99" as 1999 (>= 50 = 1900s)', () => {
        const result = parseNaturalDate('12/25/99')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('1999-12-25')
        }
      })
    })
  })

  // ==========================================================================
  // T037: TIME PARSING
  // ==========================================================================

  describe('parseNaturalDate - Time Parsing (T037)', () => {
    describe('12-hour format', () => {
      it('should parse "today 3pm" as 15:00', () => {
        const result = parseNaturalDate('today 3pm')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('15:00')
        }
      })

      it('should parse "today 3:30pm" as 15:30', () => {
        const result = parseNaturalDate('today 3:30pm')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('15:30')
        }
      })

      it('should parse "today 12pm" as 12:00 (noon)', () => {
        const result = parseNaturalDate('today 12pm')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('12:00')
        }
      })

      it('should parse "today 12am" as 00:00 (midnight)', () => {
        const result = parseNaturalDate('today 12am')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('00:00')
        }
      })

      it('should parse "today 9am" as 09:00', () => {
        const result = parseNaturalDate('today 9am')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('09:00')
        }
      })

      it('should parse "today 11:59pm" as 23:59', () => {
        const result = parseNaturalDate('today 11:59pm')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('23:59')
        }
      })

      it('should handle space before am/pm: "today 3 pm"', () => {
        const result = parseNaturalDate('today 3 pm')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('15:00')
        }
      })

      it('should handle uppercase AM/PM', () => {
        const result = parseNaturalDate('today 3PM')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('15:00')
        }
      })
    })

    describe('24-hour format', () => {
      it('should parse "today 15:00" as 15:00', () => {
        const result = parseNaturalDate('today 15:00')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('15:00')
        }
      })

      it('should parse "today 0:00" as 00:00', () => {
        const result = parseNaturalDate('today 0:00')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('00:00')
        }
      })

      it('should parse "today 23:59" as 23:59', () => {
        const result = parseNaturalDate('today 23:59')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('23:59')
        }
      })

      it('should parse "today 9:30" as 09:30', () => {
        const result = parseNaturalDate('today 9:30')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('09:30')
        }
      })
    })

    describe('time with "at" prefix', () => {
      it('should parse "today at 3pm" as 15:00', () => {
        const result = parseNaturalDate('today at 3pm')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('15:00')
        }
      })

      it('should parse "today at 15:00" as 15:00', () => {
        const result = parseNaturalDate('today at 15:00')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.time).toBe('15:00')
        }
      })
    })
  })

  // ==========================================================================
  // T038: COMBINED DATE + TIME
  // ==========================================================================

  describe('parseNaturalDate - Combined Date + Time (T038)', () => {
    it('should parse "tomorrow at 3pm"', () => {
      const result = parseNaturalDate('tomorrow at 3pm')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(toDateString(result.result.date)).toBe('2026-01-15')
        expect(result.result.time).toBe('15:00')
      }
    })

    it('should parse "tomorrow 3pm" (without "at")', () => {
      const result = parseNaturalDate('tomorrow 3pm')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(toDateString(result.result.date)).toBe('2026-01-15')
        expect(result.result.time).toBe('15:00')
      }
    })

    it('should parse "next friday 2:30pm"', () => {
      // From Wed Jan 14, "next friday" = Fri Jan 16 (Friday is ahead, so no +7)
      const result = parseNaturalDate('next friday 2:30pm')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(toDateString(result.result.date)).toBe('2026-01-16')
        expect(result.result.time).toBe('14:30')
      }
    })

    it('should parse "dec 25 at 9am"', () => {
      const result = parseNaturalDate('dec 25 at 9am')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(toDateString(result.result.date)).toBe('2026-12-25')
        expect(result.result.time).toBe('09:00')
      }
    })

    it('should parse "monday 8:30am"', () => {
      // From Wed Jan 14, "monday" = Mon Jan 19 (next Monday)
      const result = parseNaturalDate('monday 8:30am')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(toDateString(result.result.date)).toBe('2026-01-19')
        expect(result.result.time).toBe('08:30')
      }
    })

    it('should parse "in 3 days 14:00"', () => {
      const result = parseNaturalDate('in 3 days 14:00')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(toDateString(result.result.date)).toBe('2026-01-17')
        expect(result.result.time).toBe('14:00')
      }
    })

    it('should parse "12/25 10am"', () => {
      const result = parseNaturalDate('12/25 10am')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(toDateString(result.result.date)).toBe('2026-12-25')
        expect(result.result.time).toBe('10:00')
      }
    })
  })

  // ==========================================================================
  // T039: EDGE CASES
  // ==========================================================================

  describe('parseNaturalDate - Edge Cases (T039)', () => {
    describe('ordinal day only', () => {
      it('should parse "25th" as 25th of current month (future)', () => {
        // Reference: Jan 14. The 25th is in the future this month.
        const result = parseNaturalDate('25th')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-25')
        }
      })

      it('should parse "10th" as 10th of next month (past this month)', () => {
        // Reference: Jan 14. The 10th has passed this month.
        const result = parseNaturalDate('10th')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-10')
        }
      })

      it('should parse "1st" as 1st of next month', () => {
        const result = parseNaturalDate('1st')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-02-01')
        }
      })

      it('should parse "31st" (may roll to next month with fewer days)', () => {
        const result = parseNaturalDate('31st')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.result.date.getDate()).toBe(31)
        }
      })

      it('should parse "14th" as 14th of current month (today)', () => {
        // Reference: Jan 14. The 14th is today, and the parser checks isBefore(day, today)
        // Since today == target, isBefore returns false, so it returns current month
        const result = parseNaturalDate('14th')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-14')
        }
      })
    })

    describe('displayText formatting', () => {
      it('should format displayText with full date', () => {
        const result = parseNaturalDate('tomorrow')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.displayText).toContain('Thursday')
          expect(result.displayText).toContain('January')
          expect(result.displayText).toContain('15')
          expect(result.displayText).toContain('2026')
        }
      })

      it('should format displayText with time', () => {
        const result = parseNaturalDate('tomorrow at 3pm')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.displayText).toContain('3:00 PM')
        }
      })

      it('should format morning time correctly', () => {
        const result = parseNaturalDate('tomorrow at 9am')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(result.displayText).toContain('9:00 AM')
        }
      })
    })

    describe('whitespace handling', () => {
      it('should handle multiple spaces', () => {
        const result = parseNaturalDate('in   3   days')
        expect(isSuccess(result)).toBe(true)
        if (isSuccess(result)) {
          expect(toDateString(result.result.date)).toBe('2026-01-17')
        }
      })

      it('should handle tabs and newlines', () => {
        const result = parseNaturalDate('  tomorrow  ')
        expect(isSuccess(result)).toBe(true)
      })
    })

    describe('case insensitivity', () => {
      it('should handle UPPERCASE', () => {
        const result = parseNaturalDate('TOMORROW')
        expect(isSuccess(result)).toBe(true)
      })

      it('should handle MixedCase', () => {
        const result = parseNaturalDate('ToMoRrOw')
        expect(isSuccess(result)).toBe(true)
      })

      it('should handle month names in any case', () => {
        const result1 = parseNaturalDate('DEC 25')
        const result2 = parseNaturalDate('Dec 25')
        const result3 = parseNaturalDate('dec 25')
        expect(isSuccess(result1)).toBe(true)
        expect(isSuccess(result2)).toBe(true)
        expect(isSuccess(result3)).toBe(true)
      })
    })
  })

  // ==========================================================================
  // T040: INVALID INPUTS AND ERROR HANDLING
  // ==========================================================================

  describe('parseNaturalDate - Invalid Inputs (T040)', () => {
    it('should return error for empty string', () => {
      const result = parseNaturalDate('')
      expect(isError(result)).toBe(true)
      if (isError(result)) {
        expect(result.error).toBe('Please enter a date')
      }
    })

    it('should return error for whitespace only', () => {
      const result = parseNaturalDate('   ')
      expect(isError(result)).toBe(true)
      if (isError(result)) {
        expect(result.error).toBe('Please enter a date')
      }
    })

    it('should return error for unrecognized format', () => {
      const result = parseNaturalDate('gibberish')
      expect(isError(result)).toBe(true)
      if (isError(result)) {
        expect(result.error).toBe("Couldn't understand this date")
      }
    })

    it('should return error for partial matches', () => {
      const result = parseNaturalDate('next')
      expect(isError(result)).toBe(true)
    })

    it('should return error for invalid day names', () => {
      const result = parseNaturalDate('funday')
      expect(isError(result)).toBe(true)
    })

    it('should return error for invalid month names', () => {
      const result = parseNaturalDate('smarch 15')
      expect(isError(result)).toBe(true)
    })

    it('should return error for invalid numeric date (month > 12)', () => {
      const result = parseNaturalDate('13/25')
      expect(isError(result)).toBe(true)
    })

    it('should return error for invalid numeric date (day > 31)', () => {
      const result = parseNaturalDate('12/32')
      expect(isError(result)).toBe(true)
    })

    it('should handle invalid time gracefully (null time)', () => {
      // Invalid time should be ignored, but date still parsed
      const result = parseNaturalDate('tomorrow 25:00')
      // The regex won't match "25:00" as valid time, so date parses without time
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(result.result.time).toBeNull()
      }
    })

    it('should handle invalid 12-hour time gracefully', () => {
      // "13pm" is not valid 12-hour time
      const result = parseNaturalDate('tomorrow 13pm')
      expect(isSuccess(result)).toBe(true)
      if (isSuccess(result)) {
        expect(result.result.time).toBeNull()
      }
    })
  })

  // ==========================================================================
  // T041: HELPER FUNCTIONS
  // ==========================================================================

  describe('Helper Functions (T041)', () => {
    describe('nextSaturday', () => {
      it('should return today if today is Saturday', () => {
        // Saturday, January 17, 2026
        const saturday = new Date(2026, 0, 17, 12, 0, 0)
        vi.setSystemTime(saturday)
        const result = nextSaturday()
        expect(toDateString(result)).toBe('2026-01-17')
      })

      it('should return next Saturday if today is Sunday (6 days)', () => {
        // Sunday, January 18, 2026
        const sunday = new Date(2026, 0, 18, 12, 0, 0)
        vi.setSystemTime(sunday)
        const result = nextSaturday()
        expect(toDateString(result)).toBe('2026-01-24')
      })

      it('should return days until Saturday for weekdays', () => {
        // Wednesday, January 14, 2026 (reference)
        vi.setSystemTime(REFERENCE_DATE)
        const result = nextSaturday()
        expect(toDateString(result)).toBe('2026-01-17') // 3 days
      })

      it('should accept a custom date parameter', () => {
        const sunday = new Date(2026, 0, 18, 12, 0, 0) // Sunday
        const result = nextSaturday(sunday)
        expect(result.getDay()).toBe(6) // Saturday
        expect(toDateString(result)).toBe('2026-01-24')
      })
    })

    describe('nextMonday', () => {
      it('should return next Monday if today is Monday (7 days)', () => {
        // Monday, January 19, 2026
        const monday = new Date(2026, 0, 19, 12, 0, 0)
        vi.setSystemTime(monday)
        const result = nextMonday()
        expect(toDateString(result)).toBe('2026-01-26')
      })

      it('should return tomorrow if today is Sunday', () => {
        // Sunday, January 18, 2026
        const sunday = new Date(2026, 0, 18, 12, 0, 0)
        vi.setSystemTime(sunday)
        const result = nextMonday()
        expect(toDateString(result)).toBe('2026-01-19')
      })

      it('should return days until Monday for other weekdays', () => {
        // Wednesday, January 14, 2026 (reference)
        vi.setSystemTime(REFERENCE_DATE)
        const result = nextMonday()
        expect(toDateString(result)).toBe('2026-01-19') // 5 days
      })
    })

    describe('addWeeks', () => {
      it('should add 1 week (7 days)', () => {
        const result = addWeeks(REFERENCE_DATE, 1)
        expect(toDateString(result)).toBe('2026-01-21')
      })

      it('should add 2 weeks (14 days)', () => {
        const result = addWeeks(REFERENCE_DATE, 2)
        expect(toDateString(result)).toBe('2026-01-28')
      })

      it('should add 4 weeks (28 days)', () => {
        const result = addWeeks(REFERENCE_DATE, 4)
        expect(toDateString(result)).toBe('2026-02-11')
      })

      it('should handle 0 weeks', () => {
        const result = addWeeks(REFERENCE_DATE, 0)
        expect(toDateString(result)).toBe('2026-01-14')
      })

      it('should handle negative weeks', () => {
        const result = addWeeks(REFERENCE_DATE, -1)
        expect(toDateString(result)).toBe('2026-01-07')
      })
    })

    describe('addMonths', () => {
      it('should add 1 month', () => {
        const result = addMonths(REFERENCE_DATE, 1)
        expect(toDateString(result)).toBe('2026-02-14')
      })

      it('should add 3 months', () => {
        const result = addMonths(REFERENCE_DATE, 3)
        expect(toDateString(result)).toBe('2026-04-14')
      })

      it('should add 12 months (1 year)', () => {
        const result = addMonths(REFERENCE_DATE, 12)
        expect(toDateString(result)).toBe('2027-01-14')
      })

      it('should handle 0 months', () => {
        const result = addMonths(REFERENCE_DATE, 0)
        expect(toDateString(result)).toBe('2026-01-14')
      })

      it('should handle negative months', () => {
        const result = addMonths(REFERENCE_DATE, -1)
        expect(toDateString(result)).toBe('2025-12-14')
      })

      it('should handle end-of-month rollover (Jan 31 + 1 month)', () => {
        const jan31 = new Date(2026, 0, 31, 12, 0, 0)
        const result = addMonths(jan31, 1)
        // Feb doesn't have 31 days, so it rolls to March 3 (28 days in Feb 2026)
        expect(result.getMonth()).toBe(2) // March (0-indexed)
      })
    })
  })
})
