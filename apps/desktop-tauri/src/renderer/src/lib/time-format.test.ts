import { describe, expect, it } from 'vitest'
import { formatHour, formatTimeOfDay, formatTimeString } from './time-format'

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
