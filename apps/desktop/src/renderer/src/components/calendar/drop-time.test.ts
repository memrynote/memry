import { describe, expect, it } from 'vitest'
import { resolveDropOptions, timeFromOffset } from './drop-time'

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

describe('timeFromOffset with a 30 minute step', () => {
  const HOUR_HEIGHT = 44

  it('snaps to the nearest half hour', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 9 + HOUR_HEIGHT * 0.2, HOUR_HEIGHT, 30)).toBe('09:00')
    expect(timeFromOffset(HOUR_HEIGHT * 9 + HOUR_HEIGHT * 0.3, HOUR_HEIGHT, 30)).toBe('09:30')
  })

  it('clamps past the end of the day to 23:30', () => {
    expect(timeFromOffset(HOUR_HEIGHT * 30, HOUR_HEIGHT, 30)).toBe('23:30')
  })
})

describe('resolveDropOptions', () => {
  const event = (translatedTop: number, overTop: number) =>
    ({
      active: { rect: { current: { translated: { top: translatedTop } } } },
      over: { rect: { top: overTop } }
    }) as unknown as Parameters<typeof resolveDropOptions>[1]

  it('derives a 15 minute slot from the chip position by default', () => {
    expect(
      resolveDropOptions({ timeBehavior: 'slot', hourHeight: 48 }, event(148 + 48 * 9, 148))
    ).toEqual({
      dueTime: '09:00'
    })
  })

  it('reads a live offset, a step and a default duration from the slot data', () => {
    const data = {
      timeBehavior: 'slot',
      hourHeight: 44,
      snapMinutes: 30,
      durationIfUntimed: 30,
      getSlotOffsetY: () => 44 * 14 + 30
    }
    expect(resolveDropOptions(data, event(0, 0))).toEqual({
      dueTime: '14:30',
      durationIfUntimed: 30
    })
  })

  it('clears the time on an all-day cell and keeps it on a month cell', () => {
    expect(resolveDropOptions({ type: 'date', dueTime: null }, event(0, 0))).toEqual({
      dueTime: null
    })
    expect(resolveDropOptions({ type: 'date' }, event(0, 0))).toBeUndefined()
  })
})
