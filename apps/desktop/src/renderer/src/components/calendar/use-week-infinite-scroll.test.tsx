import React from 'react'
import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWeekInfiniteScroll, type UseWeekInfiniteScrollResult } from './use-week-infinite-scroll'

const virtualizerMocks = vi.hoisted(() => ({
  measure: vi.fn(),
  options: [] as Array<{
    horizontal: boolean
    count: number
    getScrollElement: () => HTMLDivElement | null
    estimateSize: () => number
    overscan: number
  }>
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: (typeof virtualizerMocks.options)[number]) => {
    virtualizerMocks.options.push(options)
    return {
      measure: virtualizerMocks.measure,
      getVirtualItems: vi.fn(() => []),
      getTotalSize: vi.fn(() => 0)
    }
  }
}))

class ResizeObserverMock {
  static instances: ResizeObserverMock[] = []

  observe = vi.fn()
  disconnect = vi.fn()

  constructor(private readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this)
  }

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function defineReadonlyNumber(target: HTMLElement, key: 'clientWidth', value: number): void {
  Object.defineProperty(target, key, { configurable: true, value })
}

describe('useWeekInfiniteScroll', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    virtualizerMocks.options = []
    ResizeObserverMock.instances = []
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  it('measures columns, tracks visible days, translates shift-wheel, and scrolls programmatically', () => {
    let current: UseWeekInfiniteScrollResult | null = null
    const onVisibleDayStartChange = vi.fn()

    function Harness(): React.JSX.Element {
      current = useWeekInfiniteScroll({
        initialDate: '2026-05-14',
        totalDays: 90,
        onVisibleDayStartChange
      })
      return <div data-testid="week-scroller" ref={current.scrollContainerRef} />
    }

    const { getByTestId } = render(<Harness />)
    const scroller = getByTestId('week-scroller') as HTMLDivElement
    defineReadonlyNumber(scroller, 'clientWidth', 700)
    scroller.scrollTo = vi.fn(({ left }) => {
      scroller.scrollLeft = Number(left)
    })

    expect(current?.columnWidth).toBe(48)
    expect(virtualizerMocks.options.at(-1)).toMatchObject({
      horizontal: true,
      count: 90,
      overscan: 3
    })
    expect(virtualizerMocks.options.at(-1)?.getScrollElement()).toBe(scroller)

    act(() => {
      ResizeObserverMock.instances[0].trigger()
    })

    expect(current?.columnWidth).toBe(100)
    expect(virtualizerMocks.options.at(-1)?.estimateSize()).toBe(100)
    expect(scroller.scrollLeft).toBeGreaterThan(0)
    expect(virtualizerMocks.measure).toHaveBeenCalled()

    act(() => {
      scroller.scrollLeft = 250
      scroller.dispatchEvent(new Event('scroll'))
    })

    expect(current?.visibleDayStart).toBe(2)
    expect(onVisibleDayStartChange).toHaveBeenCalledWith(2)

    const wheel = new WheelEvent('wheel', {
      shiftKey: true,
      deltaY: 40,
      deltaX: 0,
      cancelable: true
    })
    act(() => {
      scroller.dispatchEvent(wheel)
    })

    expect(wheel.defaultPrevented).toBe(true)
    expect(scroller.scrollLeft).toBe(290)

    const beforeDominantX = scroller.scrollLeft
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { shiftKey: true, deltaY: 10, deltaX: 20 }))
      scroller.dispatchEvent(new WheelEvent('wheel', { shiftKey: false, deltaY: 50, deltaX: 0 }))
    })
    expect(scroller.scrollLeft).toBe(beforeDominantX)

    act(() => {
      current?.scrollToDay(4, { smooth: true })
    })
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 400, behavior: 'smooth' })

    act(() => {
      current?.scrollToDay(40, { smooth: true })
    })
    expect(scroller.scrollTo).toHaveBeenLastCalledWith({ left: 4000, behavior: 'auto' })
    expect(current?.visibleDayStart).toBe(40)

    act(() => {
      current?.scrollToDate('2026-05-20', { smooth: false })
    })
    expect(scroller.scrollTo).toHaveBeenLastCalledWith(
      expect.objectContaining({ behavior: 'auto' })
    )
    expect(current?.dateForDayIndex(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('keeps the same day pinned when the container is resized', () => {
    let current: UseWeekInfiniteScrollResult | null = null

    function Harness(): React.JSX.Element {
      current = useWeekInfiniteScroll({
        initialDate: '2026-05-14',
        totalDays: 36_525
      })
      return <div data-testid="week-scroller" ref={current.scrollContainerRef} />
    }

    const { getByTestId } = render(<Harness />)
    const scroller = getByTestId('week-scroller') as HTMLDivElement

    // First real layout: 700 / 7 = 100px columns.
    defineReadonlyNumber(scroller, 'clientWidth', 700)
    act(() => {
      ResizeObserverMock.instances[0].trigger()
    })
    expect(current?.columnWidth).toBe(100)
    const pinnedScrollLeft = scroller.scrollLeft
    expect(pinnedScrollLeft).toBeGreaterThan(0)
    const pinnedDay = pinnedScrollLeft / 100

    // Window widened: 1050 / 7 = 150px columns. The same day must stay
    // pinned — scrollLeft is re-derived from the day position, not left at the
    // stale pixel offset (which would jump hundreds of days into the past/future).
    defineReadonlyNumber(scroller, 'clientWidth', 1050)
    act(() => {
      ResizeObserverMock.instances[0].trigger()
    })
    expect(current?.columnWidth).toBe(150)
    expect(scroller.scrollLeft).toBe(pinnedDay * 150)
  })

  it('fits exactly seven columns in the scroll container, leaving no partial eighth day', () => {
    let current: UseWeekInfiniteScrollResult | null = null

    function Harness(): React.JSX.Element {
      current = useWeekInfiniteScroll({ initialDate: '2026-05-14', totalDays: 90 })
      return <div data-testid="week-scroller" ref={current.scrollContainerRef} />
    }

    const { getByTestId } = render(<Harness />)
    const scroller = getByTestId('week-scroller') as HTMLDivElement

    // The hour gutter is a sibling of this element, so its width is already
    // excluded. Subtracting it a second time narrowed every column and left a
    // gutter-wide strip at the end of the week for a partial 8th day.
    defineReadonlyNumber(scroller, 'clientWidth', 1000)
    act(() => {
      ResizeObserverMock.instances[0].trigger()
    })

    expect(current?.columnWidth).toBeCloseTo(1000 / 7, 6)
    expect((current?.columnWidth ?? 0) * 7).toBeCloseTo(1000, 6)
  })
})
