import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useScrollToCurrentTime } from './use-scroll-to-current-time'

describe('useScrollToCurrentTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 21, 10, 30))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scrolls a 48px-per-hour grid to the current time', () => {
    const grid = document.createElement('div')

    renderHook(() => useScrollToCurrentTime({ current: grid }, true, 'calendar-day'))

    expect(grid.scrollTop).toBe(504)
  })

  it('opens a grid that does not contain today at 07:00', () => {
    const grid = document.createElement('div')

    renderHook(() => useScrollToCurrentTime({ current: grid }, false, 'calendar-day'))

    expect(grid.scrollTop).toBe(336)
  })
})
