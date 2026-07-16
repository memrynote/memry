import { describe, expect, it } from 'vitest'
import { timeFromOffset } from './drop-time'

describe('timeFromOffset', () => {
  const HOUR_HEIGHT = 48

  it('returns midnight at the top of the grid', () => {
    expect(timeFromOffset(0, HOUR_HEIGHT)).toBe('00:00')
  })

  it('converts a whole-hour offset', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 9, HOUR_HEIGHT)).toBe('09:00')
  })

  it('snaps to the nearest 15 minutes', () => {
    // 9h + 20min -> 09:15 (20 rounds down to 15)
    expect(timeFromOffset(HOUR_HEIGHT * 9 + HOUR_HEIGHT / 3, HOUR_HEIGHT)).toBe('09:15')
    // 9h + 24min -> 09:30 (24 rounds up to 30)
    expect(timeFromOffset(HOUR_HEIGHT * 9 + HOUR_HEIGHT * 0.4, HOUR_HEIGHT)).toBe('09:30')
  })

  it('pads single-digit hours and minutes', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 5 + HOUR_HEIGHT / 4, HOUR_HEIGHT)).toBe('05:15')
  })

  it('clamps a negative offset to midnight', () => {
    expect(timeFromOffset(-500, HOUR_HEIGHT)).toBe('00:00')
  })

  it('clamps past the end of the day to 23:45', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 30, HOUR_HEIGHT)).toBe('23:45')
  })
})
