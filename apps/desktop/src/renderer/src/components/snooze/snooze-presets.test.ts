import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  formatSnoozeDuration,
  formatSnoozeReturn,
  formatSnoozeTime,
  inOneHour,
  inTwoHours,
  laterToday,
  nextWeek,
  quickSnoozePresets,
  snoozePresets,
  thisWeekend,
  tomorrow
} from './snooze-presets'

describe('snooze-presets', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 6, 10, 30, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('computes standard and quick snooze dates from the local clock', () => {
    expect(laterToday()).toEqual(new Date(2026, 4, 6, 18, 0, 0, 0))
    expect(tomorrow()).toEqual(new Date(2026, 4, 7, 9, 0, 0, 0))
    expect(thisWeekend()).toEqual(new Date(2026, 4, 9, 9, 0, 0, 0))
    expect(nextWeek()).toEqual(new Date(2026, 4, 11, 9, 0, 0, 0))
    expect(inOneHour()).toEqual(new Date(2026, 4, 6, 11, 30, 0, 0))
    expect(inTwoHours()).toEqual(new Date(2026, 4, 6, 12, 30, 0, 0))

    expect(snoozePresets.map((preset) => preset.id)).toEqual([
      'later-today',
      'tomorrow',
      'this-weekend',
      'next-week'
    ])
    expect(quickSnoozePresets.map((preset) => preset.getTime().getHours())).toEqual([11, 12])
  })

  it('handles passed-day and same-day weekend and next-week branches', () => {
    vi.setSystemTime(new Date(2026, 4, 6, 19, 5, 0, 0))
    expect(laterToday()).toEqual(new Date(2026, 4, 7, 9, 0, 0, 0))

    vi.setSystemTime(new Date(2026, 4, 9, 8, 0, 0, 0))
    expect(thisWeekend()).toEqual(new Date(2026, 4, 9, 9, 0, 0, 0))

    vi.setSystemTime(new Date(2026, 4, 9, 10, 0, 0, 0))
    expect(thisWeekend()).toEqual(new Date(2026, 4, 16, 9, 0, 0, 0))

    vi.setSystemTime(new Date(2026, 4, 10, 10, 0, 0, 0))
    expect(thisWeekend()).toEqual(new Date(2026, 4, 16, 9, 0, 0, 0))
    expect(nextWeek()).toEqual(new Date(2026, 4, 11, 9, 0, 0, 0))

    vi.setSystemTime(new Date(2026, 4, 11, 8, 0, 0, 0))
    expect(nextWeek()).toEqual(new Date(2026, 4, 11, 9, 0, 0, 0))

    vi.setSystemTime(new Date(2026, 4, 11, 10, 0, 0, 0))
    expect(nextWeek()).toEqual(new Date(2026, 4, 18, 9, 0, 0, 0))
  })

  it('formats snooze labels, durations, and return badges', () => {
    expect(formatSnoozeTime(new Date(2026, 4, 6, 14, 0))).toBe('Today at 2:00 PM')
    expect(formatSnoozeTime(new Date(2026, 4, 7, 9, 30), '24h')).toBe('Tomorrow at 09:30')
    expect(formatSnoozeTime(new Date(2026, 4, 9, 8, 0))).toBe('Saturday at 8:00 AM')
    expect(formatSnoozeTime(new Date(2026, 5, 20, 8, 0))).toBe('Jun 20, 8:00 AM')

    expect(formatSnoozeDuration(new Date(2026, 4, 6, 10, 31))).toBe('in 1 minute')
    expect(formatSnoozeDuration(new Date(2026, 4, 6, 10, 45))).toBe('in 15 minutes')
    expect(formatSnoozeDuration(new Date(2026, 4, 6, 11, 30))).toBe('in 1 hour')
    expect(formatSnoozeDuration(new Date(2026, 4, 6, 12, 30))).toBe('in 2 hours')
    expect(formatSnoozeDuration(new Date(2026, 4, 7, 10, 30))).toBe('in 1 day')
    expect(formatSnoozeDuration(new Date(2026, 4, 8, 10, 30))).toBe('in 2 days')
    expect(formatSnoozeDuration(new Date(2026, 4, 13, 10, 30))).toBe('in 1 week')
    expect(formatSnoozeDuration(new Date(2026, 4, 20, 10, 30))).toBe('in 2 weeks')

    expect(formatSnoozeReturn(new Date(2026, 4, 6, 10, 29))).toBe('Due now')
    expect(formatSnoozeReturn(new Date(2026, 4, 6, 10, 45))).toBe('15m left')
    expect(formatSnoozeReturn(new Date(2026, 4, 6, 12, 30))).toBe('2h left')
    expect(formatSnoozeReturn(new Date(2026, 4, 8, 10, 30))).toBe('2d left')
    expect(formatSnoozeReturn(new Date(2026, 4, 20, 10, 30))).toBe('2w left')
  })
})
