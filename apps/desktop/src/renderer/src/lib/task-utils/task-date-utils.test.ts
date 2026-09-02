import { describe, expect, it } from 'vitest'
import { formatDateKey, parseDateKey, parseDueDate } from './task-date-utils'

// The write path refuses a date the calendar does not have, but a row stored
// before it did is still in a beta user's database and still has to render.
// These cases pin what the renderer does with one: it rolls the value onto a
// real day and hands back a usable Date, never `Invalid Date` and never a throw.
describe('parseDueDate over a stored date the calendar does not have', () => {
  it.each([
    ['2026-02-30', '2026-03-02'],
    ['2025-02-29', '2025-03-01'],
    ['2026-13-01', '2027-01-01'],
    ['2026-00-10', '2025-12-10']
  ])('rolls %s onto %s instead of throwing', (stored, rolled) => {
    const parsed = parseDueDate(stored)
    expect(Number.isNaN(parsed.getTime())).toBe(false)
    expect(formatDateKey(parsed)).toBe(rolled)
  })

  it('leaves a date the calendar does have alone', () => {
    expect(formatDateKey(parseDueDate('2024-02-29'))).toBe('2024-02-29')
    expect(formatDateKey(parseDateKey('2026-01-15'))).toBe('2026-01-15')
  })
})
