import { describe, expect, it } from 'vitest'

import { wheelScrollDelta } from './canvas-card-scroll'

const overflowing = { scrollTop: 100, scrollHeight: 600, clientHeight: 200 }

describe('wheelScrollDelta', () => {
  it('scrolls a card whose content overflows', () => {
    expect(wheelScrollDelta(overflowing, 50, 1)).toBe(50)
    expect(wheelScrollDelta(overflowing, -50, 1)).toBe(-50)
  })

  it('divides the screen-space delta by the canvas zoom', () => {
    expect(wheelScrollDelta(overflowing, 50, 2)).toBe(25)
    expect(wheelScrollDelta({ ...overflowing, scrollTop: 0 }, 50, 0.5)).toBe(100)
  })

  it('does not consume the wheel when the content fits', () => {
    expect(wheelScrollDelta({ scrollTop: 0, scrollHeight: 200, clientHeight: 200 }, 50, 1)).toBe(0)
  })

  it('hands the gesture back at the top and bottom edges', () => {
    expect(wheelScrollDelta({ ...overflowing, scrollTop: 0 }, -50, 1)).toBe(0)
    expect(wheelScrollDelta({ ...overflowing, scrollTop: 400 }, 50, 1)).toBe(0)
  })

  it('clamps the last partial scroll to the remaining distance', () => {
    expect(wheelScrollDelta({ ...overflowing, scrollTop: 380 }, 50, 1)).toBe(20)
  })

  it('ignores a zero delta and an invalid zoom', () => {
    expect(wheelScrollDelta(overflowing, 0, 1)).toBe(0)
    expect(wheelScrollDelta(overflowing, 50, 0)).toBe(50)
  })
})
