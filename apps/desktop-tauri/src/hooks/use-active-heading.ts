/**
 * useActiveHeading Hook
 *
 * Tracks scroll position and determines which heading is currently active
 * based on which heading element is closest to the top of the viewport.
 *
 * T078: Simplified implementation - relies on BlockNote's data-id attributes
 * being enabled via setIdAttribute: true
 */

import { useState, useEffect, useCallback, useRef, type RefObject } from 'react'

interface HeadingItem {
  id: string
  level: number
  text: string
  position: number
}

interface UseActiveHeadingOptions {
  /** The headings to track */
  headings: HeadingItem[]
  /** Offset from the top of the viewport (in pixels) to consider "active" */
  offset?: number
  /** Throttle interval in ms for scroll events */
  throttleMs?: number
  /** Ref to the scroll container element */
  scrollContainerRef?: RefObject<HTMLElement | null>
}

interface UseActiveHeadingResult {
  /** The ID of the currently active heading */
  activeHeadingId: string | null
  /** Immediately set active heading (e.g. on outline click) — scroll tracking takes over after */
  setActiveHeading: (id: string) => void
}

/**
 * Determines the active heading based on scroll position.
 * Returns the heading that is at or just above the viewport top.
 */
export function useActiveHeading({
  headings,
  offset = 120,
  throttleMs = 50,
  scrollContainerRef
}: UseActiveHeadingOptions): UseActiveHeadingResult {
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null)
  const lastScrollTimeRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  const findActiveHeading = useCallback(() => {
    if (headings.length === 0) {
      setActiveHeadingId(null)
      return
    }

    const container = scrollContainerRef?.current

    // When scrolled to bottom, pick the last visible heading
    if (container) {
      const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 2
      if (atBottom) {
        for (let i = headings.length - 1; i >= 0; i--) {
          const el = document.querySelector(`[data-id="${headings[i].id}"]`)
          if (el) {
            const rect = el.getBoundingClientRect()
            if (rect.top < window.innerHeight && rect.bottom > 0) {
              setActiveHeadingId(headings[i].id)
              return
            }
          }
        }
      }
    }

    let activeId: string | null = null

    for (const heading of headings) {
      const element = document.querySelector(`[data-id="${heading.id}"]`)
      if (element) {
        const rect = element.getBoundingClientRect()
        if (rect.top <= offset) {
          activeId = heading.id
        } else {
          break
        }
      }
    }

    // If no heading is above threshold, use the first visible heading
    if (!activeId && headings.length > 0) {
      const firstElement = document.querySelector(`[data-id="${headings[0].id}"]`)
      if (firstElement) {
        const rect = firstElement.getBoundingClientRect()
        if (rect.top < window.innerHeight && rect.bottom > 0) {
          activeId = headings[0].id
        }
      }
    }

    setActiveHeadingId(activeId)
  }, [headings, offset, scrollContainerRef])

  const handleScroll = useCallback(() => {
    const now = Date.now()

    // Throttle scroll events
    if (now - lastScrollTimeRef.current < throttleMs) {
      // Schedule an update if not already scheduled
      if (!rafIdRef.current) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null
          findActiveHeading()
        })
      }
      return
    }

    lastScrollTimeRef.current = now
    findActiveHeading()
  }, [findActiveHeading, throttleMs])

  useEffect(() => {
    if (headings.length === 0) {
      setActiveHeadingId(null)
      return
    }

    // Initial calculation
    findActiveHeading()

    const target = scrollContainerRef?.current ?? window

    // Add scroll listener
    target.addEventListener('scroll', handleScroll, { passive: true })

    // Also listen to resize events as they may affect heading positions
    window.addEventListener('resize', handleScroll, { passive: true })

    return () => {
      target.removeEventListener('scroll', handleScroll)
      window.removeEventListener('resize', handleScroll)

      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [headings, handleScroll, findActiveHeading])

  const setActiveHeading = useCallback((id: string) => {
    setActiveHeadingId(id)
  }, [])

  return {
    activeHeadingId,
    setActiveHeading
  }
}

export type { HeadingItem, UseActiveHeadingOptions, UseActiveHeadingResult }
