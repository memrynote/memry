import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  POPOVER_WIDTH,
  computePopoverPosition,
  useAnchoredPopoverPosition
} from './popover-position'

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

  it('slides up so the bottom edge stays on screen for a chip near the window bottom', () => {
    const { top } = withViewport(() =>
      computePopoverPosition({ x: 430, y: 700, width: 125, height: 48 }, { estimatedHeight: 560 })
    )
    expect(top + 560).toBeLessThanOrEqual(VIEWPORT.height - 8)
  })

  it('pins to the top margin and caps maxHeight when taller than the window', () => {
    const { top, maxHeight } = computePopoverPosition(
      { x: 430, y: 300, width: 125, height: 48 },
      { estimatedHeight: 800, viewport: { width: 1200, height: 500 } }
    )
    expect(top).toBe(8)
    expect(maxHeight).toBe(500 - 16)
  })
})

describe('useAnchoredPopoverPosition', () => {
  const originalHeight = window.innerHeight

  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: originalHeight, configurable: true })
  })

  function setViewportHeight(height: number): void {
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  }

  function fakePopover(contentHeight: number): HTMLDivElement {
    const node = document.createElement('div')
    Object.defineProperty(node, 'scrollHeight', { value: contentHeight })
    Object.defineProperty(node, 'offsetHeight', { value: contentHeight })
    Object.defineProperty(node, 'clientHeight', { value: contentHeight })
    return node
  }

  const anchor = { x: 430, y: 300, width: 125, height: 48 }

  it('uses the measured height, not the estimate, to keep the popover on screen', () => {
    setViewportHeight(700)
    const { result } = renderHook(() =>
      useAnchoredPopoverPosition(anchor, { estimatedHeight: 200 })
    )
    expect(result.current.style.top).toBe(300)

    act(() => result.current.ref(fakePopover(600)))

    expect(result.current.style.top).toBe(700 - 8 - 600)
    expect(result.current.style.overflowY).toBeUndefined()
  })

  it('scrolls when the window is too short, then expands again after the window grows', () => {
    setViewportHeight(400)
    const { result } = renderHook(() =>
      useAnchoredPopoverPosition(anchor, { estimatedHeight: 200 })
    )
    act(() => result.current.ref(fakePopover(600)))

    expect(result.current.style.top).toBe(8)
    expect(result.current.style.maxHeight).toBe(400 - 16)
    expect(result.current.style.overflowY).toBe('auto')

    act(() => {
      setViewportHeight(1000)
      window.dispatchEvent(new Event('resize'))
    })

    expect(result.current.style.top).toBe(300)
    expect(result.current.style.maxHeight).toBe(1000 - 16)
    expect(result.current.style.overflowY).toBeUndefined()
  })
})
