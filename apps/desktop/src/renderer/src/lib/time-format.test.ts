import { describe, expect, it } from 'vitest'
import { formatHour, formatTimeOfDay, formatTimeRange, formatTimeString } from './time-format'

describe('formatHour', () => {
  describe('12h mode', () => {
    it('midnight (0) → 12 AM', () => {
      expect(formatHour(0, '12h')).toBe('12 AM')
    })

    it('9 AM', () => {
      expect(formatHour(9, '12h')).toBe('9 AM')
    })

    it('noon (12) → 12 PM', () => {
      expect(formatHour(12, '12h')).toBe('12 PM')
    })

    it('15 → 3 PM', () => {
      expect(formatHour(15, '12h')).toBe('3 PM')
    })
  })

  describe('24h mode', () => {
    it('midnight (0) → 00:00', () => {
      expect(formatHour(0, '24h')).toBe('00:00')
    })

    it('9 → 09:00', () => {
      expect(formatHour(9, '24h')).toBe('09:00')
    })

    it('noon (12) → 12:00', () => {
      expect(formatHour(12, '24h')).toBe('12:00')
    })

    it('15 → 15:00', () => {
      expect(formatHour(15, '24h')).toBe('15:00')
    })
  })
})

describe('formatTimeOfDay', () => {
  it('12h: 2:30 PM', () => {
    const date = new Date(2024, 0, 1, 14, 30)
    const result = formatTimeOfDay(date, '12h')
    expect(result).toMatch(/2:30\s*(PM|pm)/)
  })

  it('24h: 14:30', () => {
    const date = new Date(2024, 0, 1, 14, 30)
    const result = formatTimeOfDay(date, '24h')
    expect(result).toBe('14:30')
  })

  it('24h: midnight 00:00', () => {
    const date = new Date(2024, 0, 1, 0, 0)
    const result = formatTimeOfDay(date, '24h')
    expect(result).toBe('00:00')
  })
})

describe('formatTimeString', () => {
  it('12h: 14:30 → 2:30 PM', () => {
    expect(formatTimeString('14:30', '12h')).toBe('2:30 PM')
  })

  it('24h: 14:30 → 14:30', () => {
    expect(formatTimeString('14:30', '24h')).toBe('14:30')
  })

  it('12h: midnight 00:00 → 12:00 AM', () => {
    expect(formatTimeString('00:00', '12h')).toBe('12:00 AM')
  })

  it('12h: noon 12:00 → 12:00 PM', () => {
    expect(formatTimeString('12:00', '12h')).toBe('12:00 PM')
  })

  it('24h: midnight 00:00 → 00:00', () => {
    expect(formatTimeString('00:00', '24h')).toBe('00:00')
  })

  it('24h: noon 12:00 → 12:00', () => {
    expect(formatTimeString('12:00', '24h')).toBe('12:00')
  })
})

describe('formatTimeRange', () => {
  const at = (day: number, hours: number, minutes = 0) => new Date(2026, 8, day, hours, minutes)
  // ICU spaces a range with thin and narrow no-break spaces; the words are what matter here.
  const range = (...args: Parameters<typeof formatTimeRange>) =>
    formatTimeRange(...args).replace(/[\u2009\u202f]/g, ' ')

  it('writes the shared day period once in 12h mode', () => {
    expect(range(at(23, 19), at(23, 20), '12h')).toBe('7:00 – 8:00 PM')
  })

  it('keeps both day periods when the range crosses noon', () => {
    expect(range(at(23, 11), at(23, 13, 30), '12h')).toBe('11:00 AM – 1:30 PM')
  })

  it('writes two 24h times', () => {
    expect(range(at(23, 9), at(23, 10, 30), '24h')).toBe('09:00 – 10:30')
  })

  it('falls back to two plain times across midnight instead of printing dates', () => {
    expect(range(at(23, 23), at(24, 1), '12h')).toBe('11:00 PM – 1:00 AM')
  })

  it('shows only the start for an empty or inverted range', () => {
    expect(range(at(23, 9), at(23, 9), '12h')).toBe('9:00 AM')
    expect(range(at(23, 9), at(23, 8), '12h')).toBe('9:00 AM')
  })
})
