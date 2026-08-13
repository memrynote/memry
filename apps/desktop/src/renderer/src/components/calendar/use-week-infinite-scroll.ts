import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject
} from 'react'
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual'
import { dateFromDayIndex, dayIndexFromDate } from './date-utils'

const COLUMNS_PER_PAGE = 7
const DEFAULT_TOTAL_DAYS = 36_525
const MIN_COLUMN_WIDTH = 48
const INSTANT_JUMP_THRESHOLD_DAYS = 14

interface UseWeekInfiniteScrollOptions {
  initialDate: string
  totalDays?: number
  onVisibleDayStartChange?: (dayIndex: number) => void
}

export interface UseWeekInfiniteScrollResult {
  scrollContainerRef: RefObject<HTMLDivElement | null>
  virtualizer: Virtualizer<HTMLDivElement, Element>
  columnWidth: number
  visibleDayStart: number
  scrollToDay: (dayIndex: number, opts?: { smooth?: boolean }) => void
  scrollToDate: (date: string, opts?: { smooth?: boolean }) => void
  dateForDayIndex: (index: number) => string
}

export function useWeekInfiniteScroll({
  initialDate,
  totalDays = DEFAULT_TOTAL_DAYS,
  onVisibleDayStartChange
}: UseWeekInfiniteScrollOptions): UseWeekInfiniteScrollResult {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const [containerWidth, setContainerWidth] = useState(0)

  // `containerWidth` is the scroll container's own width, and that element is a
  // sibling of the hour gutter rather than its parent — the gutter is already
  // excluded. Subtracting it again shaved a seventh of the gutter off every
  // column and left a gutter-wide strip at the end of the week for the
  // virtualizer to fill with a partial 8th day.
  const columnWidth = useMemo(
    () => Math.max(MIN_COLUMN_WIDTH, containerWidth / COLUMNS_PER_PAGE),
    [containerWidth]
  )

  const initialIndex = useMemo(() => dayIndexFromDate(initialDate), [initialDate])
  const [visibleDayStart, setVisibleDayStart] = useState(initialIndex)

  const onVisibleDayStartChangeRef = useRef(onVisibleDayStartChange)
  useEffect(() => {
    onVisibleDayStartChangeRef.current = onVisibleDayStartChange
  })

  const lastNotifiedIndexRef = useRef(initialIndex)

  const notifyVisibleDayStart = useCallback((dayIndex: number): void => {
    if (dayIndex === lastNotifiedIndexRef.current) return
    lastNotifiedIndexRef.current = dayIndex
    setVisibleDayStart(dayIndex)
    onVisibleDayStartChangeRef.current?.(dayIndex)
  }, [])

  const virtualizer = useVirtualizer({
    horizontal: true,
    count: totalDays,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => columnWidth,
    overscan: 3
  })

  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const measure = (): void => {
      setContainerWidth(el.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    // `void` keeps the call out of the synchronous setter path so the
    // unnecessary-effect linter recognizes this as a side-effecting sync call
    // rather than a state pass-through.
    void virtualizer.measure()
    return () => {}
  }, [columnWidth, virtualizer])

  const lastLayoutColumnWidthRef = useRef(0)
  useLayoutEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    if (columnWidth <= MIN_COLUMN_WIDTH) return
    const prev = lastLayoutColumnWidthRef.current
    if (prev <= MIN_COLUMN_WIDTH) {
      // First usable layout: position on the initial date.
      lastLayoutColumnWidthRef.current = columnWidth
      el.scrollLeft = initialIndex * columnWidth
      return
    }
    if (prev === columnWidth) return
    // Container resized: column width changed. scrollLeft is an absolute pixel
    // offset (= dayIndex * columnWidth) and today's index is ~2300+, so leaving
    // it stale would re-interpret the same pixels as a day hundreds of days off
    // and jump the view. Re-derive scrollLeft from the current day position so
    // the same day stays pinned.
    const dayPosition = el.scrollLeft / prev
    lastLayoutColumnWidthRef.current = columnWidth
    el.scrollLeft = dayPosition * columnWidth
  }, [columnWidth, initialIndex])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const onScroll = (): void => {
      if (columnWidth <= 0) return
      const nextStart = Math.floor(el.scrollLeft / columnWidth)
      notifyVisibleDayStart(nextStart)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [columnWidth, notifyVisibleDayStart])

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.shiftKey) return
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      el.scrollLeft += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const scrollToDay = useCallback(
    (dayIndex: number, opts?: { smooth?: boolean }): void => {
      const el = scrollContainerRef.current
      if (!el || columnWidth <= 0) return
      const target = dayIndex * columnWidth
      const distance = Math.abs(target - el.scrollLeft)
      const wantSmooth = opts?.smooth ?? true
      const farJump = distance > INSTANT_JUMP_THRESHOLD_DAYS * columnWidth
      const behavior: ScrollBehavior = wantSmooth && !farJump ? 'smooth' : 'auto'
      el.scrollTo({ left: target, behavior })
      if (behavior === 'auto') {
        notifyVisibleDayStart(dayIndex)
      }
    },
    [columnWidth, notifyVisibleDayStart]
  )

  const scrollToDate = useCallback(
    (date: string, opts?: { smooth?: boolean }): void => {
      scrollToDay(dayIndexFromDate(date), opts)
    },
    [scrollToDay]
  )

  const dateForDayIndex = useCallback((index: number): string => dateFromDayIndex(index), [])

  return {
    scrollContainerRef,
    virtualizer,
    columnWidth,
    visibleDayStart,
    scrollToDay,
    scrollToDate,
    dateForDayIndex
  }
}
