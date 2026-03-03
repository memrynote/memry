/**
 * useJournalScroll Hook
 * Manages scroll-based active day detection and infinite loading for journal
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  type DayData,
  generateDateRange,
  generateMorePastDays,
  generateMoreFutureDays,
  getTodayString,
  getDateDistance,
  getOpacityForDistance
} from '@/lib/journal-utils'

// =============================================================================
// TYPES
// =============================================================================

export interface JournalScrollState {
  /** All loaded days */
  days: DayData[]
  /** Currently active date (ISO string) */
  activeDate: string
  /** Today's date (ISO string) */
  today: string
  /** Loading state for past days */
  isLoadingPast: boolean
  /** Loading state for future days */
  isLoadingFuture: boolean
}

export interface UseJournalScrollResult {
  /** Current state */
  state: JournalScrollState
  /** Ref to attach to scroll container */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Map of date -> ref for each day card */
  dayCardRefs: Map<string, HTMLDivElement>
  /** Register a day card ref */
  registerDayCardRef: (date: string, element: HTMLDivElement | null) => void
  /** Get opacity for a specific date based on distance from active */
  getOpacity: (date: string) => number
  /** Scroll to a specific date */
  scrollToDate: (date: string, smooth?: boolean) => void
  /** Scroll to today */
  scrollToToday: (smooth?: boolean) => void
  /** Load more past days */
  loadMorePast: () => void
  /** Load more future days */
  loadMoreFuture: () => void
}

// =============================================================================
// CONSTANTS
// =============================================================================

const INITIAL_PAST_DAYS = 14
const INITIAL_FUTURE_DAYS = 7
const LOAD_MORE_COUNT = 14
const EDGE_THRESHOLD_PX = 500

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useJournalScroll(): UseJournalScrollResult {
  const today = useMemo(() => getTodayString(), [])

  // State
  const [days, setDays] = useState<DayData[]>(() =>
    generateDateRange(new Date(), INITIAL_PAST_DAYS, INITIAL_FUTURE_DAYS)
  )
  const [activeDate, setActiveDate] = useState<string>(today)
  const [isLoadingPast, setIsLoadingPast] = useState(false)
  const [isLoadingFuture, setIsLoadingFuture] = useState(false)
  const [hasScrolledToToday, setHasScrolledToToday] = useState(false)

  // Refs
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const dayCardRefsMap = useRef<Map<string, HTMLDivElement>>(new Map())
  const isScrollingProgrammatically = useRef(false)

  // Register day card ref
  const registerDayCardRef = useCallback((date: string, element: HTMLDivElement | null) => {
    if (element) {
      dayCardRefsMap.current.set(date, element)
    } else {
      dayCardRefsMap.current.delete(date)
    }
  }, [])

  // Get opacity for a date
  const getOpacity = useCallback(
    (date: string): number => {
      const distance = getDateDistance(date, activeDate)
      return getOpacityForDistance(distance)
    },
    [activeDate]
  )

  // Scroll to a specific date
  const scrollToDate = useCallback((date: string, smooth: boolean = true) => {
    const container = scrollContainerRef.current
    const card = dayCardRefsMap.current.get(date)

    if (!container || !card) return

    isScrollingProgrammatically.current = true

    const containerRect = container.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()

    // Calculate scroll position to center the card
    const containerCenter = containerRect.height / 2
    const cardCenter = cardRect.top - containerRect.top + cardRect.height / 2
    const scrollOffset = cardCenter - containerCenter

    container.scrollBy({
      top: scrollOffset,
      behavior: smooth ? 'smooth' : 'instant'
    })

    // Reset programmatic scroll flag after animation
    setTimeout(
      () => {
        isScrollingProgrammatically.current = false
        setActiveDate(date)
      },
      smooth ? 400 : 0
    )
  }, [])

  // Scroll to today
  const scrollToToday = useCallback(
    (smooth: boolean = true) => {
      scrollToDate(today, smooth)
    },
    [today, scrollToDate]
  )

  // Load more past days
  const loadMorePast = useCallback(() => {
    if (isLoadingPast || days.length === 0) return

    setIsLoadingPast(true)

    // Simulate async loading (in real app, might fetch data)
    setTimeout(() => {
      const oldestDate = days[0].date
      const newDays = generateMorePastDays(oldestDate, LOAD_MORE_COUNT)

      // Save current scroll position
      const container = scrollContainerRef.current
      const scrollHeightBefore = container?.scrollHeight || 0

      setDays((prev) => [...newDays, ...prev])

      // Restore scroll position after new content is added
      requestAnimationFrame(() => {
        if (container) {
          const scrollHeightAfter = container.scrollHeight
          const heightDiff = scrollHeightAfter - scrollHeightBefore
          container.scrollTop += heightDiff
        }
        setIsLoadingPast(false)
      })
    }, 100)
  }, [isLoadingPast, days])

  // Load more future days
  const loadMoreFuture = useCallback(() => {
    if (isLoadingFuture || days.length === 0) return

    setIsLoadingFuture(true)

    setTimeout(() => {
      const newestDate = days[days.length - 1].date
      const newDays = generateMoreFutureDays(newestDate, LOAD_MORE_COUNT)

      setDays((prev) => [...prev, ...newDays])
      setIsLoadingFuture(false)
    }, 100)
  }, [isLoadingFuture, days])

  // Find active day based on scroll position
  const updateActiveDay = useCallback(() => {
    if (isScrollingProgrammatically.current) return

    const container = scrollContainerRef.current
    if (!container) return

    const containerRect = container.getBoundingClientRect()
    const viewportCenter = containerRect.top + containerRect.height / 2

    let closestDate: string | null = null
    let closestDistance = Infinity

    dayCardRefsMap.current.forEach((card, date) => {
      const cardRect = card.getBoundingClientRect()
      const cardCenter = cardRect.top + cardRect.height / 2
      const distance = Math.abs(cardCenter - viewportCenter)

      if (distance < closestDistance) {
        closestDistance = distance
        closestDate = date
      }
    })

    if (closestDate && closestDate !== activeDate) {
      setActiveDate(closestDate)
    }
  }, [activeDate])

  // Handle scroll event
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    // Update active day
    updateActiveDay()

    // Check for infinite loading
    const { scrollTop, scrollHeight, clientHeight } = container

    // Near top - load more past
    if (scrollTop < EDGE_THRESHOLD_PX) {
      loadMorePast()
    }

    // Near bottom - load more future
    if (scrollHeight - scrollTop - clientHeight < EDGE_THRESHOLD_PX) {
      loadMoreFuture()
    }
  }, [updateActiveDay, loadMorePast, loadMoreFuture])

  // Attach scroll listener with requestAnimationFrame throttling
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    let rafId: number | null = null

    const throttledScroll = () => {
      if (rafId) return
      rafId = requestAnimationFrame(() => {
        handleScroll()
        rafId = null
      })
    }

    container.addEventListener('scroll', throttledScroll, { passive: true })

    return () => {
      container.removeEventListener('scroll', throttledScroll)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [handleScroll])

  // Initial scroll to today (after cards are rendered)
  useEffect(() => {
    if (hasScrolledToToday) return

    let cancelled = false
    let initialScrollTimer: ReturnType<typeof setTimeout> | null = null

    // Wait for day cards to be registered
    const checkAndScroll = () => {
      if (cancelled) return

      if (dayCardRefsMap.current.has(today)) {
        scrollToDate(today, false) // Instant scroll on initial load
        setHasScrolledToToday(true)
      } else {
        // Retry after a short delay
        initialScrollTimer = setTimeout(checkAndScroll, 50)
      }
    }

    checkAndScroll()

    return () => {
      cancelled = true
      if (initialScrollTimer) {
        clearTimeout(initialScrollTimer)
      }
    }
  }, [today, scrollToDate, hasScrolledToToday])

  // Memoize the state object
  const state = useMemo<JournalScrollState>(
    () => ({
      days,
      activeDate,
      today,
      isLoadingPast,
      isLoadingFuture
    }),
    [days, activeDate, today, isLoadingPast, isLoadingFuture]
  )

  return {
    state,
    scrollContainerRef,
    dayCardRefs: dayCardRefsMap.current,
    registerDayCardRef,
    getOpacity,
    scrollToDate,
    scrollToToday,
    loadMorePast,
    loadMoreFuture
  }
}

export default useJournalScroll
