import { describe, expect, it } from 'vitest'

import { seedDateOnly, seedISOAt, seedPastISOAt, toSeedDay } from './date'

describe('seed date helpers', () => {
  it('anchors relative seed dates to the command run day', () => {
    const runDay = toSeedDay(new Date(2026, 4, 17, 9, 30, 0, 0))

    expect(seedISOAt(0, 8, 17, runDay)).toBe('2026-05-17T08:17:00.000Z')
    expect(seedISOAt(-1, 22, 17, runDay)).toBe('2026-05-16T22:17:00.000Z')
    expect(seedDateOnly(7, runDay)).toBe('2026-05-24')
  })

  it('keeps current-day capture timestamps from landing in the future', () => {
    const now = new Date(2026, 4, 17, 2, 38, 0, 0)
    const runDay = toSeedDay(now)
    const capturedAt = new Date(seedPastISOAt(0, 12, 17, runDay, now))

    expect(capturedAt.getTime()).toBeLessThanOrEqual(now.getTime())
    expect(capturedAt.getFullYear()).toBe(2026)
    expect(capturedAt.getMonth()).toBe(4)
    expect(capturedAt.getDate()).toBe(17)
  })
})
