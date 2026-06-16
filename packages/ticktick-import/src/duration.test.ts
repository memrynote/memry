import { describe, it, expect } from 'vitest'
import { parseIsoDurationMs } from './duration'

describe('parseIsoDurationMs', () => {
  it('parses zero, minutes, hours, days, and negatives', () => {
    expect(parseIsoDurationMs('PT0S')).toBe(0)
    expect(parseIsoDurationMs('-PT1440M')).toBe(-1440 * 60 * 1000)
    expect(parseIsoDurationMs('-P0DT9H0M0S')).toBe(-9 * 60 * 60 * 1000)
    expect(parseIsoDurationMs('P1D')).toBe(24 * 60 * 60 * 1000)
  })
  it('returns null for junk', () => {
    expect(parseIsoDurationMs('')).toBeNull()
    expect(parseIsoDurationMs('soon')).toBeNull()
  })
})
