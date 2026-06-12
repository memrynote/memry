import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  formatRelativeTime,
  formatReminderDate,
  getInDays,
  getInMonths,
  getInWeeks,
  getLaterToday,
  getNextMonday,
  getNextOccurrenceOfHour,
  getNextWeekend,
  getReminderTimeLabel,
  getTomorrow,
  isOverdue,
  journalPresets,
  snoozePresets,
  standardPresets
} from './reminder-presets'

describe('reminder-presets', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 6, 10, 30, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes next preset dates from the current local day', () => {
    expect(getNextOccurrenceOfHour(16, new Date(2026, 4, 6, 10, 45))).toMatchObject({
      getHours: expect.any(Function)
    })
    expect(getNextOccurrenceOfHour(16, new Date(2026, 4, 6, 10, 45)).getDate()).toBe(6)
    expect(getNextOccurrenceOfHour(16, new Date(2026, 4, 6, 16, 5)).getDate()).toBe(7)
    expect(getTomorrow().getDate()).toBe(7)
    expect(getTomorrow(14).getHours()).toBe(14)
    expect(getNextMonday().getDay()).toBe(1)
    expect(getNextWeekend().getDay()).toBe(6)
    expect(getInDays(3, 11).getDate()).toBe(9)
    expect(getInWeeks(2, 12).getDate()).toBe(20)
    expect(getInMonths(1, 13).getMonth()).toBe(5)
  })

  it('handles later-today branches and exposes preset collections', () => {
    expect(getLaterToday().getHours()).toBe(14)

    vi.setSystemTime(new Date(2026, 4, 6, 18, 5, 0, 0))
    expect(getLaterToday().getHours()).toBe(20)
    expect(getLaterToday().getDate()).toBe(6)

    vi.setSystemTime(new Date(2026, 4, 6, 21, 5, 0, 0))
    expect(getLaterToday().getHours()).toBe(9)
    expect(getLaterToday().getDate()).toBe(7)

    expect(standardPresets.map((preset) => preset.id)).toEqual([
      'later-today',
      'tomorrow',
      'next-week',
      'in-one-month'
    ])
    expect(journalPresets.at(-1)?.getDate().getFullYear()).toBe(2027)
    expect(snoozePresets[0].getDate().getMinutes()).toBe(20)
  })

  it('formats absolute and relative reminder labels', () => {
    expect(formatReminderDate(new Date(2026, 4, 6, 14, 0))).toBe('Today at 2:00 PM')
    expect(formatReminderDate(new Date(2026, 4, 7, 9, 30), '24h')).toBe('Tomorrow at 09:30')
    expect(formatReminderDate(new Date(2026, 4, 9, 8, 0))).toBe('Saturday at 8:00 AM')
    expect(formatReminderDate(new Date(2026, 5, 20, 8, 0))).toBe('Jun 20 at 8:00 AM')
    expect(formatReminderDate(new Date(2027, 0, 2, 8, 0))).toBe('Jan 2, 2027 at 8:00 AM')

    expect(formatRelativeTime(new Date(2026, 4, 6, 10, 29))).toBe('overdue')
    expect(formatRelativeTime(new Date(2026, 4, 6, 10, 31))).toBe('in 1 minute')
    expect(formatRelativeTime(new Date(2026, 4, 6, 12, 30))).toBe('in 2 hours')
    expect(formatRelativeTime(new Date(2026, 4, 8, 10, 30))).toBe('in 2 days')
    expect(formatRelativeTime(new Date(2026, 4, 20, 10, 30))).toBe('in 2 weeks')
    expect(formatRelativeTime(new Date(2026, 7, 6, 10, 30))).toBe('in 3 months')
    expect(formatRelativeTime(new Date(2027, 5, 6, 10, 30))).toBe('in 1 year')
    expect(isOverdue(new Date(2026, 4, 6, 10, 29))).toBe(true)
    expect(isOverdue(new Date(2026, 4, 6, 10, 31).toISOString())).toBe(false)
    expect(getReminderTimeLabel(new Date(2026, 4, 6, 10, 29))).toBe('Overdue')
    expect(getReminderTimeLabel(new Date(2026, 4, 6, 10, 31))).toBe('in 1 minute')
  })

  it('formats compact reminder labels for tight surfaces', () => {
    expect(formatReminderDate(new Date(2026, 4, 6, 14, 0), '12h', true)).toBe('Today, 2:00 PM')
    expect(formatReminderDate(new Date(2026, 4, 7, 9, 30), '24h', true)).toBe('Tomorrow, 09:30')
    expect(formatReminderDate(new Date(2026, 4, 9, 8, 0), '12h', true)).toBe('Sat, 8:00 AM')
    expect(formatReminderDate(new Date(2026, 5, 20, 8, 0), '12h', true)).toBe('Jun 20, 8:00 AM')
    expect(formatReminderDate(new Date(2027, 0, 2, 8, 0), '12h', true)).toBe('Jan 2, 2027, 8:00 AM')
  })
})
