import { describe, expect, it } from 'vitest'
import { POPOVER_WIDTH, computePopoverPosition } from './popover-position'

const VIEWPORT = { width: 1550, height: 900 }

function withViewport<T>(run: () => T): T {
  const originalWidth = window.innerWidth
  const originalHeight = window.innerHeight
  Object.defineProperty(window, 'innerWidth', { value: VIEWPORT.width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: VIEWPORT.height, configurable: true })
  try {
    return run()
  } finally {
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
  }
}

describe('computePopoverPosition', () => {
  it('places the popover to the right of the anchor when it fits', () => {
    const { top, left } = withViewport(() =>
      computePopoverPosition({ x: 430, y: 132, width: 125, height: 48 })
    )
    expect(left).toBe(430 + 125 + 8)
    expect(top).toBe(132)
  })

  it('flips to the left of the anchor when the right side would overflow', () => {
    const { left } = withViewport(() =>
      computePopoverPosition({ x: 1300, y: 200, width: 125, height: 48 })
    )
    expect(left).toBe(1300 - POPOVER_WIDTH - 8)
  })

  it('keeps the popover inside the window when the anchor is far off-screen left', () => {
    // Regression: the week grid is an infinitely virtualized strip, so its own
    // rect sits millions of pixels to the left once scrolled to today. Anchoring
    // on it parked the popover off-window, where its Save button could never be
    // clicked — Playwright reported "element is outside of the viewport" forever.
    const { top, left } = withViewport(() =>
      computePopoverPosition({ x: -2_591_714, y: 132, width: 125, height: 48 })
    )
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + POPOVER_WIDTH).toBeLessThanOrEqual(VIEWPORT.width)
    expect(top).toBe(132)
  })

  it('keeps the popover inside the window when the anchor is far off-screen right', () => {
    const { left } = withViewport(() =>
      computePopoverPosition({ x: 2_591_714, y: 132, width: 125, height: 48 })
    )
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + POPOVER_WIDTH).toBeLessThanOrEqual(VIEWPORT.width)
  })

  it('keeps the popover inside the window when the anchor is below the fold', () => {
    const { top } = withViewport(() =>
      computePopoverPosition({ x: 430, y: 5000, width: 125, height: 48 })
    )
    expect(top).toBeGreaterThanOrEqual(8)
    expect(top).toBeLessThanOrEqual(VIEWPORT.height - 240)
  })
})
