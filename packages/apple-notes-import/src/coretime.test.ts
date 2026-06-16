import { describe, it, expect } from 'vitest'
import { coreTimeToIso, CORETIME_OFFSET } from './coretime.ts'

describe('coreTimeToIso', () => {
  it('maps 0 seconds to the Apple reference date 2001-01-01', () => {
    expect(coreTimeToIso(0)).toBe(new Date(0).toISOString())
  })

  it('uses the 978307200 offset (2001-01-01 UTC)', () => {
    expect(CORETIME_OFFSET).toBe(978307200)
    expect(new Date(CORETIME_OFFSET * 1000).toISOString()).toBe('2001-01-01T00:00:00.000Z')
  })

  it('converts a positive CoreTime value to the correct Unix instant', () => {
    // (700000000 + 978307200) seconds since the Unix epoch.
    const expected = new Date((700000000 + CORETIME_OFFSET) * 1000).toISOString()
    expect(coreTimeToIso(700000000)).toBe(expected)
    expect(expected).toBe('2023-03-08T20:26:40.000Z')
  })

  it('falls back to epoch for missing/negative values', () => {
    expect(coreTimeToIso(-5)).toBe(new Date(0).toISOString())
    expect(coreTimeToIso(Number.NaN)).toBe(new Date(0).toISOString())
  })
})
