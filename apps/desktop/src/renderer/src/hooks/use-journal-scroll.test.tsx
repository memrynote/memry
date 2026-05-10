import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useJournalScroll } from './use-journal-scroll'

vi.mock('@/lib/journal-utils', () => ({
  generateDateRange: vi.fn(() => [
    { date: '2026-05-09', isToday: false, isFuture: false },
    { date: '2026-05-10', isToday: true, isFuture: false },
    { date: '2026-05-11', isToday: false, isFuture: true }
  ]),
  generateMorePastDays: vi.fn(() => [
    { date: '2026-04-25', isToday: false, isFuture: false },
    { date: '2026-04-26', isToday: false, isFuture: false }
  ]),
  generateMoreFutureDays: vi.fn(() => [
    { date: '2026-05-12', isToday: false, isFuture: true },
    { date: '2026-05-13', isToday: false, isFuture: true }
  ]),
  getDateDistance: vi.fn((date: string, activeDate: string) => (date === activeDate ? 0 : 2)),
  getOpacityForDistance: vi.fn((distance: number) => (distance === 0 ? 1 : 0.4)),
  getTodayString: vi.fn(() => '2026-05-10')
}))

function makeContainer() {
  const listeners = new Map<string, EventListener>()
  const container = {
    scrollTop: 1000,
    scrollHeight: 3000,
    clientHeight: 700,
    scrollBy: vi.fn(),
    addEventListener: vi.fn((event: string, listener: EventListener) => {
      listeners.set(event, listener)
    }),
    removeEventListener: vi.fn((event: string) => {
      listeners.delete(event)
    }),
    getBoundingClientRect: vi.fn(() => ({ top: 100, height: 400 }))
  } as unknown as HTMLDivElement & { scrollBy: ReturnType<typeof vi.fn> }

  return { container, listeners }
}

function makeCard(top: number, height = 100) {
  return {
    getBoundingClientRect: vi.fn(() => ({ top, height }))
  } as unknown as HTMLDivElement
}

describe('useJournalScroll', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(0), 0)
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('tracks registered cards, opacity, and direct scrolling', () => {
    const { result } = renderHook(() => useJournalScroll())
    const { container } = makeContainer()
    const todayCard = makeCard(250, 120)

    act(() => {
      result.current.scrollContainerRef.current = container
      result.current.registerDayCardRef('2026-05-10', todayCard)
      result.current.scrollToToday(false)
      vi.runOnlyPendingTimers()
    })

    expect(container.scrollBy).toHaveBeenCalledWith({ top: 10, behavior: 'instant' })
    expect(result.current.state.activeDate).toBe('2026-05-10')
    expect(result.current.getOpacity('2026-05-10')).toBe(1)
    expect(result.current.getOpacity('2026-05-09')).toBe(0.4)

    act(() => {
      result.current.registerDayCardRef('2026-05-10', null)
      const callCount = container.scrollBy.mock.calls.length
      result.current.scrollToDate('2026-05-10', false)
      expect(container.scrollBy).toHaveBeenCalledTimes(callCount)
    })
  })

  it('loads older and newer days while preserving scroll position', () => {
    const { result } = renderHook(() => useJournalScroll())
    const { container } = makeContainer()
    result.current.scrollContainerRef.current = container

    act(() => {
      result.current.loadMorePast()
    })
    expect(result.current.state.isLoadingPast).toBe(true)

    act(() => {
      vi.advanceTimersByTime(100)
    })
    container.scrollHeight = 3400
    act(() => {
      vi.runOnlyPendingTimers()
    })

    expect(result.current.state.days.map((day) => day.date).slice(0, 2)).toEqual([
      '2026-04-25',
      '2026-04-26'
    ])
    expect(container.scrollTop).toBe(1400)
    expect(result.current.state.isLoadingPast).toBe(false)

    act(() => {
      result.current.loadMoreFuture()
      vi.advanceTimersByTime(100)
    })

    expect(result.current.state.days.map((day) => day.date).slice(-2)).toEqual([
      '2026-05-12',
      '2026-05-13'
    ])
    expect(result.current.state.isLoadingFuture).toBe(false)
  })

  it('updates active day and edge-loads from scroll events', () => {
    const { result, rerender, unmount } = renderHook(() => useJournalScroll())
    const { container, listeners } = makeContainer()
    const pastCard = makeCard(260, 80)
    const todayCard = makeCard(600, 80)

    act(() => {
      result.current.scrollContainerRef.current = container
      result.current.registerDayCardRef('2026-05-09', pastCard)
      result.current.registerDayCardRef('2026-05-10', todayCard)
      result.current.loadMoreFuture()
      vi.advanceTimersByTime(100)
      rerender()
    })

    expect(container.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), {
      passive: true
    })

    container.scrollTop = 10
    act(() => {
      listeners.get('scroll')?.(new Event('scroll'))
      vi.runOnlyPendingTimers()
    })

    expect(result.current.state.activeDate).toBe('2026-05-09')
    expect(result.current.state.isLoadingPast).toBe(true)

    container.scrollTop = 2600
    act(() => {
      listeners.get('scroll')?.(new Event('scroll'))
      vi.runOnlyPendingTimers()
    })

    expect(result.current.state.days.some((day) => day.date === '2026-05-12')).toBe(true)
    unmount()
    expect(container.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function))
  })
})
